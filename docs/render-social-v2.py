#!/usr/bin/env python3
"""ProofDeck social preview — design version v2 (full-effort composition).

Layers: deep gradient field → dot grid → seal glow → emblem (rotated deck card
stamped with a proof seal) → evidence chain strip → typography with the
done→proof contrast device. 3x supersampled.
"""
from PIL import Image, ImageDraw, ImageFont
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "assets", "social-preview-design.png")
W, H = 1280, 640
S = 3  # supersample
WS, HS = W * S, H * S

GOLD = (233, 199, 121)
GOLD_DIM = (233, 199, 121, 90)
MINT = (166, 208, 185)
INK = (237, 240, 223)
DIM = (141, 158, 152)
CARD = (28, 43, 46)
CARD2 = (22, 33, 36)
BG_TOP = (13, 21, 22)
BG_BOT = (17, 27, 28)
RED_SOFT = (255, 128, 114)

def font(size, bold=True):
    paths = (["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf"] if bold
             else ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf"])
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

f_word = font(int(H * S * 0.155))          # wordmark
f_tag = font(int(H * S * 0.075))           # tagline lines
f_small = font(int(H * S * 0.048), bold=False)
f_url = font(int(H * S * 0.042), bold=False)
f_tile = font(int(H * S * 0.026))

im = Image.new("RGB", (WS, HS), BG_TOP)
d = ImageDraw.Draw(im)

# 1) vertical gradient field
for y in range(HS):
    t = y / HS
    c = tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3))
    d.line([(0, y), (WS, y)], fill=c)

