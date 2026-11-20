"""Property data from user-supplied listing excerpts and the public B.C. Address Geocoder."""
from __future__ import annotations

import json
import re
from datetime import date
from urllib.parse import urlencode, urlsplit

from . import db as D, net

BC_GEOCODER = "https://geocoder.api.gov.bc.ca/addresses.json"
BC_SOURCE = "B.C. Address Geocoder"
LISTING_SOURCES = ("Zillow", "REALTOR.ca", "Other listing")
FACTS = ("beds", "baths", "sqft", "lot", "year_built")
NUMBER = r"([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)"
AREA_UNIT = r"(?:sq\.?\s*ft\.?|square feet|ft²|sqft|sf)(?!\w)"


def _first(text: str, *patterns: str) -> float | None:
    for pattern in patterns:
        match = re.search(pattern, text, re.I | re.M)
        if match:
            return float(match.group(1).replace(",", ""))
    return None


def listing_facts(text: str) -> dict:
    """Extract recognizable facts from copied text. The user reviews before anything is written."""
    text = text.strip()
    if len(text) > 20000:
        raise ValueError("paste a shorter listing excerpt")
    result = {
        "beds": _first(text, rf"\b(?:bedrooms?|beds?)\s*:\s*{NUMBER}", rf"(?<![\d.,]){NUMBER}\s*(?:beds?|bedrooms?|bd)\b"),
        "baths": _first(text, rf"\b(?:bathrooms?|baths?)\s*:\s*{NUMBER}", rf"(?<![\d.,]){NUMBER}\s*(?:baths?|bathrooms?|ba)\b"),
        "sqft": _first(text, rf"\b(?:interior|living area|floor area|building size)\s*:\s*{NUMBER}\s*{AREA_UNIT}",
                       rf"^\s*size\s*:\s*{NUMBER}\s*{AREA_UNIT}",
                       rf"^\s*{NUMBER}\s*{AREA_UNIT}(?:\s*(?:finished|living area|interior))?\s*$"),
        "lot": _first(text, rf"\b(?:lot size|lot area|land size)\s*:\s*{NUMBER}\s*{AREA_UNIT}", rf"{NUMBER}\s*{AREA_UNIT}\s+lot\b"),
        "year_built": _first(text, r"\b(?:year built\s*:\s*|built\s+(?:in\s+)?)(\d{4})\b"),
        "asking": _first(text, rf"^\s*(?:(?:asking|list(?:ing)?|sale) price|price)\s*:\s*(?:CAD\s*)?\$\s*{NUMBER}\s*$",
                         rf"^\s*(?:CAD\s*)?\$\s*{NUMBER}\s*$"),
    }
    if result["sqft"] is None:
        # Zillow often puts the three main facts on a single line.
        result["sqft"] = _first(text, rf"\b(?:baths?|bathrooms?|ba)(?:\s|[·|•,])+{NUMBER}\s*{AREA_UNIT}")
    return {key: value for key, value in result.items() if value is not None}


def _source_url(url: str) -> str:
    url = url.strip()
    if not url:
        return ""
    parts = urlsplit(url)
    if len(url) > 2048 or parts.scheme != "https" or not parts.hostname or parts.username or parts.password or re.search(r"[\s\\]", url):
        raise ValueError("the source link must be a valid HTTPS URL")
    return url


def _record(c, pid: int, kind: str, source: str, url: str, fields: dict) -> None:
    c.execute("""insert into property_source(property_id,kind,source,url,fields,imported) values(?,?,?,?,?,?)
        on conflict(property_id,kind,source,url) do update set fields=excluded.fields, imported=excluded.imported""",
              (pid, kind, source, url, json.dumps(fields), net.now()))


