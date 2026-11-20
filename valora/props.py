"""Properties: lookup, profile, listings search, comps, value/rent estimates, default underwriting and the
opportunity score. Every figure carries its source; nothing is invented when data is missing (it stays None
and the page says what is missing)."""
from __future__ import annotations

import inspect
import json
import math
import re
from dataclasses import asdict
from datetime import date

from . import config, db as D, net, portfolio, property_data, uw
from .sources import census_geo, fred, municipal, rentcast, zillow

DEFAULT_WEIGHTS = {"cashflow": 25, "cap": 20, "discount": 20, "momentum": 15, "negotiable": 10, "risk": 10}
FACTORS = {
    "cashflow": "Cash-on-cash return at the default financing",
    "cap": "Cap rate at the asking price",
    "discount": "Asking price below the value estimate",
    "momentum": "ZIP home values and rents over the last year",
    "negotiable": "Days on market (longer = more room to negotiate)",
    "risk": "Data confidence, building age and estimate range",
}


# ---------- storage ----------

def upsert(c, row: dict) -> int:
    cols = D.columns(c, "property")
    row = {k: v for k, v in row.items() if v is not None and k in cols and k not in ("id", "address_norm")}
    n = D.norm_address(row.get("address") or "")
    if not n:
        raise ValueError("an address is required")
    have = D.one(c, "select id from property where address_norm=?", (n,))
    row["fetched_at"] = row.get("fetched_at") or net.now()
    if have:
        D.update(c, "property", have["id"], {k: v for k, v in row.items() if k != "address"})
        return have["id"]
    return D.insert(c, "property", {**row, "address_norm": n})


def get(c, pid: int) -> dict | None:
    return D.one(c, "select * from property where id=?", (pid,))


def find(c, q: str) -> list[dict]:
    q = (q or "").strip()
    if not q:
        return []
    if q.isdigit():
        pid = int(q) if len(q) < 16 else -1
        return D.rows(c, "select * from property where id=? or zip=? limit 50", (pid, q))
    def like(x):                                    # '%' and '_' typed by the user are literal, not wildcards
        return "%" + x.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    n = D.norm_address(q)
    return D.rows(c, "select * from property where (? != '' and address_norm like ? escape '\\') or city like ? escape '\\' "
                     "order by owned desc, id desc limit 50", (n, like(n), like(q)))


# ---------- lookup ----------

def lookup_bc_property(c, address: str, *, existing: dict | None = None) -> dict:
    notes = []
    try:
        match = municipal.automatic_match(c, address)
    except ValueError as error:
        match = None
        notes.append(str(error))
    if match:
        canonical = D.one(c, "select id from property where address_norm=?", (D.norm_address(match["address"]),))
        pid = existing["id"] if existing else canonical["id"] if canonical else upsert(c, {"address": address, "state": "BC"})
        saved = municipal.store(c, pid, match)
        notes.append(saved.get("error") or f"Municipal facts added · {match['source']}")
    else:
        result = property_data.lookup_bc(c, address)
        exact = [m for m in result.get("matches", []) if m["score"] == 100]
        if len(exact) == 1:
            canonical = D.one(c, "select id from property where address_norm=?", (D.norm_address(exact[0]["address"]),))
            pid = existing["id"] if existing else canonical["id"] if canonical else upsert(c, {"address": address, "state": "BC"})
            saved = property_data.save_bc(c, pid, address, exact[0]["site"])
            notes.append(saved.get("error") or "Location matched · B.C. Address Geocoder")
        else:
            pid = existing["id"] if existing else upsert(c, {"address": address, "state": "BC"})
            notes.append(result.get("error") or "No unique public address match was found.")
    return {"id": pid, "notes": notes}


