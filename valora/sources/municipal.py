"""Free municipal property data. Only published ArcGIS query fields are requested."""
from __future__ import annotations

import json
import math
import re
import secrets

from .. import db as D, net, property_data

SURREY = "https://gisservices.surrey.ca/arcgis/rest/services"
SURREY_ZONING = f"{SURREY}/Public/Planning/MapServer/18"
SURREY_LOTS = f"{SURREY}/OpenData/MapServer/148"
TOWNSHIP = "https://services5.arcgis.com/frpHL0Fv8koQRVWY/ArcGIS/rest/services"
ASSESS_FIELDS = ("OBJECTID,House,Unit,Street,Postal_Code,PID,Zoning,Lot_Size,Lot_Desc,"
                 "AssessmentYear,Total_Gross_Land_Assessment,Total_Gross_Building_Assessment")
PREVIEW = "municipal-preview"
SQFT_PER_M2 = 10.7639104167


def _request(c, source: str, url: str, params: dict) -> dict:
    try:
        response = net.cached(c, source, url, {"f": "json", **params}, ttl_days=7, timeout=8)
    except OSError as error:
        raise ValueError(f"{source} could not be reached") from error
    data = response["data"]
    if response["status"] != 200 or not isinstance(data, dict) or data.get("error"):
        raise ValueError(f"{source} could not provide data for this lookup")
    return data


def _point_query(c, layer: str, location: dict, fields: str, *, geometry: bool = False) -> list[dict]:
    data = _request(c, "City of Surrey GIS", layer + "/query", {
        "geometry": f"{location['lon']},{location['lat']}", "geometryType": "esriGeometryPoint",
        "inSR": 4326, "spatialRel": "esriSpatialRelIntersects", "outFields": fields,
        "returnGeometry": "true" if geometry else "false", "outSR": 26910, "resultRecordCount": 10,
    })
    return data.get("features") or []


def _polygon_sqft(rings: list) -> int | None:
    # Esri uses opposite orientations for exterior rings and holes. EPSG:26910 is in metres.
    area = sum(
        sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:]))
        for ring in rings if len(ring) >= 4
    )
    return round(abs(area) * SQFT_PER_M2 / 2) if area else None


def _surrey(c, body: dict) -> list[dict]:
    address = str(body.get("address") or "").strip()
    if not 8 <= len(address) <= 240:
        raise ValueError("enter the complete Surrey street address")
    response = property_data.lookup_bc(c, address)
    if response.get("error"):
        raise ValueError(response["error"])
    records = []
    for match in response["matches"]:
        if str(match.get("city") or "").casefold() != "surrey":
            continue
        zones = _point_query(c, SURREY_ZONING, match, "ZONING_TEXT,ZONING")
        lots = _point_query(c, SURREY_LOTS, match, "PID,LOT_TYPE2", geometry=True)
        zone_names = sorted({str(row["attributes"]["ZONING_TEXT"]) for row in zones if row.get("attributes", {}).get("ZONING_TEXT")})
        # A unit pin can intersect shared strata land. Keep its land area out of the unit record.
        parcel = (lots[0] if len(lots) == 1 else {}) if match["precision"] != "UNIT" else {}
        attrs = parcel.get("attributes") or {}
        records.append({**match, "source": "City of Surrey GIS", "url": SURREY_ZONING,
                        "parcel_url": SURREY_LOTS if parcel else None, "zoning": " / ".join(zone_names),
                        "pid": attrs.get("PID"), "lot": _polygon_sqft((parcel.get("geometry") or {}).get("rings") or [])})
    return records


def _assessment_layer(c) -> str:
    catalogue = _request(c, "Township of Langley open data", TOWNSHIP, {})
    service = max(
        (service["name"] for service in catalogue.get("services", [])
         if service.get("type") == "FeatureServer" and re.fullmatch(r"Assessments_20\d{2}", service.get("name", ""))),
        default="",
    )
    if not service:
        raise ValueError("No published annual Langley assessment layer was found")
    return f"{TOWNSHIP}/{service}/FeatureServer/0"


def _num(value) -> float | None:
    try:
        result = float(str(value).replace(",", ""))
        return result if math.isfinite(result) and result >= 0 else None
    except (TypeError, ValueError):
        return None


