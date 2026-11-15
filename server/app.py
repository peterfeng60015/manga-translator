"""Local manga translation server: image in, translated text blocks out.

Run:  .venv\\Scripts\\python.exe app.py      (listens on http://127.0.0.1:8765)
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
from collections import OrderedDict

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from PIL import Image
from pydantic import BaseModel

import pipeline
import translators

HOST, PORT = "127.0.0.1", 8765
MAX_SIDE = 12000

# No CORS headers on purpose: web pages cannot call this server, only the extension
# (which holds host permissions) and local tools can.
app = FastAPI(title="manga-translator local server")

_models: dict[str, object] = {}
_cache: OrderedDict[str, dict] = OrderedDict()
CACHE_MAX = 300


def detector() -> pipeline.Detector:
    if "det" not in _models:
        _models["det"] = pipeline.Detector()
    return _models["det"]


def manga_ocr() -> pipeline.MangaOcr:
    if "mocr" not in _models:
        _models["mocr"] = pipeline.MangaOcr()
    return _models["mocr"]


def general_ocr() -> pipeline.GeneralOcr:
    if "gocr" not in _models:
        _models["gocr"] = pipeline.GeneralOcr()
    return _models["gocr"]


class TranslateRequest(BaseModel):
    image: str | None = None        # base64 (optionally a data: URL)
    url: str | None = None          # or let the server download it
    referer: str | None = None
    source_lang: str = "ja"         # ja | zh | ko | en
    target_lang: str = "zh-TW"
    engine: str = "google"          # google | ollama
    ollama_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen2.5:7b"


async def load_image(req: TranslateRequest) -> bytes:
    if req.image:
        data = req.image.split(",", 1)[1] if req.image.startswith("data:") else req.image
        try:
            return base64.b64decode(data)
        except Exception as e:
            raise HTTPException(400, f"image 不是有效的 base64: {e}")
    if req.url and req.url.startswith(("http://", "https://")):
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36"}
        if req.referer:
            headers["Referer"] = req.referer
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=True, headers=headers) as c:
                r = await c.get(req.url)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"下載圖片失敗: {e}")
        if r.status_code != 200:
            raise HTTPException(502, f"下載圖片失敗: HTTP {r.status_code}")
        return r.content
    raise HTTPException(400, "需要 image 或 url")


def analyse(raw: bytes, src: str) -> dict:
    """Blocking part: decode, detect, OCR. Runs in a worker thread."""
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception as e:
        raise HTTPException(400, f"無法解析圖片: {e}")
    if getattr(img, "is_animated", False):
        img.seek(0)
    img = img.convert("RGB")
    w, h = img.size
    if max(w, h) > MAX_SIDE * 3 or min(w, h) < 32:
        raise HTTPException(400, f"圖片尺寸不支援: {w}x{h}")

    texts, bubbles = detector().detect(img)
    blocks = []
    for lab, box, score in texts:
        pad = 2
        crop = img.crop((max(0, box[0] - pad), max(0, box[1] - pad), min(w, box[2] + pad), min(h, box[3] + pad)))
        text = manga_ocr()(crop) if src == "ja" else general_ocr()(crop, src)
        if not text:
            continue
        bg, fg = pipeline.colours(img, box)
        blocks.append({
            "box": [round(v, 1) for v in box],
            "area": [round(v, 1) for v in pipeline.typeset_area(box, bubbles)],
            "kind": "bubble" if lab == pipeline.LABEL_TEXT_BUBBLE else "free",
            "score": round(score, 3),
            "text": text,
            "bg": bg,
            "fg": fg,
        })
    return {"width": w, "height": h, "blocks": pipeline.reading_order(blocks, rtl=src == "ja")}


@app.post("/translate")
async def translate(req: TranslateRequest):
    """Streams whitespace while working, then the JSON body.

    Chrome kills an extension service worker whose fetch gets no response for 30 s, and a cold
    Ollama model load can take longer than that. Failures therefore arrive as
    {"error": ..., "status": ...} inside a 200 response.
    """
    task = asyncio.create_task(_translate(req))

    async def body():
        try:
            while True:
                done, _ = await asyncio.wait({task}, timeout=5)
                if done:
                    break
                yield b" "
            try:
                yield json.dumps(task.result(), ensure_ascii=False).encode()
            except HTTPException as e:
                yield json.dumps({"error": str(e.detail), "status": e.status_code}, ensure_ascii=False).encode()
            except Exception as e:  # noqa: BLE001 - report instead of dropping the connection
                yield json.dumps({"error": f"伺服器內部錯誤: {e}", "status": 500}, ensure_ascii=False).encode()
        finally:
            task.cancel()

    return StreamingResponse(body(), media_type="application/json")


async def _translate(req: TranslateRequest) -> dict:
    if req.source_lang not in ("ja", "zh", "ko", "en"):
        raise HTTPException(400, f"不支援的來源語言: {req.source_lang}")
    if req.engine not in ("google", "ollama"):
        raise HTTPException(400, f"不支援的翻譯引擎: {req.engine}")
    raw = await load_image(req)
    digest = hashlib.sha1(raw).hexdigest()
    ocr_key = f"ocr:{digest}:{req.source_lang}"
    tr_key = f"tr:{digest}:{req.source_lang}:{req.target_lang}:{req.engine}:" + (req.ollama_model if req.engine == "ollama" else "")
    if tr_key in _cache and req.image:
        _cache.move_to_end(tr_key)
        return {**_cache[tr_key], "cached": True}

    result = _cache.get(ocr_key)
    if result is None:
        result = await asyncio.to_thread(analyse, raw, req.source_lang)
        _remember(ocr_key, result)

    texts = [b["text"] for b in result["blocks"]]
    try:
        if not texts:
            out = []
        elif req.engine == "ollama":
            out = await translators.ollama(texts, req.source_lang, req.target_lang, req.ollama_url, req.ollama_model)
        else:
            out = await translators.google(texts, req.source_lang, req.target_lang)
    except translators.TranslateError as e:
        raise HTTPException(502, str(e))

    final = {**result, "blocks": [{**b, "translation": t} for b, t in zip(result["blocks"], out)]}
    _remember(tr_key, final)
    extra = {}
    if not req.image:
        # The server fetched the picture itself; hand it back so the extension can redraw it.
        mime = Image.MIME.get(Image.open(io.BytesIO(raw)).format or "", "image/png")
        extra["image"] = f"data:{mime};base64," + base64.b64encode(raw).decode()
    return {**final, **extra, "cached": False}


def _remember(key: str, value: dict) -> None:
    _cache[key] = value
    while len(_cache) > CACHE_MAX:
        _cache.popitem(last=False)


@app.get("/health")
async def health(ollama_url: str = "http://127.0.0.1:11434"):
    return {
        "ok": True,
        "gpu": "DmlExecutionProvider" in __import__("onnxruntime").get_available_providers(),
        "loaded": sorted(_models),
        "ollama": await translators.ollama_status(ollama_url),
    }


if __name__ == "__main__":
    print(f"manga-translator server  http://{HOST}:{PORT}   (Ctrl+C 結束)")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