def save_owned_address(c, address: str, existing: dict | None = None) -> dict:
    if (existing and (existing.get("state") or "").upper() == "BC") or municipal.is_bc_address(address):
        return lookup_bc_property(c, address, existing=existing)
    if existing:
        return {"id": existing["id"], "notes": []}
    if re.search(r"(?:\bUSA|\bUnited States|,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)\s*$", address, re.I):
        location = census_geo.geocode(c, address)
        if location:
            return {"id": upsert(c, location), "notes": ["Location matched · " + location["source"]]}
    return {"id": upsert(c, {"address": address}), "notes": ["Property saved · public facts unavailable for this address"]}


def lookup(c, address: str, refresh: bool = False) -> dict:
    """Resolve an address: geocode (free), then RentCast record + value + rent estimates when a key is set."""
    if municipal.is_bc_address(address):
        return lookup_bc_property(c, address)
    notes = []
    g = census_geo.geocode(c, address)
    base = {"address": address}
    if g:
        base.update({k: g.get(k) for k in ("address", "lat", "lon", "zip", "state", "city", "county", "county_fips")})
        base["address"] = g["address"].title() if g["address"].isupper() else g["address"]
    else:
        notes.append("The address could not be geocoded; check the spelling.")
    pid = upsert(c, {**base, "source": base.get("source") or (g or {}).get("source")})
    try:
        r = rentcast.call(c, "/properties", {"address": address}, refresh)
        recs = r["data"] if isinstance(r["data"], list) else []
        if recs:
            p = recs[0]
            upsert(c, {**rentcast.prop_row(p), "address": base["address"]})
            c.execute("delete from parcel where property_id=? and source='RentCast'", (pid,))
            for t in rentcast.taxes(p):
                D.insert(c, "parcel", {**t, "property_id": pid, "source": "RentCast"})
            c.execute("delete from sale_history where property_id=? and source='RentCast'", (pid,))
            for h in rentcast.history(p):
                D.insert(c, "sale_history", {**h, "property_id": pid, "source": "RentCast"})
        estimate(c, pid, refresh)
    except (rentcast.NoKey, rentcast.OverBudget) as e:
        notes.append(str(e))
    except Exception as e:  # network or API error: keep what we have
        notes.append(f"RentCast: {e}")
    return {"id": pid, "notes": notes}


def estimate(c, pid: int, refresh: bool = False) -> None:
    p = get(c, pid)
    for kind, path in (("value", "/avm/value"), ("rent", "/avm/rent/long-term")):
        r = rentcast.call(c, path, {"address": p["address"], "propertyType": p.get("type"), "bedrooms": p.get("beds"),
                                    "bathrooms": p.get("baths"), "squareFootage": p.get("sqft"), "compCount": 15}, refresh)
        d = r["data"] or {}
        v = d.get("price") if kind == "value" else d.get("rent")
        lo = d.get("priceRangeLow") if kind == "value" else d.get("rentRangeLow")
        hi = d.get("priceRangeHigh") if kind == "value" else d.get("rentRangeHigh")
        comps = d.get("comparables") or []
        c.execute("delete from valuation where property_id=? and kind=? and source='RentCast'", (pid, kind))
        if v:
            D.insert(c, "valuation", {"property_id": pid, "kind": kind, "value": v, "low": lo, "high": hi, "n": len(comps),
                                      "source": "RentCast AVM", "as_of": r["fetched_at"][:10]})
        c.execute("delete from comp where subject_id=? and kind=? and source='RentCast'", (pid, "sale" if kind == "value" else "rent"))
        for x in comps:
            D.insert(c, "comp", {**rentcast.comp_row(x, "sale" if kind == "value" else "rent"), "subject_id": pid})


# ---------- listings search ----------