def _langley(c, body: dict) -> list[dict]:
    house = str(body.get("house") or "").strip().upper()
    unit = str(body.get("unit") or "").strip().upper()
    street = D.norm_address(str(body.get("street") or ""))
    if not re.fullmatch(r"\d{1,6}[A-Z]?", house) or (unit and not re.fullmatch(r"[A-Z0-9-]{1,12}", unit)):
        raise ValueError("enter a civic number and, for a townhouse or condo, its unit number")
    where = f"House='{house}' AND " + (f"Unit='{unit}'" if unit else "(Unit IS NULL OR Unit='')")
    layer = _assessment_layer(c)
    response = _request(c, "Township of Langley assessments", layer + "/query", {
        "where": where, "outFields": ASSESS_FIELDS, "returnGeometry": "true", "outSR": 4326, "resultRecordCount": 40,
    })
    records = []
    for feature in response.get("features") or []:
        a, g = feature.get("attributes") or {}, feature.get("geometry") or {}
        if (str(a.get("House") or "").strip().upper() != house or str(a.get("Unit") or "").strip().upper() != unit
                or not a.get("Street") or (street and street not in D.norm_address(a["Street"]))):
            continue
        lat, lon = _num(g.get("y")), g.get("x")
        if lat is None or not isinstance(lon, (int, float)) or not (48 < lat < 50 and -124 < lon < -121):
            continue
        postal = a.get("Postal_Code") or ""
        address = f"{house} {a['Street'].title()}, Township of Langley, BC" + (f" {postal}" if postal else "")
        if unit:
            address = f"Unit {unit} – {address}"
        area = _num(a.get("Lot_Size"))
        unit_description = str(a.get("Lot_Desc") or "").upper()
        lot = None
        if not unit and area:
            if unit_description == "SQUARE FEET":
                lot = round(area)
            elif unit_description == "ACRES":
                lot = round(area * 43560)
        land = _num(a.get("Total_Gross_Land_Assessment"))
        building = _num(a.get("Total_Gross_Building_Assessment"))
        year = _num(a.get("AssessmentYear"))
        records.append({
            "address": address, "city": "Township of Langley", "state": "BC", "lat": lat, "lon": lon, "postal": postal,
            "source": "Township of Langley assessment data", "url": layer, "zoning": a.get("Zoning"), "pid": a.get("PID"),
            "lot": lot, "assessed_land": land, "assessed_impr": building,
            "assessed_total": land + building if land is not None and building is not None else None,
            "assessment_year": int(year) if year and 2000 <= year <= 2100 else None,
        })
    return records


def municipality(address: str) -> str | None:
    if re.search(r"\bSurrey\b", address, re.I):
        return "surrey"
    if re.search(r"\bLangley\b", address, re.I):
        return "langley"
    return None


def is_bc_address(address: str) -> bool:
    return bool(re.search(
        r"\b(?:BC|British Columbia)\b|\bB\.C\.(?=\s|,|$)|,\s*(?:Surrey|(?:Township of )?Langley)\s*(?:,\s*Canada)?$", address, re.I
    ))


def automatic_match(c, address: str) -> dict | None:
    place = municipality(address)
    if place == "surrey":
        matches = [row for row in _surrey(c, {"address": address}) if row["score"] == 100]
    elif place == "langley":
        street_line = re.split(r",|\b(?:Township of )?Langley\b", address, maxsplit=1, flags=re.I)[0].strip()
        prefix = re.fullmatch(r"(?:unit\s+)?([\w]+)\s*[-–—]\s*(\d{1,6}[A-Z]?)\s*(.*)", street_line, re.I)
        if prefix:
            unit, house, street = prefix.groups()
        else:
            civic = re.match(r"^(\d{1,6}[A-Z]?)\b\s*(.*)$", street_line, re.I)
            if not civic:
                return None
            house, street = civic.groups()
            explicit_unit = re.search(r"\bunit\s+([A-Z0-9-]+)\b", address, re.I)
            unit = explicit_unit[1] if explicit_unit else ""
            street = re.split(r"\bunit\b", street, maxsplit=1, flags=re.I)[0].strip()
        matches = _langley(c, {"house": house, "unit": unit, "street": street})
    else:
        return None
    return matches[0] if len(matches) == 1 else None


def preview(c, pid: int, body: dict) -> dict:
    lookup = {"surrey": _surrey, "langley": _langley}.get(body.get("municipality"))
    if not lookup:
        raise ValueError("choose a supported municipality")
    matches = lookup(c, body)
    c.execute("delete from api_cache where source=? and julianday('now')-julianday(fetched_at)>1", (PREVIEW,))
    shown = []
    for record in matches[:10]:
        token = secrets.token_urlsafe(20)
        D.insert(c, "api_cache", {"source": PREVIEW, "key": token, "fetched_at": net.now(), "status": 200,
                                  "body": json.dumps({"property_id": pid, "record": record})})
        shown.append({"token": token, **record})
    return {"matches": shown, "more": len(matches) > len(shown)}


def apply(c, pid: int, token: str) -> dict:
    cached = D.one(c, "select body from api_cache where source=? and key=? and julianday('now')-julianday(fetched_at)<=1", (PREVIEW, token))
    payload = json.loads(cached["body"]) if cached else {}
    if payload.get("property_id") != pid:
        return {"error": "Look up this property again before saving"}
    result = store(c, pid, payload["record"])
    if result.get("ok"):
        c.execute("delete from api_cache where source=? and key=?", (PREVIEW, token))
    return result


def store(c, pid: int, row: dict) -> dict:
    norm = D.norm_address(row["address"])
    if D.one(c, "select id from property where address_norm=? and id<>?", (norm, pid)):
        return {"error": "Another property already uses this address"}
    facts = {key: row[key] for key in ("address", "city", "state", "lat", "lon")}
    if row.get("lot"):
        facts["lot"] = row["lot"]
    if row.get("postal"):
        facts["zip"] = row["postal"]
    D.update(c, "property", pid, {**facts, "address_norm": norm})
    if row.get("assessment_year") and row.get("assessed_total") is not None:
        fields = {key: row[key] for key in ("assessed_land", "assessed_impr", "assessed_total")}
        fields["apn"] = row.get("pid")
        year, source = row["assessment_year"], row["source"]
        existing = D.one(c, "select id from parcel where property_id=? and year=? and source=?", (pid, year, source))
        if existing:
            D.update(c, "parcel", existing["id"], fields)
        else:
            D.insert(c, "parcel", {**fields, "property_id": pid, "year": year, "source": source})
    property_data._record(c, pid, "municipal", row["source"], row["url"], row)
    return {"ok": True}
