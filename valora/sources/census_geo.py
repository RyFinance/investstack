"""US Census geocoder (no key): address → coordinates, zip, county, tract. Nominatim (1 req/s) as fallback."""
from __future__ import annotations

import time

from .. import net

_last = [0.0]


def geocode(c, address: str) -> dict | None:
    """Never raises: offline or a provider error gives None (the lookup then says the address was not geocoded)."""
    try:
        return _geocode(c, address)
    except Exception:
        return None


def _geocode(c, address: str) -> dict | None:
    r = net.cached(c, "census_geo", "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress",
                   {"address": address, "benchmark": "Public_AR_Current", "vintage": "Current_Current", "format": "json"})
    data = r["data"] if isinstance(r["data"], dict) else {}
    m = ((data.get("result") or {}).get("addressMatches") or []) if r["status"] < 400 else []
    if m:
        a = m[0]
        comp = a.get("addressComponents", {})
        geo = a.get("geographies", {})
        county = (geo.get("Counties") or [{}])[0]
        tract = (geo.get("Census Tracts") or [{}])[0]
        return {"address": a["matchedAddress"], "lat": a["coordinates"]["y"], "lon": a["coordinates"]["x"],
                "zip": comp.get("zip"), "state": comp.get("state"), "city": comp.get("city"),
                "county": county.get("NAME"), "county_fips": county.get("GEOID"), "tract": tract.get("GEOID"),
                "source": "US Census geocoder"}
    wait = 1.05 - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    _last[0] = time.time()
    r = net.cached(c, "nominatim", "https://nominatim.openstreetmap.org/search",
                   {"q": address, "format": "json", "addressdetails": 1, "limit": 1, "countrycodes": "us"})
    d = r["data"] if isinstance(r["data"], list) else []
    if not d:
        return None
    a = d[0].get("address", {})
    return {"address": d[0].get("display_name"), "lat": float(d[0]["lat"]), "lon": float(d[0]["lon"]),
            "zip": a.get("postcode"), "state": a.get("state"), "city": a.get("city") or a.get("town") or a.get("village"),
            "county": a.get("county"), "source": "OpenStreetMap Nominatim"}