def search_listings(c, q: dict, refresh: bool = False) -> dict:
    """Search listings. With a key and a city/zip, pulls fresh active listings from RentCast (one call per page),
    then filters what is stored locally. Without a key, filters what is stored (the demo workspace has a market)."""
    notes = []
    kind = q.get("kind") or "sale"
    if q.get("fetch") and (q.get("zip") or q.get("city")):
        try:
            path = "/listings/sale" if kind == "sale" else "/listings/rental/long-term"
            r = rentcast.call(c, path, {"zipCode": q.get("zip"), "city": q.get("city"), "state": q.get("state"),
                                        "status": "Active", "limit": 500, "propertyType": q.get("rc_type")}, refresh)
            for x in (r["data"] if isinstance(r["data"], list) else []):
                prop, lst = rentcast.listing_row(x, kind)
                if not D.norm_address(prop.get("address") or ""):
                    continue
                pid = upsert(c, prop)
                c.execute("delete from listing where property_id=? and kind=? and source='RentCast'", (pid, kind))
                D.insert(c, "listing", {**lst, "property_id": pid, "fetched_at": r["fetched_at"]})
            notes.append(f"{len(r['data'] if isinstance(r['data'], list) else [])} listings {'from cache' if r['cached'] else 'downloaded'} ({r['fetched_at'][:10]})")
        except (rentcast.NoKey, rentcast.OverBudget) as e:
            notes.append(str(e))
        except Exception as e:
            notes.append(f"RentCast: {e}")
    where, args = ["l.kind=?", "coalesce(l.status,'Active')='Active'"], [kind]
    for k, col, op in (("min_price", "l.price", ">="), ("max_price", "l.price", "<="), ("min_beds", "p.beds", ">="),
                       ("min_baths", "p.baths", ">="), ("min_sqft", "p.sqft", ">="), ("max_sqft", "p.sqft", "<="),
                       ("min_year", "p.year_built", ">="), ("min_units", "p.units", ">=")):
        v = _num(q.get(k))
        if v is not None:
            where.append(f"{col} {op} ?")
            args.append(v)
    if q.get("zip"):
        where.append("p.zip=?"); args.append(q["zip"])
    if q.get("city"):
        where.append("lower(p.city)=lower(?)"); args.append(q["city"])
    if q.get("type"):
        where.append("p.type=?"); args.append(q["type"])
    rows = D.rows(c, f"""select p.*, l.price, l.status, l.listed, l.dom, l.source as l_source, l.id as listing_id
        from listing l join property p on p.id=l.property_id where {' and '.join(where)} order by l.listed desc limit 2000""", args)
    ctx = context(c)
    w = weights(c)
    for r in rows:
        r.update(quick(c, r, ctx, w))
    return {"rows": rows, "notes": notes, "weights": w}


def _num(v) -> float | None:
    """A finite number from a query/body value, or None for '', None, 'abc', NaN, inf."""
    if v is None or isinstance(v, bool) or (isinstance(v, str) and not v.strip()):
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


# ---------- estimates and quick underwriting ----------

def context(c) -> dict:
    m = fred.latest(c, "MORTGAGE30US")
    return {"rate": (m["value"] / 100 + 0.0075) if m else 0.0775, "rate_src": f"FRED 30y {m['value']:.2f}% + 0.75 investor" if m else "default 7.75%"}


def value_est(c, pid: int) -> dict | None:
    owned_value = D.one(c, """select o.value_est as value, coalesce(o.value_src, 'your estimate') as source
        from owned o join property p on p.id=o.property_id
        where o.property_id=? and upper(p.state)='BC' and o.value_est>0""", (pid,))
    latest = D.one(c, "select * from valuation where property_id=? and kind='value' order by id desc limit 1", (pid,))
    if owned_value:
        return owned_value
    if latest and re.search(r"\byour\b|\bmanual\b", latest["source"] or "", re.I):
        return latest
    assessment = portfolio.assessed_value(c, pid)
    return assessment if assessment and config.load().get("currency") == "CAD" else latest


