"""The Overview dashboard and the Properties register: everything tracked, in one read.

Portfolio value history is an estimate: each owned property's current value scaled back in time by its ZIP's
Zillow home-value index (so the shape is the market's, the level is the property's). Months before a purchase
are excluded. The projection extends 12 months at the ZIP index's last 12-month rate and is flagged projected.
"""
from __future__ import annotations

from datetime import date

from . import db as D, pipeline, portfolio, props, uw
from .sources import zillow

ACTIVE = ("discovered", "researching", "underwriting", "diligence", "offer")


def asset_class(p: dict) -> str:
    t = (p.get("type") or "").lower()
    u = p.get("units") or 1
    if "multi" in t or u > 1:
        return "Multifamily" if u >= 5 else "Small multifamily"
    if "condo" in t or "town" in t:
        return "Condo / townhouse"
    if any(k in t for k in ("retail", "office", "industrial", "commercial", "mixed")):
        return (p.get("type") or "Commercial").title()
    if "land" in t:
        return "Land"
    return "Single family"


def _ym(d: date, back: int) -> str:
    y, m = d.year, d.month - back
    while m <= 0:
        y, m = y - 1, m + 12
    while m > 12:
        y, m = y + 1, m - 12
    return f"{y}-{m:02d}"


def _index(c, zip_: str | None) -> dict:
    if not zip_:
        return {}
    return {r["date"][:7]: r["value"] for r in zillow.series(c, "zip", zip_, "zhvi")}


def value_history(c, owned: list[dict], today: date, months: int = 60, ahead: int = 12) -> list[dict]:
    idx = {p["id"]: _index(c, p.get("zip")) for p in owned}
    debts = {p["id"]: D.rows(c, "select * from debt where property_id=?", (p["id"],)) for p in owned}
    out = []
    for k in range(months - 1, -ahead - 1, -1):
        ym = _ym(today, k)
        y, m = int(ym[:4]), int(ym[5:])
        val = debt = 0.0
        n = indexed = 0
        for p in owned:
            if not p.get("value") or (p.get("purchase_date") and p["purchase_date"][:7] > ym):
                continue
            ix = idx[p["id"]]
            last = max(ix) if ix else None
            if ix and last:
                indexed += ym >= min(ix)
                if ym <= last:
                    near = ix.get(ym) or next((ix[x] for x in sorted(ix) if x >= ym), ix[last])
                    v = p["value"] * near / ix[last]
                else:  # after the index ends: extend at its last 12-month rate
                    prev = ix.get(_ym(date(int(last[:4]), int(last[5:]), 1), 12))
                    g = (ix[last] / prev) ** (1 / 12) if prev else 1.0
                    ahead_m = (y - int(last[:4])) * 12 + m - int(last[5:])
                    v = p["value"] * g ** ahead_m
            else:
                v = p["value"]
            val += v
            n += 1
            for d in debts[p["id"]]:
                if str(d.get("start") or "")[:7] <= ym:
                    debt += portfolio.debt_state(d, date(y, m, 28))["balance"]
        if n:
            out.append({"month": ym, "value": val, "debt": debt, "equity": val - debt, "n": n,
                        "indexed": indexed, "projected": k < 0})
    return out


def _deal_irr(c, d: dict, ctx: dict) -> dict:
    p = props.get(c, d["property_id"]) or {}
    price = d.get("offer") or d.get("ask")
    r = props.rent_est(c, p) if p else None
    if not price or not r:
        return {}
    try:
        a = uw.analyse(props.default_deal(c, p, price, r["value"], ctx))
    except Exception:
        return {}
    return {"irr": a.get("irr"), "cap": a.get("cap"), "coc": a.get("coc"), "noi": a.get("noi")}


