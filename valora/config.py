"""Settings and API keys live in config.toml in the data folder (never in the repo).
The page only ever learns whether a key is set, not the key."""
from __future__ import annotations

import json
import os
import re
import threading
import tomllib

from . import paths

DEFAULTS = {
    "rentcast_key": "", "census_key": "", "hud_token": "", "google_key": "",
    "rentcast_budget": 0,           # paid calls require opt-in
    "demo": True,                   # start in the demo workspace until the user switches
    "home_zip": "",
    "currency": "USD",
    "setup_complete": False,
    "connectors_json": "[]",
}
KEYS = ("rentcast_key", "census_key", "hud_token", "google_key")


def load() -> dict:
    cfg = dict(DEFAULTS)
    f = paths.config_file()
    if f.exists():
        try:
            cfg.update(tomllib.loads(f.read_text()))
        except Exception:
            pass
    return cfg


def _fmt(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    return json.dumps(str(v))           # a JSON string is a valid TOML basic string (quotes, backslashes, newlines escaped)


def _coerce(k, v):
    d = DEFAULTS[k]
    if k == "currency":
        currency = str(v).upper()
        if not re.fullmatch(r"[A-Z]{3}", currency):
            raise ValueError("Enter a three-letter currency code")
        return currency
    if isinstance(d, bool):
        return v.strip().lower() in ("1", "true", "yes", "on") if isinstance(v, str) else bool(v)
    if isinstance(d, int):
        return max(0, int(float(v)))
    return str(v).strip()


_lock = threading.RLock()


def save(changes: dict) -> dict:
    with _lock:
        cfg = load()
        for k, v in changes.items():
            if k in DEFAULTS and v is not None:
                try:
                    cfg[k] = _coerce(k, v)
                except (TypeError, ValueError):
                    continue
        f = paths.config_file()
        tmp = f.with_name(f.name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            os.chmod(tmp, 0o600)
            file.write("".join(f"{k} = {_fmt(v)}\n" for k, v in cfg.items()))
        os.replace(tmp, f)                # atomic: a request reading config mid-save never sees half a file
    return cfg


def connectors() -> list:
    try:
        rows = json.loads(load()["connectors_json"])
    except (TypeError, ValueError):
        return []
    return rows if isinstance(rows, list) else []


def update_connectors(update) -> list:
    with _lock:
        rows = connectors()
        update(rows)
        save({"connectors_json": json.dumps(rows, ensure_ascii=True)})
        return rows


def public() -> dict:
    cfg = load()
    out = {k: cfg[k] for k in DEFAULTS if k not in (*KEYS, "connectors_json")}
    out.update({f"has_{k}": bool(cfg[k]) for k in KEYS})
    return out