def rent_est(c, p: dict) -> dict | None:
    """Rent estimate: RentCast rent AVM; else the ZIP's Zillow rent index scaled by bedrooms (flagged as rough)."""
    v = D.one(c, "select * from valuation where property_id=? and kind='rent' order by id desc limit 1", (p["id"],))
    if v:
        return v
    reported = portfolio.monthly_budget(portfolio.budget_rows(c, p["id"]), "rent")
    if reported is not None:
        return {"value": reported, "source": "your reported rent", "as_of": None, "n": 0}
    if p.get("zip"):
        z = D.one(c, "select latest, as_of from market_snap where geo_type='zip' and geo_id=? and metric='zori'", (p["zip"],))
        if z and z["latest"]:
            b = _num(p.get("beds"))
            beds = b if b is not None and b >= 0 else 2                               # 0 = studio
            u = _num(p.get("units"))
            units = int(u) if u and u >= 1 else 1
            per = z["latest"] * {0: 0.75, 1: 0.85, 2: 1.0, 3: 1.18, 4: 1.32}.get(int(min(4, beds / units if units > 1 else beds)), 1.4)
            return {"value": per * units, "low": per * units * 0.85, "high": per * units * 1.15, "n": 0,
                    "source": "Zillow ZORI (ZIP) × bedroom factor — rough", "as_of": z["as_of"]}
    return None


def tax_year(c, p: dict, price: float) -> tuple[float, str]:
    t = D.one(c, "select tax_amount, year from parcel where property_id=? and tax_amount is not null order by year desc limit 1", (p["id"],))
    if t:
        return t["tax_amount"], f"{t['year']} tax bill"
    taxes = next((item for item in portfolio.budget_rows(c, p["id"]) if item["kind"] == "expense"
                  and item["name"].casefold() == "property tax"), None)
    if taxes:
        return taxes["amount"] * (12 if taxes["cadence"] == "monthly" else 1), "your property tax budget"
    return price * 0.012, "1.2% of price (assumed)"


def default_deal(c, p: dict, price: float, rent: float, ctx: dict | None = None) -> uw.Deal:
    ctx = ctx or context(c)
    tax, _ = tax_year(c, p, price)
    return uw.Deal(price=price, rent_month=rent, taxes_year=tax, insurance_year=max(900, price * 0.005), rate=ctx["rate"])


def _lin(x, lo, hi):
    if x is None:
        return None
    return max(0.0, min(100.0, (x - lo) / (hi - lo) * 100))


def weights(c) -> dict:
    r = D.one(c, "select query from search where name='__weights'")
    try:
        w = json.loads(r["query"]) if r else {}
    except ValueError:
        w = {}
    out = dict(DEFAULT_WEIGHTS)
    for k in DEFAULT_WEIGHTS:
        v = _num(w.get(k)) if isinstance(w, dict) else None
        if v is not None:
            out[k] = max(0.0, v)
    return out


QUICK_KEYS = ("rent_est", "rent_src", "value_est", "ppsf", "cap", "coc", "cf", "dscr", "grm", "one_pct",
              "score", "score_parts", "discount", "momentum")


