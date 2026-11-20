"""US Census ACS 5-year estimates by ZCTA (ZIP Code Tabulation Area; needs `census_key` in Settings, free at
api.census.gov/data/key_signup.html). Median gross rent, median household income, housing units and vacant units.
Cached permanently per vintage. Without a key every field is None; a network or API error gives None."""
from __future__ import annotations

import time

from .. import config, net

VARS = {"median_rent": "B25064_001E", "median_income": "B19013_001E", "housing_units": "B25002_001E",
        "vacant_units": "B25002_003E"}
YEARS = (2024, 2023, 2022)          # newest 5-year vintage first; older ones are tried when a vintage is not published
BASE = "https://api.census.gov/data/{year}/acs/acs5"


def empty(z: str | None = None) -> dict:
    return {"zip": z, "year": None, **dict.fromkeys(VARS), "vacancy_rate": None, "source": None}


def _val(x) -> float | None:
    """Census values arrive as strings; large negative sentinels (-666666666 etc.) mean 'not available'."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if v < 0 else v


def parse(data, z: str, year: int) -> dict | None:
    """[[header...], [row...]] → InvestStack fields, or None when the ZCTA is not in the response."""
    if not isinstance(data, list) or len(data) < 2 or not isinstance(data[0], list):
        return None
    head = data[0]
    for row in data[1:]:
        r = dict(zip(head, row))
        if str(r.get("zip code tabulation area", z)) != z:
            continue
        out = {"zip": z, "year": year, **{k: _val(r.get(v)) for k, v in VARS.items()}}
        out["vacancy_rate"] = (out["vacant_units"] / out["housing_units"]
                               if out["vacant_units"] is not None and out["housing_units"] else None)
        out["source"] = f"US Census ACS 5-year {year - 4}–{year} (ZCTA {z})"
        return out
    return None


_down: dict[str, float] = {}          # ZIP → time of the last network failure (skip retries for RETRY seconds)
RETRY = 600


def zcta(c, z: str, refresh: bool = False) -> dict | None:
    z = str(z or "").strip()[:5]
    key = config.load().get("census_key")
    if not key or not (len(z) == 5 and z.isdigit()):
        return empty(z or None)
    if not refresh and time.time() - _down.get(z, 0) < RETRY:
        return None
    try:
        for year in YEARS:
            r = net.cached(c, "census_acs", BASE.format(year=year),
                           {"get": "NAME," + ",".join(VARS.values()), "for": f"zip code tabulation area:{z}", "key": key},
                           refresh=refresh, timeout=8)
            if r["status"] < 400:
                got = parse(r["data"], z, year)
                if got:
                    return got
        return None
    except Exception:                 # offline / DNS / timeout: null for now, and do not retry on every page view
        _down[z] = time.time()
        return None
