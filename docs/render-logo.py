#!/usr/bin/env python3
"""Render ProofDeck logo/social-preview PNGs (supersampled for crisp edges)."""
from PIL import Image, ImageDraw, ImageFont
import os

HERE = os.path.dirname(__file__)
ASSETS = os.path.join(HERE, "assets")
os.makedirs(ASSETS, exist_ok=True)

GOLD = (233, 199, 121)
MINT = (166, 208, 185)
CARD = (28, 43, 46)
CARD2 = (23, 34, 36)
BG = (16, 26, 27)
INK = (237, 240, 223)
DIM = (140, 158, 152)

def font(size, bold=True):
    paths = (["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf"] if bold
             else ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf"])
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def rounded_card(d, cx, cy, size, rot_anti=False):
    """Draw the deck card (rotate applied on a square canvas via supersample coords)."""
    # we draw axis-aligned here; rotation handled by drawing the whole logo rotated
    half = size // 2
    d.rounded_rectangle([cx - half, cy - half, cx + half, cy + half], radius=int(size * 0.15),
                        fill=CARD, outline=GOLD, width=10)

def seal(d, cx, cy, r):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=GOLD, width=12)
    r2 = r - 14
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], outline=MINT, width=4)
    # checkmark
    pts = [(cx - r * 0.48, cy + r * 0.02), (cx - r * 0.12, cy + r * 0.42), (cx + r * 0.56, cy - r * 0.38)]
    d.line(pts, fill=MINT, width=18, joint="curve")
    for p in pts:
        d.ellipse([p[0] - 9, p[1] - 9, p[0] + 9, p[1] + 9], fill=MINT)

def chain_dots(d, pts):
    for (x, y, r, o) in pts:
        c = MINT if o == 255 else (MINT[0], MINT[1], MINT[2])
        d.ellipse([x - r, y - r, x + r, y + r], fill=(int(MINT[0] * o / 255), int(MINT[1] * o / 255), int(MINT[2] * o / 255)))

def draw_logo_square(scale=2, size_px=512):
    S = size_px * scale
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # rotate the whole emblem by drawing on a larger transparent canvas then rotating
    emblem = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ed = ImageDraw.Draw(emblem)
    card_size = int(S * 0.62)
    rounded_card(ed, S // 2, S // 2, card_size)
    seal(ed, S // 2, int(S * 0.47), int(S * 0.18))
    # evidence lines
    ed.rounded_rectangle([int(S * 0.33), int(S * 0.72), int(S * 0.67), int(S * 0.745)],
                         radius=int(S * 0.012), fill=GOLD)
    ed.rounded_rectangle([int(S * 0.38), int(S * 0.76), int(S * 0.62), int(S * 0.782)],
                         radius=int(S * 0.008), fill=(GOLD[0], GOLD[1], GOLD[2], 115))
    # chain dots
    chain_dots(ed, [(int(S * 0.14), int(S * 0.84), int(S * 0.02), 140),
                    (int(S * 0.21), int(S * 0.89), int(S * 0.014), 110),
                    (int(S * 0.27), int(S * 0.925), int(S * 0.009), 90)])
    emblem = emblem.rotate(-8, resample=Image.BICUBIC, expand=False)
    im.alpha_composite(emblem)
    # gold notch
    d.ellipse([int(S * 0.815), int(S * 0.2), int(S * 0.855), int(S * 0.24)], fill=GOLD)
    return im.resize((size_px, size_px), Image.LANCZOS)

# 1) logo-512.png
logo = draw_logo_square(scale=2, size_px=512)
logo.save(os.path.join(ASSETS, "logo-512.png"))

# 2) social preview 1280x640
SPW, SPH = 1280, 640
S = 2
sp = Image.new("RGBA", (SPW * S, SPH * S), BG)
d = ImageDraw.Draw(sp)
# subtle vignette bands
for i, a in enumerate((18, 10)):
    d.rounded_rectangle([40 * S + i * 22 * S, 40 * S + i * 22 * S, SPW * S - 40 * S - i * 22 * S, SPH * S - 40 * S - i * 22 * S],
                        radius=30 * S, outline=(GOLD[0], GOLD[1], GOLD[2], 0) if False else (46, 66, 68), width=3 * S)
logo_sq = draw_logo_square(scale=2, size_px=int(SPH * S * 0.78))
# paste logo at left
lx, ly = int(SPW * S * 0.06), int((SPH * S - logo_sq.height) // 2)
sp.alpha_composite(logo_sq, (lx, ly))
# wordmark
tx = lx + logo_sq.width + int(SPW * S * 0.055)
f_title = font(int(SPH * S * 0.17))
f_tag = font(int(SPH * S * 0.062), bold=False)
f_url = font(int(SPH * S * 0.042), bold=False)
d.text((tx, int(SPH * S * 0.24)), "ProofDeck", font=f_title, fill=INK)
d.text((tx + int(S * 6), int(SPH * S * 0.46)), "Agents claim done.", font=f_tag, fill=INK)
d.text((tx + int(S * 6), int(SPH * S * 0.545)), "ProofDeck demands proof.", font=f_tag, fill=MINT)
d.text((tx + int(S * 6), int(SPH * S * 0.72)), "github.com/kumu314/proofdeck", font=f_url, fill=DIM)
sp = sp.resize((SPW, SPH), Image.LANCZOS).convert("RGB")
sp.save(os.path.join(ASSETS, "social-preview.png"))
print("wrote", os.path.join(ASSETS, "logo-512.png"), "and", os.path.join(ASSETS, "social-preview.png"))