def quick(c, p: dict, ctx: dict | None = None, w: dict | None = None) -> dict:
    """Asking-price underwriting and the explainable score for a listing row. Missing inputs give None fields."""
    out = dict.fromkeys(QUICK_KEYS)
    price = _num(p.get("price"))
    if not price or price <= 0:
        return out
    re_ = rent_est(c, p)
    ve = value_est(c, p["id"])
    out.update({"rent_est": re_["value"] if re_ else None, "rent_src": re_["source"] if re_ else None,
                "value_est": ve["value"] if ve else None, "ppsf": price / _num(p.get("sqft")) if _num(p.get("sqft")) else None})
    if re_ and re_.get("value"):
        a = uw.analyse(default_deal(c, p, price, re_["value"], ctx))
        out.update(cap=a["cap"], coc=a["coc"], cf=a["cash_flow_month"], dscr=a["dscr"], grm=a["grm"], one_pct=a["one_pct"])
    zs = {m: D.one(c, "select chg1y from market_snap where geo_type='zip' and geo_id=? and metric=?", (p.get("zip"), m))
          for m in ("zhvi", "zori")}
    hv, rv = (zs["zhvi"] or {}).get("chg1y"), (zs["zori"] or {}).get("chg1y")
    mom = None if hv is None and rv is None else ((hv or 0) + (rv or 0)) / (2 if hv is not None and rv is not None else 1)
    disc = (ve["value"] / price - 1) if ve and ve.get("value") else None
    yb = _num(p.get("year_built"))
    age = (date.today().year - yb) if yb else None
    width = ((re_["high"] - re_["low"]) / re_["value"]) if re_ and re_.get("high") is not None and re_.get("low") is not None and re_.get("value") else None
    conf = 100.0
    if not ve: conf -= 25
    if re_ and "rough" in (re_.get("source") or ""): conf -= 25
    if width: conf -= min(30, width * 60)
    if age and age > 60: conf -= min(20, (age - 60) / 2)
    parts = {"cashflow": _lin(out.get("coc"), -0.05, 0.12), "cap": _lin(out.get("cap"), 0.03, 0.10),
             "discount": _lin(disc, -0.10, 0.15), "momentum": _lin(mom, -0.04, 0.08),
             "negotiable": _lin(_num(p.get("dom")), 0, 120), "risk": max(0.0, conf)}
    w = w or weights(c)
    have = {k: v for k, v in parts.items() if v is not None}
    tw = sum(w.get(k, 0) for k in have)
    out["score"] = sum(v * w.get(k, 0) for k, v in have.items()) / tw if tw else None
    out["score_parts"] = parts
    out["discount"] = disc
    out["momentum"] = mom
    return out


# ---------- profile ----------

def profile(c, pid: int) -> dict | None:
    p = get(c, pid)
    if not p:
        return None
    lst = D.one(c, "select * from listing where property_id=? order by (status='Active') desc, listed desc limit 1", (pid,))
    if lst:
        p["price"], p["dom"], p["status"] = lst["price"], lst["dom"], lst["status"]
    ctx = context(c)
    zip_snap = {r["metric"]: r for r in D.rows(c, "select * from market_snap where geo_type='zip' and geo_id=?", (p.get("zip"),))}
    prof = {
        "property": p, "listing": lst, "listings": D.rows(c, "select * from listing where property_id=? order by listed desc", (pid,)),
        "parcels": D.rows(c, "select * from parcel where property_id=? order by year", (pid,)),
        "sales": D.rows(c, "select * from sale_history where property_id=? order by date desc", (pid,)),
        "value": value_est(c, pid), "rent": rent_est(c, p),
        "comps": D.rows(c, "select * from comp where subject_id=? order by kind, distance", (pid,)),
        "zip": zip_snap,
        "zhvi": zillow.series(c, "zip", p["zip"], "zhvi")[-120:] if p.get("zip") else [],
        "zori": zillow.series(c, "zip", p["zip"], "zori")[-120:] if p.get("zip") else [],
        "deal": D.one(c, "select * from deal where property_id=?", (pid,)),
        "scenarios": D.rows(c, "select * from scenario where property_id=? order by updated desc", (pid,)),
        "owned": D.one(c, "select * from owned where property_id=?", (pid,)),
        "budget": portfolio.budget_rows(c, pid),
        "sources": D.rows(c, "select id, kind, source, url, imported, fields from property_source where property_id=? order by imported desc, id desc", (pid,)),
        "docs": D.rows(c, "select id, name, kind, pages, imported, status from document where property_id=?", (pid,)),
        "ctx": ctx,
    }
    if lst and lst.get("price"):
        prof["quick"] = quick(c, p, ctx)
    prof["tax"] = dict(zip(("amount", "src"), tax_year(c, p, (lst or {}).get("price") or (prof["value"] or {}).get("value") or 0)))
    prof["missing"] = missing(prof)
    return prof


