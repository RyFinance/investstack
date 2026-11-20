"""Where InvestStack keeps its files, outside the app bundle.

Existing Valora workspaces keep their original directory so stored document paths remain valid.
INVESTSTACK_HOME and the legacy VALORA_HOME override the platform default.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))   # bundled or checkout
WEB = ROOT / "web"


def home() -> Path:
    override = os.environ.get("INVESTSTACK_HOME") or os.environ.get("VALORA_HOME")
    if override:
        p = Path(override)
    else:
        if sys.platform == "darwin":
            parent = Path.home() / "Library" / "Application Support"
        elif os.name == "nt":
            parent = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
        else:
            parent = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
        legacy = parent / ("Valora" if sys.platform == "darwin" or os.name == "nt" else "valora")
        p = parent / ("InvestStack" if sys.platform == "darwin" or os.name == "nt" else "investstack")
        if not p.exists() and any((legacy / name).is_file() for name in ("valora.db", "valora-demo.db", "config.toml")):
            p = legacy
    p.mkdir(parents=True, exist_ok=True)
    return p


def sub(name: str) -> Path:
    p = home() / name
    p.mkdir(parents=True, exist_ok=True)
    return p


def db_file(demo: bool = False) -> Path:
    return home() / ("valora-demo.db" if demo else "valora.db")


def config_file() -> Path:
    return home() / "config.toml"