def apply_listing(c, pid: int, body: dict) -> dict:
    source = body.get("source")
    if source not in LISTING_SOURCES:
        raise ValueError("select a listing source")
    url = _source_url(str(body.get("url") or ""))
    raw = body["facts"] if isinstance(body.get("facts"), dict) else {}
    facts = D.clean(c, "property", {k: raw[k] for k in FACTS if k in raw and raw[k] not in (None, "")})
    if any(v is not None and v < 0 for v in facts.values()):
        raise ValueError("property facts must be nonnegative")
    year = facts.get("year_built")
    if year is not None and not 1500 <= year <= date.today().year + 5:
        raise ValueError("check the year built")
    asking = D.coerce("asking", "real", raw.get("asking")) if body.get("active_sale") is True else None
    if body.get("active_sale") is True and (asking is None or asking <= 0):
        raise ValueError("enter a positive asking price to save an active sale listing")
    if not facts and asking is None and not url:
        raise ValueError("enter at least one fact or source link")
    if facts:
        D.update(c, "property", pid, facts)
    if asking is not None:
        label = f"{source} · imported"
        row = D.one(c, "select id from listing where property_id=? and kind='sale' and source=? and coalesce(url,'')=?",
                    (pid, label, url))
        attrs = {"price": asking, "status": "Active", "url": url, "fetched_at": net.now()}
        if row:
            D.update(c, "listing", row["id"], attrs)
        else:
            D.insert(c, "listing", {**attrs, "property_id": pid, "kind": "sale", "source": label, "listed": date.today().isoformat()})
    _record(c, pid, "listing", source, url, {**facts, **({"asking": asking} if asking is not None else {})})
    return {"ok": True}


def _geo_params(address: str) -> dict:
    return {"addressString": address, "outputSRS": 4326, "minScore": 90, "maxResults": 5, "echo": "false"}


def _matches(data: dict, address: str) -> list[dict]:
    unit = re.search(r"(?:\b(?:unit|apt|suite)\s*|#\s*)([\da-z-]+)", address, re.I)
    unit = unit or re.match(r"^([\da-z]+)\s*-\s*\d+\s", address, re.I)
    out = []
    if not isinstance(data, dict):
        return out
    for row in data.get("features") or []:
        prop, geo = row.get("properties") or {}, row.get("geometry") or {}
        coords = geo.get("coordinates") or []
        precision = prop.get("matchPrecision")
        score = prop.get("score")
        if not isinstance(score, (int, float)) or score < 90:
            continue
        if prop.get("provinceCode") != "BC" or precision not in ("CIVIC_NUMBER", "UNIT") or len(coords) < 2:
            continue
        result_unit = str(prop.get("unitNumber") or "") + str(prop.get("unitNumberSuffix") or "")
        if unit and (precision != "UNIT" or result_unit.casefold() != unit.group(1).casefold()):
            continue
        lon, lat = coords[:2]
        if not all(isinstance(x, (int, float)) for x in (lon, lat)) or not (-140 < lon < -114 and 48 < lat < 61):
            continue
        if not prop.get("fullAddress") or not prop.get("siteID"):
            continue
        out.append({"site": prop["siteID"], "address": prop["fullAddress"], "city": prop.get("localityName"),
                    "state": "BC", "lat": lat, "lon": lon, "precision": precision, "score": score})
    return out


def lookup_bc(c, address: str) -> dict:
    try:
        response = net.cached(c, BC_SOURCE, BC_GEOCODER, _geo_params(address), ttl_days=30, timeout=10)
    except OSError:
        return {"error": "The B.C. address service could not be reached"}
    if response["status"] != 200:
        return {"error": "The B.C. address service did not return a result"}
    return {"matches": _matches(response["data"], address)}


def save_bc(c, pid: int, address: str, site: str) -> dict:
    key = BC_GEOCODER + "?" + urlencode(sorted(_geo_params(address).items()))
    cached = D.one(c, "select body from api_cache where source=? and key=?", (BC_SOURCE, key))
    candidates = _matches(json.loads(cached["body"]), address) if cached else []
    match = next((candidate for candidate in candidates if candidate["site"] == site), None)
    if not match:
        return {"error": "Look up the address again before saving"}
    norm = D.norm_address(match["address"])
    if D.one(c, "select id from property where address_norm=? and id<>?", (norm, pid)):
        return {"error": "Another property already uses this address"}
    facts = {k: match[k] for k in ("address", "city", "state", "lat", "lon")}
    D.update(c, "property", pid, {**facts, "address_norm": norm})
    _record(c, pid, "location", BC_SOURCE, "https://digital.gov.bc.ca/bcgov-common-components/bc-address-geocoder/",
            {**facts, "precision": match["precision"]})
    return {"ok": True, "address": match["address"]}
