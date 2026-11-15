@echo off
chcp 65001 >nul
cd /d "%~dp0server"
if not exist ".venv\Scripts\python.exe" (
  echo [setup] creating venv...
  python -m venv .venv
  .venv\Scripts\python.exe -m pip install -r requirements.txt
)
.venv\Scripts\python.exe app.py
pause
