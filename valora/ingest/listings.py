"""Listings without scraping: import what the user exported or received themselves.

- A listings CSV the user downloaded (Redfin's "Download All" on a search, an MLS/agent export, or any sheet with
  an address and a price). Columns are matched by name, so layouts can differ.
- Pasted addresses, one per line (optionally "address, price").
- A listing alert email saved as .eml, or pasted listing text: address + price + beds/baths/sqft are pulled out.

Each imported row keeps its source file and line, and the listing URL when the file has one.
"""
from __future__ import annotations

import csv
import email
import io
import re
from datetime import date, datetime
from email import policy

from .. import db as D, net, props

COLS = {
    "address": [r"^address$", r"street address", r"property address", r"^street$", r"full address", r"address"],
    "city": [r"^city$", r"city"], "state": [r"^state", r"state or province"], "zip": [r"zip", r"postal"],
    "price": [r"^price$", r"list price", r"asking", r"sold price", r"close price", r"price"],
    "beds": [r"^beds?$", r"bedrooms", r"^br$"], "baths": [r"^baths?$", r"bathrooms", r"^ba$"],
    "sqft": [r"square feet", r"sq\.? ?ft", r"living area", r"sqft", r"^size$"],
    "lot": [r"lot size", r"lot sq", r"^lot$"], "year_built": [r"year built", r"yr built", r"^built$"],
    "dom": [r"days on market", r"^dom$", r"cdom"], "lat": [r"^lat"], "lon": [r"^lon", r"^lng"],
    "type": [r"property type", r"^type$", r"home type"], "url": [r"^url", r"link", r"listing url"],
    "status": [r"^status$", r"listing status"], "sold": [r"sold date", r"close date", r"sale date"],
    "sale_type": [r"sale type"], "hoa": [r"hoa"], "mls": [r"mls#?", r"listing id"], "units": [r"units", r"unit count"],
}
TYPE_MAP = [(r"multi|duplex|triplex|fourplex|plex|2-4", "Multi-Family"), (r"condo|co-op", "Condo"), (r"town", "Townhouse"),
            (r"land|lot", "Land"), (r"mobile|manufactured", "Manufactured"), (r"single|house|sfr|residential", "Single Family")]
ADDR = r"(\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9.' ]{2,40}?\s(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Boulevard|Ln|Lane|Ct|Court|Pl|Place|Way|Ter|Terrace|Cir|Circle|Pkwy|Parkway|Hwy|Highway|Trl|Trail)\b\.?(?:\s+(?:Apt|Unit|#)\s*[A-Za-z0-9-]+)?)(?:,?\s+([A-Za-z .'-]{2,30}),?\s+([A-Z]{2})\s+(\d{5}))?"


def _num(s):
    s = re.sub(r"[^0-9.\-]", "", str(s or ""))
    try:
        return float(s) if s not in ("", "-", ".") else None
    except ValueError:
        return None


def _map(head: list[str]) -> dict:
    low = [h.strip().lower() for h in head]
    out = {}
    for k, pats in COLS.items():
        for p in pats:
            i = next((i for i, h in enumerate(low) if re.search(p, h) and i not in out.values()), None)
            if i is not None:
                out[k] = i
                break
    return out


def is_listings_csv(text: str) -> bool:
    try:
        head = next(csv.reader(io.StringIO(text[:4000])))
    except Exception:
        return False
    m = _map(head)
    bankish = any(re.search(r"debit|credit|balance|posted|transaction|description|memo", h, re.I) for h in head)
    return "address" in m and ("price" in m or "beds" in m) and not bankish


def _ptype(s):
    for pat, t in TYPE_MAP:
        if re.search(pat, s or "", re.I):
            return t
    return (s or "").strip() or None


def _date(s):
    s = (s or "").strip()
    for f in ("%B-%d-%Y", "%m/%d/%Y", "%Y-%m-%d", "%b %d, %Y", "%m/%d/%y"):
        try:
            return datetime.strptime(s, f).date().isoformat()
        except ValueError:
            pass
    return None


def read_csv(text: str) -> tuple[list[dict], dict]:
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return [], {}
    m = _map(rows[0])
    out = []
    for ln, r in enumerate(rows[1:], start=2):
        g = lambda k: (r[m[k]].strip() if k in m and m[k] < len(r) else "")
        a = g("address")
        if not a or not re.search(r"\d", a) or "accordance with local MLS" in " ".join(r):
            continue
        city, st, z = g("city"), g("state"), g("zip")[:5]
        full = a if ("," in a and re.search(r"\b[A-Z]{2}\b", a)) else ", ".join(x for x in (a, city, f"{st} {z}".strip()) if x)
        units = _num(g("units"))
        out.append({"line": ln, "address": full, "city": city or None, "state": st or None, "zip": z or None,
                    "price": _num(g("price")), "beds": _num(g("beds")), "baths": _num(g("baths")), "sqft": _num(g("sqft")),
                    "lot": _num(g("lot")), "year_built": int(_num(g("year_built")) or 0) or None, "dom": _num(g("dom")),
                    "lat": _num(g("lat")), "lon": _num(g("lon")), "type": _ptype(g("type")), "url": g("url") or None,
                    "status": g("status") or None, "sold": _date(g("sold")), "units": int(units) if units else None,
                    "sale_type": g("sale_type") or None})
    return out, m