def build(c) -> dict:
    today = date.today()
    pf = portfolio.overview(c)
    owned, tot = pf["properties"], pf["total"]
    board = pipeline.board(c)
    ctx = props.context(c)
    deals = []
    for d in board["deals"]:
        x = {**d, "asset_class": asset_class(d)}
        if d["stage"] in ACTIVE:
            x.update(_deal_irr(c, d, ctx))
            x["days_in_stage"] = (today - date.fromisoformat(str(d["stage_entered"])[:10])).days if d.get("stage_entered") else None
        deals.append(x)
    active = [d for d in deals if d["stage"] in ACTIVE]
    irrs = [d["irr"] for d in active if d.get("irr") is not None]

    hist = value_history(c, owned, today)
    past = [h for h in hist if not h["projected"]]
    has_comparable_history = len(past) > 12 and all(
        point["indexed"] == point["n"] == len(owned) for point in (past[-1], past[-13])
    )
    v_now = past[-1]["value"] if has_comparable_history else None
    v_12 = past[-13]["value"] if has_comparable_history else None
    mon = portfolio.monthly(c, 36, today)
    noi_12 = sum(m["noi"] for m in mon[-13:-1]) if len(mon) > 12 else None
    noi_prev = sum(m["noi"] for m in mon[-25:-13]) if len(mon) > 24 else None

    # attention: things that need a decision
    attention = []
    for p in owned:
        if p.get("arrears", 0) > 0:
            attention.append({"kind": "arrears", "property_id": p["id"], "address": p["address"], "text": "Rent owed", "value": p["arrears"], "go": "ledger"})
        if p["vacant"]:
            attention.append({"kind": "vacancy", "property_id": p["id"], "address": p["address"], "text": f"{p['vacant']} vacant unit(s)", "value": None, "go": "rentroll"})
        if p.get("dscr") is not None and p["dscr"] < 1.1:
            attention.append({"kind": "dscr", "property_id": p["id"], "address": p["address"], "text": f"Debt cover {p['dscr']:.2f}×", "value": None, "go": "portfolio"})
    for e in pf["expiring"]:
        if e["days"] <= 60:
            attention.append({"kind": "lease", "property_id": e["property_id"], "address": e["address"],
                              "text": f"Lease {'expired' if e['days'] < 0 else 'ends'} {e['end']} ({e['unit']})", "value": e["rent"], "go": "rentroll"})
    overdue = [t for t in board["tasks"] if t.get("due") and t["due"] < today.isoformat()]
    for t in overdue[:6]:
        attention.append({"kind": "task", "property_id": t.get("property_id"), "address": t.get("address"), "text": f"Overdue: {t['title']}", "value": None, "go": "pipeline"})

    # opportunities: the listings search already scores every listing
    listings = props.search_listings(c, {"kind": "sale"})["rows"]
    in_pipe = {d["property_id"] for d in deals}
    opp = sorted((r for r in listings if r.get("score") is not None), key=lambda r: -r["score"])
    top_opp = [{"property_id": r["id"], "address": r["address"], "asset_class": asset_class(r), "price": r.get("price"), "cap": r.get("cap"),
                "coc": r.get("coc"), "score": r.get("score"), "lat": r.get("lat"), "lon": r.get("lon"),
                "status": "In pipeline" if r["id"] in in_pipe else "Listed"} for r in opp[:8]]

    by_class = {}
    for p in owned:
        a = by_class.setdefault(asset_class(p), {"asset_class": asset_class(p), "value": 0, "noi": 0, "n": 0, "pipeline": 0, "deals": 0})
        a["value"] += p.get("value") or 0
        a["noi"] += p.get("noi") or 0
        a["n"] += 1
    for d in active:
        a = by_class.setdefault(d["asset_class"], {"asset_class": d["asset_class"], "value": 0, "noi": 0, "n": 0, "pipeline": 0, "deals": 0})
        a["pipeline"] += d.get("ask") or 0
        a["deals"] += 1

    points = ([{"id": p["id"], "lat": p.get("lat"), "lon": p.get("lon"), "kind": "owned", "address": p["address"], "value": p.get("value"),
                "metric": p.get("cap_on_value")} for p in owned]
              + [{"id": d["property_id"], "lat": d.get("lat"), "lon": d.get("lon"), "kind": "deal", "address": d["address"], "value": d.get("ask"),
                  "stage": d["stage"], "metric": d.get("cap")} for d in active]
              + [{"id": r["property_id"], "lat": r["lat"], "lon": r["lon"], "kind": "opportunity", "address": r["address"], "value": r["price"],
                  "metric": r["cap"], "score": r["score"]} for r in top_opp if r["property_id"] not in in_pipe])

    activity = []
    for e in D.rows(c, """select e.ts, e.kind, e.text, p.address, p.id as property_id from deal_event e join deal d on d.id=e.deal_id
        join property p on p.id=d.property_id order by e.ts desc, e.id desc limit 14"""):
        activity.append({"ts": e["ts"], "kind": "deal", "text": e["text"], "address": e["address"], "property_id": e["property_id"]})
    for v in D.rows(c, """select v.as_of, v.value, v.source, p.address, p.id as property_id from valuation v join property p on p.id=v.property_id
        where v.kind='value' and (p.owned=1 or p.id in (select property_id from deal)) order by v.id desc limit 6"""):
        activity.append({"ts": v["as_of"], "kind": "valuation", "text": f"Value estimate ${v['value']:,.0f} ({v['source']})", "address": v["address"], "property_id": v["property_id"]})
    for d in D.rows(c, "select imported, name, kind from document order by imported desc limit 5"):
        activity.append({"ts": d["imported"], "kind": "document", "text": f"Imported {d['name']} ({d['kind']})", "address": None, "property_id": None})
    activity.sort(key=lambda a: str(a["ts"] or ""), reverse=True)
    upcoming = [{"due": t["due"], "title": t["title"], "address": t.get("address"), "property_id": t.get("property_id"), "kind": "task"}
                for t in board["tasks"] if t.get("due") and t["due"] >= today.isoformat()][:8]
    upcoming += [{"due": e["end"], "title": f"Lease ends: {e['tenant'] or e['unit']}", "address": e["address"], "property_id": e["property_id"], "kind": "lease"}
                 for e in pf["expiring"] if e["days"] >= 0]
    upcoming.sort(key=lambda x: x["due"])

    tracked = c.execute("select count(*) from property").fetchone()[0]
    budget_nets = [p["budget_net_month"] for p in owned if p["budget_net_month"] is not None]
    return {
        "metrics": {
            "tracked": tracked, "owned": len(owned), "listings": len(listings),
            "pipeline_value": sum(d.get("ask") or 0 for d in active), "active_deals": len(active),
            "portfolio_value": tot["value"] if any(p.get("value") is not None for p in owned) else None,
            "budget_net_month": round(sum(budget_nets), 2) if budget_nets else None,
            "budgeted_properties": len(budget_nets),
            "value_chg_12m": (v_now / v_12 - 1) if v_now and v_12 else None,
            "equity": tot["equity"] if owned else None, "ltv": tot.get("ltv"),
            "avg_irr": sum(irrs) / len(irrs) if irrs else None, "irr_n": len(irrs),
            "noi": noi_12 if noi_12 is not None else (tot["noi"] if owned else None),
            "noi_chg": (noi_12 / noi_prev - 1) if noi_12 and noi_prev and noi_prev > 0 else None,
            "cash_flow": tot["cf"] if owned else None, "occupancy": tot.get("occupancy"), "attention": len(attention),
        },
        "history": hist, "monthly": mon, "by_class": sorted(by_class.values(), key=lambda a: -(a["value"] + a["pipeline"])),
        "owned": [{"property_id": p["id"], "address": p["address"], "asset_class": asset_class(p), "value": p.get("value"), "noi": p.get("noi"),
                   "income": p["income"], "opex": p["opex"], "debt_service": p["ds"], "budget": p["budget"],
                   "cap": p.get("cap_on_value"), "cf": p.get("cf"), "dscr": p.get("dscr"), "occupancy": p.get("occupancy"),
                   "gain": (p["gain"] / p["cost"]) if p.get("gain") is not None and p.get("cost") else None, "arrears": p.get("arrears")} for p in owned],
        "deals": [{"id": d["id"], "property_id": d["property_id"], "address": d["address"], "asset_class": d["asset_class"], "stage": d["stage"],
                   "ask": d.get("ask"), "offer": d.get("offer"), "irr": d.get("irr"), "cap": d.get("cap"), "coc": d.get("coc"),
                   "days_in_stage": d.get("days_in_stage"), "open_tasks": d.get("open_tasks"), "next_due": d.get("next_due")} for d in deals],
        "stages": board["stages"], "opportunities": top_opp, "attention": attention, "points": points,
        "activity": activity[:16], "upcoming": upcoming[:10], "ctx": ctx,
        "illustrative": bool(owned and any((p.get("source") == "DEMO") for p in owned)),
    }


