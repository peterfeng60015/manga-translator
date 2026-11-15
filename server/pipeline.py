"""Text detection + OCR, all on onnxruntime (DirectML GPU when available)."""
from __future__ import annotations

import threading
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

MODELS = Path(__file__).parent / "models"
DET_SIZE = 640
LABEL_BUBBLE, LABEL_TEXT_BUBBLE, LABEL_TEXT_FREE = 0, 1, 2

_lock = threading.Lock()  # DirectML sessions are not safe for concurrent run()


def _session(path: Path, gpu: bool = True) -> ort.InferenceSession:
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    providers = ["CPUExecutionProvider"]
    if gpu and "DmlExecutionProvider" in ort.get_available_providers():
        # DirectML requires these two settings.
        opts.enable_mem_pattern = False
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        providers.insert(0, "DmlExecutionProvider")
    try:
        return ort.InferenceSession(str(path), opts, providers=providers)
    except Exception:
        if not gpu:
            raise
        return _session(path, gpu=False)


def _iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def _overlap_of(a, b) -> float:
    """Fraction of box a that lies inside box b."""
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    area = (a[2] - a[0]) * (a[3] - a[1])
    return ix * iy / area if area > 0 else 0.0


class Detector:
    """RT-DETR-v2 comic text / bubble detector."""

    def __init__(self) -> None:
        self.sess = _session(MODELS / "detector.onnx")
        self.gpu = self.sess.get_providers()[0] != "CPUExecutionProvider"

    def _run(self, img: Image.Image, thresh: float):
        w, h = img.size
        arr = np.asarray(img.resize((DET_SIZE, DET_SIZE), Image.BILINEAR), dtype=np.float32) / 255.0
        feed = {
            "images": arr.transpose(2, 0, 1)[None],
            "orig_target_sizes": np.array([[w, h]], dtype=np.int64),
        }
        with _lock:
            try:
                labels, boxes, scores = self.sess.run(None, feed)
            except Exception:
                if not self.gpu:
                    raise
                # Some DirectML drivers choke on this graph: fall back to CPU for good.
                self.sess = _session(MODELS / "detector.onnx", gpu=False)
                self.gpu = False
                labels, boxes, scores = self.sess.run(None, feed)
        out = []
        for lab, box, sc in zip(labels[0], boxes[0], scores[0]):
            if sc < thresh:
                continue
            x1, y1, x2, y2 = (float(v) for v in box)
            x1, y1 = max(0.0, x1), max(0.0, y1)
            x2, y2 = min(float(w), x2), min(float(h), y2)
            if x2 - x1 < 4 or y2 - y1 < 4:
                continue
            out.append((int(lab), [x1, y1, x2, y2], float(sc)))
        return out

    def detect(self, img: Image.Image, thresh: float = 0.35):
        """Returns (text_boxes, bubble_boxes); text boxes are (label, box, score)."""
        w, h = img.size
        dets = []
        if h > w * 2.2:
            # Tall webtoon strip: detect on overlapping tiles so text stays legible at 640px.
            tile = int(w * 1.4)
            step = int(tile * 0.75)
            y = 0
            while True:
                y2 = min(h, y + tile)
                for lab, b, sc in self._run(img.crop((0, y, w, y2)), thresh):
                    # Drop boxes cut by an inner tile edge; the neighbouring tile has them whole.
                    if (y > 0 and b[1] < 3) or (y2 < h and b[3] > (y2 - y) - 3):
                        continue
                    dets.append((lab, [b[0], b[1] + y, b[2], b[3] + y], sc))
                if y2 >= h:
                    break
                y += step
        else:
            dets = self._run(img, thresh)

        dets.sort(key=lambda d: -d[2])
        texts, bubbles = [], []
        for lab, box, sc in dets:
            pool = bubbles if lab == LABEL_BUBBLE else texts
            if any(_iou(box, other[1]) > 0.5 or _overlap_of(box, other[1]) > 0.8 for other in pool):
                continue
            pool.append((lab, box, sc))
        return texts, [b[1] for b in bubbles]


class MangaOcr:
    """manga-ocr (ViT encoder + BERT decoder), greedy decoding, Japanese only."""

    START, END, MAX_LEN = 2, 3, 128

    def __init__(self) -> None:
        d = MODELS / "manga-ocr"
        self.enc = _session(d / "encoder_model.onnx")
        self.dec = _session(d / "decoder_model.onnx")
        self.vocab = (d / "vocab.txt").read_text(encoding="utf-8").split("\n")

    def __call__(self, img: Image.Image) -> str:
        g = img.convert("L").convert("RGB").resize((224, 224), Image.BILINEAR)
        px = (np.asarray(g, dtype=np.float32) / 255.0 - 0.5) / 0.5
        with _lock:
            hidden = self.enc.run(None, {"pixel_values": px.transpose(2, 0, 1)[None]})[0]
            ids = [self.START]
            for _ in range(self.MAX_LEN):
                logits = self.dec.run(
                    None,
                    {"input_ids": np.array([ids], dtype=np.int64), "encoder_hidden_states": hidden},
                )[0]
                nxt = int(logits[0, -1].argmax())
                if nxt == self.END:
                    break
                ids.append(nxt)
        toks = [self.vocab[i] for i in ids[1:] if i < len(self.vocab)]
        text = "".join(t[2:] if t.startswith("##") else t for t in toks if not (t.startswith("[") and t.endswith("]")))
        return text.replace(" ", "").replace("…", "...").strip()


