# PyInstaller spec for InvestStack (onedir, windowed). Build with:  python tools/make_app.py
#   macOS   -> dist/InvestStack.app          (bundle id com.ryfinance.valora)
#   Windows -> dist/InvestStack/InvestStack.exe   (packaged by desktop/installer.iss)
# Paths are relative to this file, so it works from any working directory.
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

HERE = Path(SPECPATH)                      # noqa: F821  (injected by PyInstaller)
ROOT = HERE.parent
IS_MAC, IS_WIN = sys.platform == "darwin", sys.platform == "win32"

import os
sys.path.insert(0, str(ROOT))
VERSION = os.environ.get("VALORA_VERSION", "0.1.0").lstrip("v")   # CI sets it from the tag

hidden = collect_submodules("valora") + ["pypdf"]
if IS_MAC:
    hidden += ["webview.platforms.cocoa", "objc", "Foundation", "AppKit", "WebKit", "Quartz", "Security",
               "UniformTypeIdentifiers"]
elif IS_WIN:
    hidden += ["webview.platforms.winforms", "webview.platforms.edgechromium", "clr", "clr_loader",
               "pythonnet"]
else:
    hidden += ["webview.platforms.gtk", "webview.platforms.qt"]

a = Analysis(                               # noqa: F821
    [str(HERE / "main.py")],
    pathex=[str(ROOT)],
    datas=[(str(ROOT / "web"), "web")],     # served from sys._MEIPASS/web (valora/paths.py)
    hiddenimports=hidden,
    excludes=["tkinter", "numpy", "pandas", "matplotlib", "PIL", "openpyxl", "IPython", "pytest",
              "PyInstaller"],
    noarchive=False,
)
pyz = PYZ(a.pure)                           # noqa: F821

icon = str(HERE / ("icon.icns" if IS_MAC else "icon.ico"))
exe = EXE(                                  # noqa: F821
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="InvestStack",
    console=False,                          # windowed: no terminal window on Windows
    icon=icon,
    upx=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    version=None,
)
coll = COLLECT(exe, a.binaries, a.datas, name="InvestStack", upx=False)   # noqa: F821

if IS_MAC:
    app = BUNDLE(                           # noqa: F821
        coll,
        name="InvestStack.app",
        icon=icon,
        bundle_identifier="com.ryfinance.valora",
        version=VERSION,
        info_plist={
            "CFBundleName": "InvestStack",
            "CFBundleDisplayName": "InvestStack",
            "CFBundleShortVersionString": VERSION,
            "CFBundleVersion": VERSION,
            "LSMinimumSystemVersion": "12.0",
            "NSHighResolutionCapable": True,
            "LSApplicationCategoryType": "public.app-category.business",
            "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
            "NSHumanReadableCopyright": "InvestStack",
        },
    )
