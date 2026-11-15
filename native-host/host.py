"""Chrome native messaging host: lets the extension start and stop the local server.

Chrome runs this with the stdio protocol (4-byte little-endian length + UTF-8 JSON), one
message per launch. Only the standard library is used, so it works before the venv exists.
"""
import csv
import datetime
import io
import json
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server"
VENV_PY = SERVER / ".venv" / "Scripts" / "python.exe"
BAT = ROOT / "start-server.bat"
SERVER_LOG = SERVER / "server.log"
PID_FILE = SERVER / "server.pid"  # written by app.py
LOG = Path(__file__).resolve().parent / "host.log"
HOST, PORT = "127.0.0.1", 8765

CREATE_NO_WINDOW = 0x08000000


def log(text: str) -> None:
    try:
        with LOG.open("a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {text}\n")
    except OSError:
        pass


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw)
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def send(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def port_open() -> bool:
    try:
        with socket.create_connection((HOST, PORT), timeout=0.5):
            return True
    except OSError:
        return False


def spawn_detached(command_line: str, cwd: Path, show: bool) -> int:
    """Start a process through WMI so it is not a member of Chrome's job object.

    Chrome runs native hosts inside a job that is killed when the host is cleaned up and that
    may forbid CREATE_BREAKAWAY_FROM_JOB, so a plain child process would die with it. A process
    created by the WMI service has no such parent job.
    """
    ps = (
        "$ErrorActionPreference = 'Stop'; "
        f"$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{{ ShowWindow = [uint16]{1 if show else 0} }}; "
        "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ "
        f"CommandLine = '{command_line.replace(chr(39), chr(39) * 2)}'; "
        f"CurrentDirectory = '{str(cwd).replace(chr(39), chr(39) * 2)}'; "
        "ProcessStartupInformation = $si }; "
        "Write-Output \"$($r.ReturnValue) $($r.ProcessId)\""
    )
    out = run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps]).split()
    if len(out) != 2 or out[0] != "0":
        raise RuntimeError(f"WMI 建立程序失敗（{' '.join(out) or '無回應'}）")
    return int(out[1])


def start_server() -> dict:
    if port_open():
        return {"ok": True, "status": "running"}
    if not VENV_PY.exists():
        # First run: let start-server.bat create the venv in a window so the install is visible.
        if not BAT.exists():
            return {"ok": False, "error": f"找不到 {BAT}"}
        spawn_detached(f'cmd.exe /c "{BAT}"', ROOT, show=True)
        return {"ok": True, "status": "installing"}
    # Normal case: run the server in the background with a hidden console; app.py logs to a file.
    with open(SERVER_LOG, "a", encoding="utf-8") as f:
        f.write(f"\n===== {datetime.datetime.now():%Y-%m-%d %H:%M:%S} started from the extension =====\n")
    pid = spawn_detached(f'"{VENV_PY}" app.py --log "{SERVER_LOG}"', SERVER, show=False)
    log(f"spawned server launcher pid={pid}")
    return {"ok": True, "status": "starting"}


def run(cmd) -> str:
    return subprocess.run(cmd, capture_output=True, creationflags=CREATE_NO_WINDOW).stdout.decode("mbcs", "replace")


def server_pids() -> set[int]:
    """PID written by app.py, plus whoever owns the port (covers servers started without it)."""
    pids = set()
    try:
        pids.add(int(PID_FILE.read_text().strip()))
    except (OSError, ValueError):
        pass
    # netstat output and the State column are unreliable on some setups. Any socket whose *local*
    # port is ours belongs to the server side, so no state filter is needed.
    out = run(["powershell", "-NoProfile", "-Command",
               f"Get-NetTCPConnection -LocalPort {PORT} -ErrorAction SilentlyContinue | "
               "Select-Object -ExpandProperty OwningProcess"])
    pids.update(int(x) for x in out.split() if x.isdigit() and int(x) > 0)
    return pids


def image_name(pid: int) -> str:
    rows = list(csv.reader(io.StringIO(run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"]))))
    return rows[0][0].lower() if rows and rows[0] and rows[0][0].lower().endswith(".exe") else ""


def stop_server() -> dict:
    killed = 0
    for pid in server_pids():
        name = image_name(pid)
        if not name:
            continue  # stale PID file
        if not name.startswith("python"):
            return {"ok": False, "error": f"port {PORT} 被其他程式佔用（{name}），不是本機翻譯伺服器"}
        run(["taskkill", "/PID", str(pid), "/T", "/F"])
        killed += 1
    PID_FILE.unlink(missing_ok=True)
    if not killed and not port_open():
        return {"ok": True, "status": "stopped"}
    # A window opened by start-server.bat would be left at "pause": close it too.
    run(["powershell", "-NoProfile", "-Command",
         "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | "
         "Where-Object { $_.CommandLine -like '*manga-translator*start-server.bat*' } | "
         "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"])
    for _ in range(20):
        if not port_open():
            return {"ok": True, "status": "stopped"}
        time.sleep(0.25)
    return {"ok": False, "error": "已送出關閉指令，但伺服器仍在回應"}


def unload_ollama(base: str | None) -> list[str]:
    """Ask Ollama to drop every loaded model now (it keeps them for 5 minutes by default).

    Done here rather than in the extension because Ollama rejects POSTs whose Origin is
    chrome-extension://. Returns only the models that are really gone afterwards.
    """
    import urllib.request

    if not base or not base.startswith(("http://", "https://")):
        return []
    base = base.rstrip("/")

    def loaded() -> list[str]:
        with urllib.request.urlopen(base + "/api/ps", timeout=3) as r:
            return [m["name"] for m in json.load(r).get("models", [])]

    try:
        names = loaded()
        for name in names:
            req = urllib.request.Request(
                base + "/api/generate",
                data=json.dumps({"model": name, "keep_alive": 0}).encode(),
                headers={"Content-Type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=15).read()
        still = set(loaded())
        return [n for n in names if n not in still]
    except Exception as e:  # noqa: BLE001 - Ollama not running or refused: nothing to report
        log(f"ollama unload failed: {e!r}")
        return []


def main():
    msg = read_message() or {}
    action = msg.get("action")
    log(f"action={action}")
    try:
        if action == "start":
            send(start_server())
        elif action == "stop":
            result = stop_server()
            result["unloaded"] = unload_ollama(msg.get("ollama_url"))
            send(result)
        elif action == "ping":
            send({"ok": True, "status": "running" if port_open() else "stopped"})
        else:
            send({"ok": False, "error": f"未知的指令: {action}"})
    except Exception as e:  # noqa: BLE001 - always answer so the extension is not left waiting
        log(f"error={e!r}")
        send({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
