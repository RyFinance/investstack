"""Build the InvestStack desktop app with PyInstaller (macOS and Windows).

    python tools/make_app.py            # macOS: dist/InvestStack.app   Windows: dist/InvestStack/InvestStack.exe
    python tools/make_app.py --install  # macOS only: also copy InvestStack.app to ~/Applications

Needs requirements-dev.txt installed in the Python that runs it. The macOS app is ad-hoc signed
(codesign -s -), not notarized; the Windows folder is packaged into an installer by desktop/installer.iss.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "desktop" / "valora.spec"
DIST, BUILD = ROOT / "dist", ROOT / "build"
IS_MAC, IS_WIN = sys.platform == "darwin", sys.platform == "win32"


def icons() -> None:
    """Render the icons if they are missing (needs Pillow)."""
    need = [ROOT / "desktop" / ("icon.icns" if IS_MAC else "icon.ico"), ROOT / "web" / "favicon.png"]
    if all(p.exists() for p in need):
        return
    sys.path.insert(0, str(ROOT / "tools"))
    import art
    art.render_all()


def pyinstaller() -> None:
    cmd = [sys.executable, "-m", "PyInstaller", str(SPEC), "--noconfirm", "--clean",
           "--distpath", str(DIST), "--workpath", str(BUILD)]
    print("+", " ".join(cmd), flush=True)
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode:
        sys.exit(f"PyInstaller failed ({r.returncode})")


def sign(app: Path) -> None:
    """Ad-hoc signature so Apple Silicon will run it and Gatekeeper shows the usual 'unidentified developer' prompt."""
    r = subprocess.run(["codesign", "--force", "--deep", "-s", "-", str(app)], capture_output=True, text=True)
    if r.returncode:
        sys.exit("codesign failed:\n" + r.stderr)
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    print(f"signed (ad-hoc) {app}")


def install(app: Path) -> Path:
    target = Path.home() / "Applications" / app.name
    target.parent.mkdir(exist_ok=True)
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(app, target, symlinks=True)
    os.utime(target)
    return target


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--install", action="store_true", help="macOS: copy InvestStack.app to ~/Applications")
    a = ap.parse_args()
    icons()
    pyinstaller()
    if IS_MAC:
        app = DIST / "InvestStack.app"
        if not app.exists():
            sys.exit(f"missing {app}")
        sign(app)
        print(f"built {app}")
        if a.install:
            print(f"installed {install(app)}")
    else:
        exe = DIST / "InvestStack" / ("InvestStack.exe" if IS_WIN else "InvestStack")
        if not exe.exists():
            sys.exit(f"missing {exe}")
        print(f"built {exe}")
        if a.install:
            print("--install is macOS only; on Windows build desktop/installer.iss with Inno Setup")


if __name__ == "__main__":
    main()