def store_rows(c, rows: list[dict], source: str) -> dict:
    """Write parsed rows: a sold row becomes sale history, anything else an active listing."""
    new = upd = sold = 0
    today = date.today()
    for r in rows:
        if not r.get("address"):
            continue
        had = D.one(c, "select id from property where address_norm=?", (D.norm_address(r["address"]),))
        pid = props.upsert(c, {k: r.get(k) for k in ("address", "city", "state", "zip", "lat", "lon", "type", "beds", "baths",
                                                     "sqft", "lot", "year_built", "units")} | {"source": source})
        new, upd = new + (0 if had else 1), upd + (1 if had else 0)
        is_sold = bool(r.get("sold")) or re.search(r"sold|closed|past sale", f"{r.get('status') or ''} {r.get('sale_type') or ''}", re.I)
        if is_sold and r.get("price"):
            d = r.get("sold") or today.isoformat()
            if not D.one(c, "select 1 from sale_history where property_id=? and date=?", (pid, d)):
                D.insert(c, "sale_history", {"property_id": pid, "date": d, "price": r["price"], "kind": "Sale", "source": source})
            D.update(c, "property", pid, {"last_sale_price": r["price"], "last_sale_date": d})
            sold += 1
        elif r.get("price"):
            c.execute("delete from listing where property_id=? and kind='sale' and source=?", (pid, source))
            dom = int(r["dom"]) if r.get("dom") is not None else None
            D.insert(c, "listing", {"property_id": pid, "kind": "sale", "price": r["price"], "status": "Active", "dom": dom,
                                    "listed": date.fromordinal(today.toordinal() - (dom or 0)).isoformat(), "source": source,
                                    "url": r.get("url"), "fetched_at": net.now()})
    return {"rows": len(rows), "new": new, "updated": upd, "sold": sold}


def import_csv(c, text: str, name: str) -> dict:
    rows, mapping = read_csv(text)
    src = "Redfin download" if "redfin" in text[:3000].lower() else f"file: {name}"
    return {**store_rows(c, rows, src), "columns": {k: v for k, v in mapping.items()}, "source": src}


def parse_text(text: str) -> list[dict]:
    """Addresses (with any price / beds / baths / sqft near them) from pasted text or an alert email."""
    out, seen = [], set()
    ms = list(re.finditer(ADDR, text))
    for i, m in enumerate(ms):
        street, city, st, z = m.group(1).strip(), m.group(2), m.group(3), m.group(4)
        full = street + (f", {city.strip()}, {st} {z}" if city and st else "")
        key = D.norm_address(full)
        if key in seen:
            continue
        seen.add(key)
        # details belong to this address: the text after it up to the next address; if none there, the text just before
        after = text[m.end(): min(m.end() + 260, ms[i + 1].start() if i + 1 < len(ms) else len(text))]
        before = text[max(ms[i - 1].end() if i else 0, m.start() - 160): m.start()]
        seg = after if re.search(r"\$\s?[0-9]", after) or not re.search(r"\$\s?[0-9]", before) else before
        def find(pat):
            return re.search(pat, seg, re.I)
        pm = find(r"\$\s?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{5,8})")
        bm = find(r"(\d+(?:\.\d)?)\s*(?:bd|beds?|br)\b")
        tm = find(r"(\d+(?:\.\d)?)\s*(?:ba|baths?)\b")
        sm = find(r"([0-9,]{3,7})\s*(?:sq\.?\s?ft|sqft|sf)\b")
        um = find(r"https?://[^\s\"'<>)]+")
        out.append({"address": full, "city": city and city.strip(), "state": st, "zip": z, "price": _num(pm.group(1)) if pm else None,
                    "beds": _num(bm.group(1)) if bm else None, "baths": _num(tm.group(1)) if tm else None,
                    "sqft": _num(sm.group(1)) if sm else None, "url": um.group(0) if um else None})
    return out


def eml_text(data: bytes) -> str:
    msg = email.message_from_bytes(data, policy=policy.default)
    parts = []
    for p in msg.walk():
        if p.get_content_type() in ("text/plain", "text/html"):
            try:
                t = p.get_content()
            except Exception:
                continue
            if p.get_content_type() == "text/html":
                t = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", t, flags=re.I)
                t = re.sub(r"<a[^>]+href=[\"']([^\"']+)[\"'][^>]*>", r" \1 ", t, flags=re.I)
                t = re.sub(r"<[^>]+>", " ", t)
            parts.append(t)
    return re.sub(r"[ \t\r\f]+", " ", "\n".join(parts)).replace("&nbsp;", " ").replace("&amp;", "&")


def import_text(c, text: str, source: str, geocode: bool = True, limit: int = 60) -> dict:
    """Pasted text / email → listings. Rows without coordinates are geocoded with the Census geocoder (free)."""
    rows = parse_text(text)[:limit]
    if geocode:
        from ..sources import census_geo
        for r in rows:
            if r.get("state") or "," in r["address"]:
                g = census_geo.geocode(c, r["address"])
                if g:
                    r.update({k: g.get(k) for k in ("lat", "lon", "zip", "state", "city") if g.get(k)})
    return {**store_rows(c, rows, source), "found": [r["address"] for r in rows]}
