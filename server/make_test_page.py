"""Draws a synthetic manga-like page (original text, no real artwork) for testing."""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT = r"C:\Windows\Fonts\msgothic.ttc"
out = Path(sys.argv[1] if len(sys.argv) > 1 else "test-page.png")

W, H = 900, 1280
img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)

# panels with flat grey "art"
panels = [(30, 30, 870, 430, (205, 205, 205)), (30, 460, 430, 1250, (170, 175, 185)), (460, 460, 870, 1250, (225, 220, 210))]
for x1, y1, x2, y2, c in panels:
    d.rectangle((x1, y1, x2, y2), fill=c, outline="black", width=5)
    for i in range(x1 + 20, x2, 46):  # hatching so the background is not flat
        d.line((i, y1 + 5, i - 60, y2 - 5), fill=tuple(v - 18 for v in c), width=3)


def vertical(text_cols, cx, cy, size):
    """Draw columns of vertical text (right to left) centred on (cx, cy)."""
    f = ImageFont.truetype(FONT, size)
    gap = int(size * 1.25)
    x = cx + gap * (len(text_cols) - 1) / 2
    for col in text_cols:
        y = cy - len(col) * size / 2
        for ch in col:
            d.text((x - size / 2, y), ch, font=f, fill="black")
            y += size
        x -= gap


def bubble(cx, cy, rx, ry, cols, size=34):
    d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill="white", outline="black", width=4)
    vertical(cols, cx, cy, size)


bubble(700, 210, 130, 160, ["今日はいい", "天気ですね"])
bubble(210, 220, 140, 150, ["どこへ", "行くの？"], 38)
bubble(230, 680, 150, 170, ["ちょっと", "待って！", "忘れ物だよ"], 32)
bubble(670, 1040, 150, 160, ["ありがとう", "助かった"], 36)

# free text outside bubbles (sound effect style) and a horizontal caption
f = ImageFont.truetype(FONT, 60)
d.text((560, 560), "ドキドキ", font=f, fill="black", stroke_width=3, stroke_fill="white")
f = ImageFont.truetype(FONT, 30)
d.rectangle((60, 1150, 400, 1210), fill="white", outline="black", width=3)
d.text((75, 1165), "翌朝、駅前にて", font=f, fill="black")

img.save(out)
print(out, img.size)