# 2) faint dot grid
step = int(HS * 0.055)
for gy in range(step // 2, HS, step):
    for gx in range(step // 2, WS, step):
        d.ellipse([gx - 1, gy - 1, gx + 1, gy + 1], fill=(38, 52, 55))

# 3) soft gold radial glow behind the emblem (small-layer gradient, smooth-scaled)
glow_cx, glow_cy = int(WS * 0.27), int(HS * 0.5)
gr = int(HS * 0.58)
glow_layer = Image.new("RGBA", (gr, gr), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow_layer)
gc = gr // 2
for r in range(gc, 0, -2):
    a = int(30 * (1 - r / gc) ** 1.6)
    gd.ellipse([gc - r, gc - r, gc + r, gc + r], fill=(GOLD[0], GOLD[1], GOLD[2], a))
glow_layer = glow_layer.resize((gr * 2, gr * 2), Image.BICUBIC)
im.paste(glow_layer, (glow_cx - gr, glow_cy - gr), glow_layer)
# one faint outer composition ring
d.ellipse([glow_cx - int(HS * 0.46), glow_cy - int(HS * 0.46),
           glow_cx + int(HS * 0.46), glow_cy + int(HS * 0.46)],
          outline=(GOLD[0], GOLD[1], GOLD[2], 45), width=int(HS * 0.004))

# 4) emblem: rotated deck card + seal + check + evidence lines
emblem = Image.new("RGBA", (WS, HS), (0, 0, 0, 0))
ed = ImageDraw.Draw(emblem)
card = int(HS * 0.66)
cx, cy = glow_cx, glow_cy
half = card // 2
ed.rounded_rectangle([cx - half, cy - half, cx + half, cy + half],
                     radius=int(card * 0.16), fill=CARD, outline=GOLD, width=int(HS * 0.012))
# seal rings
r = int(card * 0.30)
ed.ellipse([cx - r, cy - int(card * 0.06) - r, cx + r, cy - int(card * 0.06) + r],
           outline=GOLD, width=int(HS * 0.014))
r2 = r - int(HS * 0.02)
ed.ellipse([cx - r2, cy - int(card * 0.06) - r2, cx + r2, cy - int(card * 0.06) + r2],
           outline=(MINT[0], MINT[1], MINT[2], 120), width=int(HS * 0.004))
# checkmark
chk = [(cx - int(r * 0.52), cy - int(card * 0.06) + int(r * 0.05)),
       (cx - int(r * 0.10), cy - int(card * 0.06) + int(r * 0.46)),
       (cx + int(r * 0.58), cy - int(card * 0.06) - int(r * 0.42))]
ed.line(chk, fill=MINT, width=int(HS * 0.022), joint="curve")
for p in chk:
    ed.ellipse([p[0] - int(HS * 0.008), p[1] - int(HS * 0.008),
                p[0] + int(HS * 0.008), p[1] + int(HS * 0.008)], fill=MINT)
# evidence lines under the seal
ed.rounded_rectangle([cx - int(card * 0.34), cy + int(card * 0.28),
                      cx + int(card * 0.34), cy + int(card * 0.305)],
                     radius=int(HS * 0.008), fill=GOLD)
ed.rounded_rectangle([cx - int(card * 0.26), cy + int(card * 0.335),
                      cx + int(card * 0.26), cy + int(card * 0.357)],
                     radius=int(HS * 0.006), fill=(GOLD[0], GOLD[1], GOLD[2], 120))
# chain dots flowing into the card
for (fx, fy, fr, fa) in [(0.055, 0.88, 0.016, 200), (0.105, 0.925, 0.011, 150), (0.145, 0.955, 0.007, 110)]:
    px, py, pr = int(WS * fx), int(HS * fy), int(HS * fr)
    ed.ellipse([px - pr, py - pr, px + pr, py + pr], fill=(MINT[0], MINT[1], MINT[2], fa))
# gold notch
ed.ellipse([int(WS * 0.405), int(HS * 0.115), int(WS * 0.425), int(HS * 0.155)], fill=GOLD)
emblem = emblem.rotate(-7, resample=Image.BICUBIC, expand=False)
im.paste(emblem, (0, 0), emblem)

# 5) typography — right column
tx = int(WS * 0.52)
ty = int(HS * 0.20)
d.text((tx, ty), "ProofDeck", font=f_word, fill=INK)
ty += int(HS * 0.20)
# tagline line 1: "Agents claim done." with a strike through "done" (dim = dismissed)
d.text((tx, ty), "Agents claim ", font=f_tag, fill=DIM)
w1 = d.textlength("Agents claim ", font=f_tag)
d.text((tx + w1, ty), "done.", font=f_tag, fill=DIM)
w2 = d.textlength("done.", font=f_tag)
sw = d.textlength("done", font=f_tag)
sy = ty + int(HS * 0.048)
d.line([(tx + w1, sy), (tx + w1 + sw, sy)], fill=RED_SOFT, width=int(HS * 0.006))
ty += int(HS * 0.115)
d.text((tx, ty), "ProofDeck demands ", font=f_tag, fill=INK)
w3 = d.textlength("ProofDeck demands ", font=f_tag)
d.text((tx + w3, ty), "proof.", font=f_tag, fill=GOLD)
ty += int(HS * 0.13)

# 6) evidence chain strip: five linked stamped tiles
tile_w, tile_h, gap = int(WS * 0.062), int(HS * 0.20), int(WS * 0.014)
chain_y = int(HS * 0.70)
labels = ["run", "test", "judge", "seal", "done"]
for i, lab in enumerate(labels):
    x = tx + i * (tile_w + gap)
    col = GOLD if i >= 3 else MINT
    d.rounded_rectangle([x, chain_y, x + tile_w, chain_y + tile_h],
                        radius=int(tile_w * 0.16), outline=col, width=int(HS * 0.005))
    d.text((x + tile_w // 2 - d.textlength(lab, font=f_tile) // 2,
            chain_y + tile_h // 2 - int(HS * 0.016)), lab, font=f_tile, fill=col)
    if i < len(labels) - 1:
        lx = x + tile_w
        d.line([(lx + 2, chain_y + tile_h // 2), (lx + gap - 2, chain_y + tile_h // 2)],
               fill=(70, 92, 92), width=int(HS * 0.004))
d.text((tx, chain_y + tile_h + int(HS * 0.03)),
       "every claim → evidence → append-only chain", font=f_small, fill=DIM)

# 7) repo url bottom-right
url = "github.com/kumu314/proofdeck"
d.text((WS - int(WS * 0.04) - d.textlength(url, font=f_url), int(HS * 0.90)),
       url, font=f_url, fill=DIM)

im = im.resize((W, H), Image.LANCZOS)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
im.save(OUT, quality=95)
print("wrote", OUT)
