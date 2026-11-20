"""Prepare the InvestStack app icons and documentation banner.

    .venv/bin/python tools/art.py
    .venv/bin/python tools/art.py icon out.png
    .venv/bin/python tools/art.py banner out.png [screenshot.png]

The original logo is stored at docs/icon.png.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
GOLD = (192, 192, 182)
TX, TX2, MUT = (230, 229, 223), (164, 165, 157), (119, 121, 112)


def _mix(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _vgrad(w, h, top, bottom, gamma=1.0):
    g = Image.new("RGBA", (w, h))
    d = ImageDraw.Draw(g)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=_mix(top, bottom, (y / max(1, h - 1)) ** gamma) + (255,))
    return g


def draw_icon(path, size: int = 1024) -> None:
    with Image.open(ROOT / "docs" / "icon.png") as source:
        source.resize((size, size), Image.Resampling.LANCZOS).save(path)


def _font(size, weight="Regular"):
    for p in ("/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc", "C:/Windows/Fonts/segoeui.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            f = ImageFont.truetype(p, size)
            try:
                f.set_variation_by_name(weight)
            except Exception:
                pass
            return f
        except Exception:
            continue
    return ImageFont.load_default()


def _mono(size):
    for p in ("/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/Menlo.ttc", "C:/Windows/Fonts/consola.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _tracked(d, xy, text, font, fill, track):
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=font, fill=fill)
        x += d.textlength(ch, font=font) + track
    return x


def draw_banner(path, shot: str | None = None, W: int = 2560, H: int = 1280) -> None:
    """README banner. The right ~55% is left clean for a screenshot (composited when `shot` is given)."""
    path = Path(path)
    img = _vgrad(W, H, (41, 42, 40), (30, 31, 29))
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))   # parcel grid across the whole banner, very faint
    gd = ImageDraw.Draw(ov)
    for x in range(0, W, 80):
        gd.line([(x, 0), (x, H)], fill=(255, 255, 255, 5))
    for y in range(0, H, 80):
        gd.line([(0, y), (W, y)], fill=(255, 255, 255, 5))
    img = Image.alpha_composite(img, ov)
    icon = Image.new("RGBA", (1, 1))
    with tempfile.TemporaryDirectory() as tmp:
        draw_icon(Path(tmp) / "i.png", 512)
        icon = Image.open(Path(tmp) / "i.png").convert("RGBA").resize((260, 260), Image.LANCZOS)
    img.alpha_composite(icon, (128, 150))
    d = ImageDraw.Draw(img)
    _tracked(d, (420, 186), "InvestStack", _font(106, "Semibold"), TX + (255,), 2)
    _tracked(d, (426, 344), "DISCOVER · UNDERWRITE · DEVELOP · MANAGE", _mono(30), GOLD + (255,), 3)
    d.text((160, 500), "Commercial property intelligence on your own\ncomputer: find sites, test what can be built,\nunderwrite it with sources, run the portfolio.",
           font=_font(46), fill=TX2 + (255,), spacing=18)
    pills = ["3D development studio", "Zoning envelope checks", "Pro forma · IRR · DSCR", "Comps + adjustment grid",
             "Deal pipeline", "Portfolio + rent ledger", "Every figure sourced", "Mac + Windows"]
    x, y, maxx = 160, 760, 1130
    pf = _mono(27)
    pl = Image.new("RGBA", (W, H), (0, 0, 0, 0))   # translucent pills must be blended, not drawn straight on
    d = ImageDraw.Draw(pl)
    for p in pills:
        w = d.textlength(p, font=pf) + 44
        if x + w > maxx:
            x, y = 160, y + 72
        d.rounded_rectangle([x, y, x + w, y + 52], radius=8, fill=(255, 255, 255, 12), outline=(255, 255, 255, 36), width=2)
        d.text((x + 22, y + 11), p, font=pf, fill=(205, 205, 212, 255))
        x += w + 14
    img = Image.alpha_composite(img, pl)
    d = ImageDraw.Draw(img)
    d.text((160, H - 120), "Local-first · SQLite in your data folder · Zillow Research, FRED, Census, optional RentCast",
           font=_mono(24), fill=MUT + (255,))
    if shot:
        s = Image.open(shot).convert("RGBA")
        sw = 1260
        s = s.resize((sw, int(s.height * sw / s.width)), Image.LANCZOS)
        if s.height > H - 220:
            s = s.crop((0, 0, sw, H - 220))
        ox, oy = W - sw - 90, (H - s.height) // 2
        r = Image.new("L", s.size, 0)
        ImageDraw.Draw(r).rounded_rectangle([0, 0, s.width - 1, s.height - 1], radius=20, fill=255)
        sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle([ox - 10, oy + 24, ox + sw + 10, oy + s.height + 44], radius=30, fill=(0, 0, 0, 170))
        img = Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(40)))
        img.paste(s, (ox, oy), r)
        ImageDraw.Draw(img).rounded_rectangle([ox, oy, ox + sw - 1, oy + s.height - 1], radius=20, outline=(255, 255, 255, 40), width=2)
    else:                                        # placeholder: a large faint skyline so the right side is not empty
        pass
    img.convert("RGB").save(path)


def write_ico(png: Path, out: Path) -> None:
    Image.open(png).convert("RGBA").save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def write_icns(png: Path, out: Path) -> bool:
    """macOS only: an .iconset resized with Pillow, packed by iconutil. Returns False elsewhere or on failure."""
    if sys.platform != "darwin":
        return False
    src = Image.open(png).convert("RGBA")
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for s in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                px = s * scale
                src.resize((px, px), Image.LANCZOS).save(iconset / f"icon_{s}x{s}{'@2x' if scale == 2 else ''}.png")
        try:
            r = subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out)], capture_output=True, text=True)
        except OSError:
            return False
        if r.returncode:
            print("iconutil failed:", r.stderr.strip(), file=sys.stderr)
        return r.returncode == 0


def render_all() -> None:
    icon = ROOT / "docs" / "icon.png"
    icon.parent.mkdir(exist_ok=True)
    draw_banner(ROOT / "docs" / "banner.png")
    draw_icon(ROOT / "web" / "favicon.png", 64)
    write_ico(icon, ROOT / "desktop" / "icon.ico")
    ok = write_icns(icon, ROOT / "desktop" / "icon.icns")
    print("wrote docs/banner.png web/favicon.png desktop/icon.ico" + (" desktop/icon.icns" if ok else ""))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        render_all()
    elif sys.argv[1] == "icon":
        draw_icon(Path(sys.argv[2]), 1024)
    else:
        draw_banner(Path(sys.argv[2]), sys.argv[3] if len(sys.argv) > 3 else None)
