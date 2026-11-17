#!/usr/bin/env python3
"""Render demo-transcript.txt (an ACTUAL run of docs/demo-run.mjs) into demo.gif.

Honesty: every line comes verbatim from a real invocation of lib/verify.js —
this script only styles the text; it never invents output.
"""
from PIL import Image, ImageDraw, ImageFont
import sys, os

TRANSCRIPT = "D:/AgentHub/tmp/demo-transcript.txt"
OUT = os.path.join(os.path.dirname(__file__), "assets", "demo.gif")

W, H = 1000, 620
PAD = 28
LINE_H = 25
BG = (16, 26, 27)
BAR = (25, 37, 40)
INK = (237, 240, 223)
DIM = (140, 158, 152)
MINT = (166, 208, 185)
RED = (255, 107, 107)
GOLD = (233, 199, 121)
ORANGE = (255, 159, 67)

def font(size=16, prefer=("C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/cour.ttf", "C:/Windows/Fonts/msyh.ttc")):
    for f in prefer:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()

f_body = font(16)
f_cjk = font(15, ("C:/Windows/Fonts/msyh.ttc",))  # engine evidence strings are Chinese
f_bar = font(13)
f_foot = font(12)

lines = open(TRANSCRIPT, encoding="utf-8").read().splitlines()
# Strip volatile temp paths to keep the demo readable and stable.
lines = [l.replace("D:\\OPENCO~1\\", "D:\\tmp\\").replace("D:\\AgentHub\\tmp\\", "D:\\tmp\\") for l in lines]

def color_of(text: str):
    t = text.strip()
    if t.startswith("$"):
        return MINT
    if "FAIL" in t:
        return RED
    if "REJECTED" in t:
        return ORANGE
    if t.startswith("acceptance gate"):
        return GOLD
    if t.startswith("·") or t.startswith("verify V1"):
        return DIM
    if t.startswith("=>"):
        return DIM
    return INK

def frame(shown: int, final: bool) -> Image.Image:
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    # Title bar
    d.rectangle([0, 0, W, 38], fill=BAR)
    d.ellipse([16, 13, 26, 23], fill=(255, 95, 86))
    d.ellipse([32, 13, 42, 23], fill=(255, 189, 46))
    d.ellipse([48, 13, 58, 23], fill=(39, 201, 63))
    d.text((72, 11), "proofdeck — acceptance gate (actual run of lib/verify.js)", font=f_bar, fill=DIM)
    y = 62
    for i in range(0, shown):
        col = color_of(lines[i])
        use = f_cjk if any(ord(ch) > 127 for ch in lines[i]) else f_body
        d.text((PAD, y), lines[i], font=use, fill=col)
        y += LINE_H
    if final:
        # highlight the REJECTED block
        for i, l in enumerate(lines):
            if "done REJECTED" in l:
                yy = 62 + i * LINE_H - 4
                d.rectangle([PAD - 10, yy, W - PAD, yy + LINE_H * 3 + 6], outline=RED, width=2)
    d.text((PAD, H - 22), "text rendered from a real invocation — no fabricated output", font=f_foot, fill=DIM)
    return im

frames = []
durations = []
# Progressive reveal: a few lines per frame for the fast part, slower at the verdict.
for shown in range(1, len(lines) + 1):
    is_verdict = any("REJECTED" in lines[i] for i in range(max(0, shown - 3), shown))
    frames.append(frame(shown, final=(shown == len(lines))))
    durations.append(120 if not is_verdict else 420)
# Hold the last frame
for _ in range(4):
    frames.append(frame(len(lines), final=True))
    durations.append(900)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=False)
print(f"wrote {OUT} ({len(frames)} frames, {sum(durations)/1000:.1f}s)")
