"""Translation engines: Google (free web endpoint) and Ollama (local LLM)."""
from __future__ import annotations

import asyncio
import json
import re

import httpx

LANG_NAMES = {
    "ja": "Japanese", "zh": "Chinese", "ko": "Korean", "en": "English",
    "zh-TW": "Traditional Chinese (Taiwan)", "zh-CN": "Simplified Chinese",
    "es": "Spanish", "fr": "French", "de": "German", "id": "Indonesian", "it": "Italian",
    "ms": "Malay", "pl": "Polish", "pt": "Portuguese", "ru": "Russian", "th": "Thai",
    "tr": "Turkish", "vi": "Vietnamese", "ar": "Arabic",
}
GOOGLE_SRC = {"zh": "zh-CN"}


class TranslateError(Exception):
    pass


async def google(texts: list[str], src: str, tgt: str) -> list[str]:
    sem = asyncio.Semaphore(3)
    sl = GOOGLE_SRC.get(src, src)

    async def one(client: httpx.AsyncClient, text: str) -> str:
        if not text.strip():
            return ""
        async with sem:
            # Primary: the endpoint Chrome's own dictionary extension uses.
            r = await client.get(
                "https://clients5.google.com/translate_a/t",
                params={"client": "dict-chrome-ex", "sl": sl, "tl": tgt, "q": text},
            )
            if r.status_code == 200:
                data = r.json()
                first = data[0] if isinstance(data, list) and data else ""
                return first[0] if isinstance(first, list) else str(first)
            # Fallback: the older gtx endpoint (often rate limited per IP).
            r2 = await client.get(
                "https://translate.googleapis.com/translate_a/single",
                params={"client": "gtx", "sl": sl, "tl": tgt, "dt": "t", "q": text},
            )
        if r2.status_code != 200:
            raise TranslateError(
                f"Google 翻譯拒絕請求（HTTP {r.status_code} / {r2.status_code}），可能是請求太頻繁，稍後再試或改用 Ollama"
            )
        return "".join(seg[0] for seg in r2.json()[0] if seg and seg[0])

    ua = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
    try:
        async with httpx.AsyncClient(timeout=20, headers=ua) as client:
            return list(await asyncio.gather(*(one(client, t) for t in texts)))
    except httpx.HTTPError as e:
        raise TranslateError(f"連不上 Google 翻譯: {e}") from e


async def ollama(texts: list[str], src: str, tgt: str, url: str, model: str) -> list[str]:
    idx = [i for i, t in enumerate(texts) if t.strip()]
    if not idx:
        return [""] * len(texts)
    system = (
        f"You are a professional manga translator. Translate each {LANG_NAMES.get(src, src)} line of comic "
        f"dialogue into natural, colloquial {LANG_NAMES.get(tgt, tgt)}. The lines are from one page in reading "
        "order, so use the surrounding lines as context and keep names and tone consistent. The text comes "
        "from OCR and may contain small recognition errors; infer the intended meaning. "
        'Reply with JSON only: {"translations": ["...", ...]} holding exactly one translation per input line, '
        "in the same order. No notes, no romanisation, no original text."
    )
    if tgt == "zh-TW":
        system += " Write in Traditional Chinese characters (繁體字) with Taiwan wording; never use Simplified characters."
    user = json.dumps({"lines": [texts[i] for i in idx]}, ensure_ascii=False)
    body = {
        "model": model,
        "stream": False,
        "think": False,
        "format": {
            "type": "object",
            "properties": {"translations": {"type": "array", "items": {"type": "string"}}},
            "required": ["translations"],
        },
        "options": {"temperature": 0.2},
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }
    try:
        async with httpx.AsyncClient(timeout=180) as client:
            r = await client.post(url.rstrip("/") + "/api/chat", json=body)
            if r.status_code == 400 and "think" in r.text:
                body.pop("think")  # model without a thinking switch
                r = await client.post(url.rstrip("/") + "/api/chat", json=body)
    except httpx.HTTPError as e:
        raise TranslateError(f"連不上 Ollama（{url}），請確認 Ollama 已啟動: {e}") from e
    if r.status_code == 404:
        raise TranslateError(f"Ollama 沒有模型「{model}」，請先執行 ollama pull {model}")
    if r.status_code != 200:
        raise TranslateError(f"Ollama 回應 HTTP {r.status_code}: {r.text[:200]}")
    content = r.json().get("message", {}).get("content", "")
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()
    try:
        out = json.loads(content)["translations"]
    except Exception as e:
        raise TranslateError(f"Ollama 回傳的不是預期的 JSON: {content[:200]}") from e
    if len(out) != len(idx):
        raise TranslateError(f"Ollama 回傳 {len(out)} 句，但送出 {len(idx)} 句")
    result = [""] * len(texts)
    for i, t in zip(idx, out):
        result[i] = _to_traditional(str(t).strip()) if tgt == "zh-TW" else str(t).strip()
    return result


_s2tw = None


def _to_traditional(text: str) -> str:
    """Local models slip into Simplified characters now and then; convert as a safety net."""
    global _s2tw
    try:
        if _s2tw is None:
            from opencc import OpenCC

            _s2tw = OpenCC("s2tw")
        return _s2tw.convert(text)
    except Exception:
        return text


async def ollama_status(url: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(url.rstrip("/") + "/api/tags")
        return {"running": True, "models": [m["name"] for m in r.json().get("models", [])]}
    except Exception:
        return {"running": False, "models": []}
