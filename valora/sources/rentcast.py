"""RentCast API (key in config.toml). Property records, value and rent estimates with comps, sale and rental
listings, ZIP market stats. Free tier: 50 calls a month; beyond that each call is billed, so every call goes
through a budget check and a permanent cache, and nothing is re-fetched unless the user refreshes."""
from __future__ import annotations

from .. import config, net

BASE = "https://api.rentcast.io/v1"
FREE = 50


class NoKey(Exception):
    pass


class OverBudget(Exception):
    pass


def allowance() -> int:
    return FREE + int(config.load().get("rentcast_budget") or 0)


def status(c) -> dict:
    used = net.usage(c, "rentcast")
    cfg = config.load()
    return {"has_key": bool(cfg.get("rentcast_key")), "used": used, "free": FREE, "allowance": allowance(),
            "billable": max(0, used - FREE), "est_cost": max(0, used - FREE) * 0.20}


def call(c, path: str, params: dict, refresh: bool = False) -> dict:
    key = config.load().get("rentcast_key")
    if not key:
        raise NoKey("Add a RentCast API key in Settings to pull property records and listings.")
    url = BASE + path
    params = {k: v for k, v in params.items() if v not in (None, "")}
    # cache hits are free; only check the budget when we will actually call
    import urllib.parse
    k = url + "?" + urllib.parse.urlencode(sorted(params.items()))
    hit = c.execute("select 1 from api_cache where source='rentcast' and key=?", (k,)).fetchone()
    if (refresh or not hit) and net.usage(c, "rentcast") >= allowance():
        raise OverBudget(f"RentCast budget reached ({allowance()} calls this month). Raise it in Settings.")
    r = net.cached(c, "rentcast", url, params, {"X-Api-Key": key, "Accept": "application/json"}, refresh=refresh, cost=1)
    if r["status"] >= 400:
        msg = r["data"].get("message") if isinstance(r["data"], dict) else None
        raise RuntimeError(f"RentCast {r['status']}: {msg or r['data']}")
    return r


# ---------- normalisers: RentCast JSON → InvestStack rows ----------

def prop_row(p: dict) -> dict:
    return {
        "address": p.get("formattedAddress") or p.get("addressLine1"), "city": p.get("city"), "state": p.get("state"),
        "zip": p.get("zipCode"), "county": p.get("county"), "lat": p.get("latitude"), "lon": p.get("longitude"),
        "type": p.get("propertyType"), "beds": p.get("bedrooms"), "baths": p.get("bathrooms"),
        "sqft": p.get("squareFootage"), "lot": p.get("lotSize"), "year_built": p.get("yearBuilt"),
        "units": (p.get("features") or {}).get("unitCount") or 1,
        "last_sale_price": p.get("lastSalePrice"), "last_sale_date": (p.get("lastSaleDate") or "")[:10] or None,
        "owner_name": ", ".join((p.get("owner") or {}).get("names") or []) or None,
        "owner_occupied": None if p.get("ownerOccupied") is None else int(bool(p.get("ownerOccupied"))),
        "source": "RentCast",
    }


def taxes(p: dict) -> list[dict]:
    out = {}
    for y, t in (p.get("taxAssessments") or {}).items():
        out.setdefault(int(y), {}).update(year=int(y), assessed_total=t.get("value"), assessed_land=t.get("land"),
                                          assessed_impr=t.get("improvements"))
    for y, t in (p.get("propertyTaxes") or {}).items():
        out.setdefault(int(y), {}).update(year=int(y), tax_amount=t.get("total"))
    return sorted(out.values(), key=lambda x: x["year"])


def history(p: dict) -> list[dict]:
    return [{"date": (h.get("date") or d)[:10], "price": h.get("price"), "kind": h.get("event") or "Sale"}
            for d, h in (p.get("history") or {}).items()]


def comp_row(x: dict, kind: str) -> dict:
    return {"kind": kind, "address": x.get("formattedAddress"), "lat": x.get("latitude"), "lon": x.get("longitude"),
            "price": x.get("price"), "beds": x.get("bedrooms"), "baths": x.get("bathrooms"), "sqft": x.get("squareFootage"),
            "lot": x.get("lotSize"), "year_built": x.get("yearBuilt"),
            "date": (x.get("removedDate") or x.get("listedDate") or x.get("lastSeenDate") or "")[:10] or None,
            "distance": x.get("distance"), "days_old": x.get("daysOld"), "correlation": x.get("correlation"),
            "source": "RentCast"}


def listing_row(x: dict, kind: str) -> tuple[dict, dict]:
    prop = prop_row(x)
    lst = {"kind": kind, "price": x.get("price"), "status": x.get("status"), "listed": (x.get("listedDate") or "")[:10] or None,
           "removed": (x.get("removedDate") or "")[:10] or None, "dom": x.get("daysOnMarket"), "source": "RentCast"}
    return prop, lst