def missing(prof: dict) -> list[dict]:
    """What the profile lacks, where to get it, and what it changes. Never blocks the result."""
    p, out = prof["property"], []
    if not prof["value"]:
        out.append({"k": "Value estimate", "how": "Add a RentCast key (Settings), or add sold comps on the Comps page."})
    if not prof["rent"]:
        out.append({"k": "Rent estimate", "how": "Add a RentCast key, or enter the current rent roll / a rental comp."})
    elif "rough" in (prof["rent"].get("source") or ""):
        out.append({"k": "Property-level rent", "how": "Using the ZIP rent index. A RentCast rent estimate or the seller's rent roll is better."})
    if not prof["parcels"]:
        out.append({"k": "Tax bill", "how": f"Look up the parcel on the {p.get('county') or 'county'} assessor site; using {prof['tax']['src']} meanwhile."})
    if not p.get("sqft"):
        out.append({"k": "Living area", "how": "From the listing or the assessor record."})
    out.append({"k": "Insurance quote", "how": "Get a landlord-policy quote; using 0.5% of price meanwhile."})
    return out


# ---------- comps reconciliation ----------

def comps_analysis(c, pid: int) -> dict:
    p = get(c, pid)
    if not p:
        return {"sale": [], "rent": [], "value": None, "rent_value": None}
    comps = D.rows(c, "select * from comp where subject_id=? order by distance", (pid,))
    sale = [x for x in comps if x["kind"] == "sale"]
    rent = [x for x in comps if x["kind"] == "rent"]
    adj_s = []
    for x in sale:
        if not x.get("price"):
            continue
        a = uw.adjust_comp(p, x)
        a.update(id=x["id"], dist_mi=x.get("distance"), included=x["included"])
        adj_s.append(a)
    adj_r = []
    for x in rent:
        if not x.get("price"):
            continue
        a = uw.adjust_comp(p, x, bed=150, bath=75, age_year=3, lot_sqft=0.0)
        a.update(id=x["id"], dist_mi=x.get("distance"), included=x["included"])
        adj_r.append(a)
    return {"sale": adj_s, "rent": adj_r,
            "value": uw.reconcile([a for a in adj_s if a["included"]]),
            "rent_value": uw.reconcile([a for a in adj_r if a["included"]])}


def scenario_save(c, pid: int, name: str, strategy: str, inputs: dict, outputs: dict) -> int:
    have = D.one(c, "select id from scenario where property_id=? and name=?", (pid, name))
    if have:
        D.update(c, "scenario", have["id"], {"strategy": strategy, "inputs": inputs, "outputs": outputs, "updated": net.now()})
        return have["id"]
    return D.insert(c, "scenario", {"property_id": pid, "name": name, "strategy": strategy, "inputs": inputs, "outputs": outputs})


def _kwargs(fn, inputs: dict) -> dict:
    """Numeric keyword arguments for `fn` from page inputs: unknown keys, blanks and non-numbers are dropped."""
    sig = inspect.signature(fn).parameters
    out = {}
    for k, v in (inputs or {}).items():
        if k in sig:
            x = _num(v)
            if x is not None:
                out[k] = x
    for k, prm in sig.items():                      # required arguments left blank count as 0
        if prm.default is inspect.Parameter.empty and k not in out:
            out[k] = 0.0
    return out


def _bound(kw: dict) -> dict:
    """BRRRR / flip inputs: money within ±1e12, rates and ratios within 0..1 (years and months within 0..50 / 0..600)."""
    out = {}
    for k, v in kw.items():
        if k in ("months", "hold_months"):
            v = max(0.0, min(600.0, v))
        elif k == "years":
            v = max(1.0, min(50.0, v))
        elif k in ("refi_ltv", "refi_rate", "closing", "refi_cost", "sell_cost", "loan_ltc", "rate", "points"):
            v = max(0.0, min(1.0, v))
        else:
            v = max(-MONEY_MAX, min(MONEY_MAX, v))
        out[k] = v
    return out