class GeneralOcr:
    """PP-OCR via RapidOCR for Chinese / Korean / English crops."""

    LANGS = {"zh": "ch", "ko": "korean", "en": "en"}

    def __init__(self) -> None:
        self.engines: dict[str, object] = {}

    def _engine(self, lang: str):
        if lang not in self.engines:
            from rapidocr import RapidOCR
            from rapidocr.utils.typings import LangRec, ModelType, OCRVersion

            rec = LangRec(self.LANGS[lang])
            last = None
            for ver in (OCRVersion.PPOCRV5, OCRVersion.PPOCRV4):
                try:
                    # model_type must be given explicitly or RapidOCR rejects the combination.
                    self.engines[lang] = RapidOCR(
                        params={
                            "Global.log_level": "critical",
                            "Rec.lang_type": rec,
                            "Rec.ocr_version": ver,
                            "Rec.model_type": ModelType.MOBILE,
                        }
                    )
                    break
                except Exception as e:  # this language is not published for that version
                    last = e
            else:
                raise RuntimeError(f"RapidOCR 無法載入 {lang} 模型: {last}")
        return self.engines[lang]

    def __call__(self, img: Image.Image, lang: str) -> str:
        w, h = img.size
        if min(w, h) < 48:  # tiny crops recognise badly; upscale
            s = 48 / min(w, h)
            img = img.resize((int(w * s), int(h * s)), Image.BICUBIC)
        arr = np.asarray(img.convert("RGB"))[:, :, ::-1].copy()  # BGR
        with _lock:
            res = self._engine(lang)(arr)
        txts = getattr(res, "txts", None) or ()
        boxes = getattr(res, "boxes", None)
        if boxes is not None and len(txts) > 1:
            order = sorted(range(len(txts)), key=lambda i: (float(np.min(boxes[i][:, 1])), float(np.min(boxes[i][:, 0]))))
            txts = [txts[i] for i in order]
        return ("" if lang == "zh" else " ").join(t.strip() for t in txts if t.strip())


def colours(img: Image.Image, box) -> tuple[list[int], list[int]]:
    """Background colour (median of the box border) and a contrasting text colour."""
    x1, y1, x2, y2 = (int(round(v)) for v in box)
    a = np.asarray(img.crop((x1, y1, x2, y2)).convert("RGB"), dtype=np.float32)
    if a.size == 0:
        return [255, 255, 255], [0, 0, 0]
    t = max(1, min(a.shape[0], a.shape[1]) // 12)
    border = np.concatenate(
        [a[:t].reshape(-1, 3), a[-t:].reshape(-1, 3), a[:, :t].reshape(-1, 3), a[:, -t:].reshape(-1, 3)]
    )
    bg = np.median(border, axis=0)
    # Text colour: the pixels furthest from the background.
    dist = np.abs(a.reshape(-1, 3) - bg).sum(axis=1)
    far = a.reshape(-1, 3)[dist > max(90.0, float(dist.max()) * 0.6)]
    lum_bg = float(bg @ np.array([0.299, 0.587, 0.114]))
    if len(far) >= 8:
        fg = np.median(far, axis=0)
        if abs(float(fg @ np.array([0.299, 0.587, 0.114])) - lum_bg) < 80:
            fg = np.array([0, 0, 0]) if lum_bg > 128 else np.array([255, 255, 255])
    else:
        fg = np.array([0, 0, 0]) if lum_bg > 128 else np.array([255, 255, 255])
    return [int(v) for v in bg], [int(v) for v in fg]


def reading_order(blocks: list[dict], rtl: bool) -> list[dict]:
    """Rough reading order: bands top to bottom, right-to-left inside a band for manga."""
    if not blocks:
        return blocks
    hs = sorted(b["box"][3] - b["box"][1] for b in blocks)
    band = max(40.0, hs[len(hs) // 2] * 1.2)
    def key(b):
        cx = (b["box"][0] + b["box"][2]) / 2
        return (int(b["box"][1] // band), -cx if rtl else cx)
    return sorted(blocks, key=key)


def typeset_area(box, bubbles) -> list[float]:
    """Where the translation may be drawn: grown towards the inside of the enclosing bubble."""
    best = None
    for bb in bubbles:
        if _overlap_of(box, bb) > 0.7 and (best is None or (bb[2] - bb[0]) * (bb[3] - bb[1]) < (best[2] - best[0]) * (best[3] - best[1])):
            best = bb
    if best is None:
        return list(box)
    cx, cy = (best[0] + best[2]) / 2, (best[1] + best[3]) / 2
    hw, hh = (best[2] - best[0]) * 0.36, (best[3] - best[1]) * 0.36  # ~inscribed rect of an ellipse
    return [min(box[0], cx - hw), min(box[1], cy - hh), max(box[2], cx + hw), max(box[3], cy + hh)]
