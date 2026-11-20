"""HUD Fair Market Rents by ZIP (needs `hud_token` in Settings, free at huduser.gov/hudapi/public/register).
ZIP → county via the HUD USPS crosswalk, then that county's FMRs; in Small Area FMR metros the ZIP's own row is
used. Cached (FMRs change once a year). Network or API errors give None, never an exception."""
from __future__ import annotations

import time

from .. import config, net

API = "https://www.huduser.gov/hudapi/public"
BEDS = {"Efficiency": "0", "One-Bedroom": "1", "Two-Bedroom": "2", "Three-Bedroom": "3", "Four-Bedroom": "4"}
TTL = 120
RETRY = 600
_down: dict[str, float] = {}          # ZIP → time of the last network failure


def _get(c, url: str, params: dict | None, token: str, refresh: bool) -> dict | None:
    r = net.cached(c, "hud", url, params, {"Authorization": f"Bearer {token}", "Accept": "application/json"},
                   refresh=refresh, ttl_days=TTL, timeout=8)
    return r["data"] if r["status"] < 400 and isinstance(r["data"], dict) else None


def _num(x) -> float | None:
    try:
        return float(str(x).replace(",", "").replace("$", ""))
    except (TypeError, ValueError):
        return None


def county_for_zip(data: dict | None) -> str | None:
    """USPS crosswalk (type 2, zip→county) response → 5-digit county FIPS with the largest residential share."""
    res = ((data or {}).get("data") or {}).get("results") or []
    res = [x for x in res if isinstance(x, dict) and x.get("geoid")]
    if not res:
        return None
    best = max(res, key=lambda x: _num(x.get("res_ratio")) or 0)
    return str(best["geoid"])[:5]


def parse_fmr(data: dict | None, z: str) -> dict | None:
    """FMR data response → {zip, year, area, small_area, rents:{"0".."4"}, source}."""
    d = (data or {}).get("data")
    if not isinstance(d, dict):
        return None
    basic = d.get("basicdata")
    small = str(d.get("smallarea_status", "0")) == "1"
    row = None
    if isinstance(basic, list):
        row = next((x for x in basic if str(x.get("zip_code")) == z), None)
        if row is None:          # ZIP not listed: HUD's metro-wide row if there is one
            row = next((x for x in basic if str(x.get("zip_code", "")).upper() in ("MSA LEVEL", "")), None)
            small = False
    elif isinstance(basic, dict):
        row = basic
    if not row:
        return None
    rents = {v: _num(row.get(k)) for k, v in BEDS.items()}
    if not any(v is not None for v in rents.values()):
        return None
    year = d.get("year") or row.get("year")
    area = d.get("area_name") or d.get("metro_name") or d.get("county_name")
    return {"zip": z, "year": year, "area": area, "small_area": small, "rents": rents,
            "source": f"HUD Fair Market Rents FY{year}" + (" (Small Area, ZIP)" if small else f" ({area})" if area else "")}


def fmr(c, z: str, refresh: bool = False) -> dict | None:
    z = str(z or "").strip()[:5]
    token = config.load().get("hud_token")
    if not token or not (len(z) == 5 and z.isdigit()):
        return None
    if not refresh and time.time() - _down.get(z, 0) < RETRY:
        return None
    try:
        county = county_for_zip(_get(c, f"{API}/usps", {"type": 2, "query": z}, token, refresh))
        if not county:
            return None
        return parse_fmr(_get(c, f"{API}/fmr/data/{county}99999", None, token, refresh), z)
    except Exception:                 # offline / DNS / timeout: null for now, and do not retry on every page view
        _down[z] = time.time()
        return None