def register(c) -> list[dict]:
    """Every tracked property with its status: owned, in the pipeline (stage), or listed."""
    rows = D.rows(c, """select p.*, d.stage, d.id as deal_id, d.ask, d.offer,
        (select price from listing l where l.property_id=p.id and coalesce(l.status,'Active')='Active' order by l.id desc limit 1) as price,
        (select value from valuation v where v.property_id=p.id and v.kind='value' order by v.id desc limit 1) as value_est,
        (select value from valuation v where v.property_id=p.id and v.kind='rent' order by v.id desc limit 1) as rent_est,
        (select exists(select 1 from owned where property_id=p.id)) as has_owned_record,
        (select assessed_total from parcel a where a.property_id=p.id order by a.year desc limit 1) as assessed
        from property p left join deal d on d.property_id=p.id order by p.owned desc, (d.id is not null) desc, p.id desc limit 3000""")
    budgets = {}
    for item in portfolio.budget_rows(c):
        budgets.setdefault(item["property_id"], []).append(item)
    for r in rows:
        budget = budgets.get(r["id"], [])
        r["reported_rent"] = portfolio.monthly_budget(budget, "rent")
        r["budget_net_month"] = portfolio.monthly_net(budget)
        if (r.get("state") or "").upper() == "BC":
            estimate = props.value_est(c, r["id"])
            if estimate:
                r["value_est"] = estimate["value"]
                r["value_source"] = estimate["source"]
                r["value_is_assessed"] = estimate.get("basis") == "assessment"
        r["asset_class"] = asset_class(r)
        r["status"] = "Owned" if r["owned"] else pipeline.STAGE_LABEL.get(r["stage"], r["stage"]) if r.get("stage") else "Listed" if r.get("price") else "Tracked"
        r["status_kind"] = "owned" if r["owned"] else "deal" if r.get("stage") else "listed" if r.get("price") else "tracked"
        basis = (r.get("value_est") if r["owned"] else None) or r.get("price") or r.get("ask") or r.get("value_est")
        rent = r["reported_rent"] if r["reported_rent"] is not None else r["rent_est"]
        r["cap_gross"] = (rent * 12 / basis) if rent is not None and basis else None
    return rows