def _flag(v) -> bool:
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on", "y")
    return bool(v)


# Sane bounds for page inputs: keeps float powers from overflowing and rates from reaching -100% (division by zero).
MONEY_MAX = 1e12
BOUNDS = {"vacancy": (0, 1), "mgmt": (0, 1), "maint": (0, 1), "capex": (0, 1), "closing": (0, 1), "down": (0, 1),
          "rate": (0, 1), "rent_growth": (-0.5, 1), "exp_growth": (-0.5, 1), "appreciation": (-0.5, 1), "exit_cap": (0, 1),
          "sell_cost": (0, 1)}
NUM_FIELDS = ("price", "rent_month", "other_income_month", "vacancy", "taxes_year", "insurance_year", "hoa_month", "mgmt",
              "maint", "capex", "utilities_month", "other_exp_year", "closing", "rehab", "down", "rate", "years",
              "rent_growth", "exp_growth", "appreciation", "exit_cap", "sell_cost")
METRICS = ("coc", "irr", "dscr", "cap", "cash_flow_month", "cash_flow", "noi", "multiple")


def underwrite(body: dict) -> dict:
    """Run the full underwriting from page inputs (all strategies). Blank or invalid inputs fall back to defaults."""
    s = body.get("strategy") or "rental"
    raw = body.get("inputs") if isinstance(body.get("inputs"), dict) else {}
    if s == "flip":
        kw = _bound(_kwargs(uw.flip, raw))
        if "months" in kw:
            kw["months"] = max(0, int(kw["months"]))
        return uw.flip(**kw)
    if s == "brrrr":
        kw = _bound(_kwargs(uw.brrrr, raw))
        if "hold_months" in kw:
            kw["hold_months"] = max(0, int(kw["hold_months"]))
        return uw.brrrr(**kw)
    inp = {}
    for k in NUM_FIELDS:
        x = _num(raw.get(k))
        if x is not None:
            lo, hi = BOUNDS.get(k, (-MONEY_MAX, MONEY_MAX))
            inp[k] = max(lo, min(hi, x))
    if inp.get("exit_cap") is not None and inp["exit_cap"] <= 0:
        inp["exit_cap"] = None
    if raw.get("io") not in (None, ""):
        inp["io"] = _flag(raw["io"])
    h = _num(raw.get("hold"))
    if h is not None:
        inp["hold"] = int(max(1, min(50, h)))
    if "years" in inp:
        inp["years"] = max(1.0, min(50.0, inp["years"]))
    inp.setdefault("price", 0.0)
    inp.setdefault("rent_month", 0.0)
    d = uw.Deal(**inp)
    a = uw.analyse(d)
    sens = body.get("sens") if isinstance(body.get("sens"), dict) else {}
    rk = sens.get("row") if sens.get("row") in NUM_FIELDS and getattr(d, sens.get("row")) is not None else "price"
    ck = sens.get("col") if sens.get("col") in NUM_FIELDS and getattr(d, sens.get("col")) is not None else "rent_month"
    metric = sens.get("metric") if sens.get("metric") in METRICS else "coc"
    def around(k):
        base = getattr(d, k)
        steps = [-0.10, -0.05, 0, 0.05, 0.10] if k in ("price", "rent_month", "rehab") else [-0.01, -0.005, 0, 0.005, 0.01]
        return [base * (1 + s_) if k in ("price", "rent_month", "rehab") else max(0.0, base + s_) for s_ in steps]
    a["sens"] = uw.sensitivity(d, (rk, around(rk)), (ck, around(ck)), metric)
    a["amort"] = uw.amortization(a["loan"], d.rate, d.years, d.io)
    for t in (0.06, 0.08, 0.10):
        a[f"offer_coc_{int(t * 100)}"] = uw.max_offer(d, "coc", t)
    a["offer_dscr_125"] = uw.max_offer(d, "dscr", 1.25)
    a["inputs"] = asdict(d)
    return a
