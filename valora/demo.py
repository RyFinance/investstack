"""The demo workspace (valora-demo.db): a made-up market and portfolio around Columbus, Ohio, so every page can be
tried before adding a RentCast key or your own files. Every row is marked DEMO and the app shows a DEMO banner.
Market indexes (Zillow, FRED) are real when they have been downloaded."""
from __future__ import annotations

import random
from datetime import date, timedelta

from . import db as D, pipeline, portfolio, props

ZIPS = {
    "43201": (39.990, -83.000, 330000, "Short North"), "43202": (40.020, -83.012, 360000, "Clintonville South"),
    "43206": (39.942, -82.975, 380000, "German Village"), "43207": (39.895, -82.965, 185000, "South Side"),
    "43211": (40.012, -82.970, 150000, "Linden"), "43214": (40.052, -83.020, 340000, "Clintonville"),
    "43219": (40.005, -82.925, 190000, "Northeast"), "43224": (40.040, -82.965, 175000, "North Linden"),
    "43229": (40.085, -82.975, 215000, "Northland"), "43204": (39.955, -83.075, 165000, "Hilltop"),
    "43205": (39.958, -82.965, 290000, "Olde Towne East"), "43223": (39.930, -83.040, 150000, "Hilltop South"),
}
STREETS = ["Oak", "Maple", "Elm", "Cedar", "Walnut", "Hickory", "Linden", "Summit", "Hudson", "Parsons", "Kelton",
           "Fairwood", "Westwood", "Greenway", "Ridgeview", "Brookside", "Lakeview", "Chestnut", "Highland", "Union",
           "Mound", "Sycamore", "Whittier", "Frebis", "Weber", "Arcadia", "Oakland Park", "Duxberry", "Medina", "Dana"]
SUFFIX = ["St", "Ave", "Rd", "Dr", "Pl", "Ct"]
TYPES = [("Single Family", 1, .62), ("Multi-Family", 2, .18), ("Multi-Family", 4, .06), ("Townhouse", 1, .08), ("Condo", 1, .06)]
FIRST = ["Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Avery", "Quinn", "Drew", "Sam", "Reese"]
LAST = ["Parker", "Brooks", "Hayes", "Ellis", "Bennett", "Reed", "Foster", "Sullivan", "Graham", "Wells", "Porter", "Shaw"]


def build(c, n_listings: int = 240, seed: int = 7) -> dict:
    rnd = random.Random(seed)
    for t in ("ledger_entry", "lease", "tenant", "unit", "expense", "debt", "maintenance", "owned", "task", "deal_event",
              "deal", "comp", "valuation", "listing", "parcel", "sale_history", "scenario", "bank_txn", "extraction",
              "document", "property"):
        c.execute(f"delete from {t}")
    today = date.today()
    used = set()

    def addr(z):
        while True:
            a = f"{rnd.randint(100, 4999)} {rnd.choice(STREETS)} {rnd.choice(SUFFIX)}"
            if a not in used:
                used.add(a)
                return a

    def mk(z, typ, units, price=None, listed=True):
        lat0, lon0, base, hood = ZIPS[z]
        beds = (rnd.choice([2, 3, 3, 3, 4, 4, 5]) if units == 1 else units * rnd.choice([2, 2, 3]))
        baths = max(1, min(beds, round(beds * rnd.uniform(.45, .75) * 2) / 2)) if units == 1 else units
        sqft = int((beds * rnd.uniform(380, 520) + 300) // 10 * 10)
        yb = rnd.choice([rnd.randint(1900, 1955), rnd.randint(1950, 1990), rnd.randint(1985, 2022)])
        px = price or round(base * (sqft / 1500) ** .8 * rnd.uniform(.82, 1.2) * (1 + .12 * (units > 1)) / 1000) * 1000
        a = addr(z)
        pid = props.upsert(c, {"address": f"{a}, Columbus, OH {z}", "city": "Columbus", "state": "OH", "zip": z,
                               "county": "Franklin County", "lat": lat0 + rnd.gauss(0, .011), "lon": lon0 + rnd.gauss(0, .014),
                               "type": typ, "beds": beds, "baths": baths, "sqft": sqft, "lot": int(rnd.uniform(3000, 9000)),
                               "year_built": yb, "units": units, "source": "DEMO", "tags": hood,
                               "last_sale_price": round(px * rnd.uniform(.55, .9) / 1000) * 1000,
                               "last_sale_date": (today - timedelta(days=rnd.randint(900, 5000))).isoformat()})
        val = px * rnd.uniform(.9, 1.12)
        rent_unit = (z_rent(base) * {1: .85, 2: 1.0, 3: 1.17, 4: 1.3, 5: 1.42}[min(5, max(1, beds // units))]) * rnd.uniform(.92, 1.08)
        rent = rent_unit * units
        D.insert(c, "valuation", {"property_id": pid, "kind": "value", "value": round(val, -3), "low": round(val * .9, -3),
                                  "high": round(val * 1.1, -3), "n": 12, "source": "DEMO estimate", "as_of": today.isoformat()})
        D.insert(c, "valuation", {"property_id": pid, "kind": "rent", "value": round(rent, -1), "low": round(rent * .9, -1),
                                  "high": round(rent * 1.1, -1), "n": 10, "source": "DEMO estimate", "as_of": today.isoformat()})
        tax = px * rnd.uniform(.011, .019)
        for y in (today.year - 2, today.year - 1):
            D.insert(c, "parcel", {"property_id": pid, "year": y, "assessed_total": round(val * .35, -2),
                                   "assessed_land": round(val * .08, -2), "assessed_impr": round(val * .27, -2),
                                   "tax_amount": round(tax * (.96 if y < today.year - 1 else 1), 2), "source": "DEMO"})
        D.insert(c, "sale_history", {"property_id": pid, "date": c.execute("select last_sale_date from property where id=?", (pid,)).fetchone()[0],
                                     "price": c.execute("select last_sale_price from property where id=?", (pid,)).fetchone()[0], "kind": "Sale", "source": "DEMO"})
        for kind in ("sale", "rent"):
            for _ in range(rnd.randint(6, 10)):
                cb = max(1, beds + rnd.choice([-1, 0, 0, 1]))
                cs = int(sqft * rnd.uniform(.8, 1.2))
                cp = (val * (cs / sqft) ** .8 * rnd.uniform(.9, 1.1)) if kind == "sale" else rent * rnd.uniform(.88, 1.1)
                D.insert(c, "comp", {"subject_id": pid, "kind": kind, "address": f"{addr(z)}, Columbus, OH {z}",
                                     "lat": lat0 + rnd.gauss(0, .01), "lon": lon0 + rnd.gauss(0, .012),
                                     "price": round(cp, -3 if kind == "sale" else -1), "beds": cb, "baths": baths, "sqft": cs,
                                     "lot": int(rnd.uniform(3000, 9000)), "year_built": yb + rnd.randint(-15, 15),
                                     "date": (today - timedelta(days=rnd.randint(10, 300))).isoformat(),
                                     "distance": round(rnd.uniform(.1, 1.5), 2), "days_old": rnd.randint(10, 300),
                                     "correlation": round(rnd.uniform(.85, .99), 3), "source": "DEMO"})
        if listed:
            D.insert(c, "listing", {"property_id": pid, "kind": "sale", "price": px, "status": "Active",
                                    "listed": (today - timedelta(days=rnd.randint(1, 140))).isoformat(),
                                    "dom": None, "source": "DEMO"})
        return pid, px, rent

    def z_rent(base):
        return 900 + base * .0032

    pids = []
    zs = list(ZIPS)
    for _ in range(n_listings):
        r, acc = rnd.random(), 0
        for typ, units, p in TYPES:
            acc += p
            if r <= acc:
                break
        pids.append(mk(rnd.choice(zs), typ, units))
    c.execute("update listing set dom = cast(julianday('now') - julianday(listed) as integer)")

    # pipeline
    for (pid, px, _), stage in zip(rnd.sample(pids, 9), ["discovered", "discovered", "researching", "researching",
                                                        "underwriting", "underwriting", "diligence", "offer", "rejected"]):
        did = pipeline.add(c, pid, "discovered", ask=px)
        for s in pipeline.STAGES[1:pipeline.STAGES.index(stage) + 1] if stage != "rejected" else ["researching", "rejected"]:
            pipeline.move(c, did, s, "Cap rate under 5% at ask" if s == "rejected" else "")
        if stage == "offer":
            D.update(c, "deal", did, {"offer": round(px * .93, -3)})
        for t in D.rows(c, "select id from task where deal_id=?", (did,))[:2]:
            c.execute("update task set done=1 where id=?", (t["id"],))

    # owned portfolio
    owned_specs = [("43206", "Multi-Family", 2, 315000, date(today.year - 4, 6, 15), [1450, 1500]),
                   ("43214", "Single Family", 1, 285000, date(today.year - 3, 3, 1), [2150]),
                   ("43211", "Multi-Family", 4, 420000, date(today.year - 2, 9, 1), [1050, 1100, 1150, None])]
    for z, typ, units, price, bought, rents in owned_specs:
        pid, _, _ = mk(z, typ, units, price=price, listed=False)
        c.execute("update property set owned=1 where id=?", (pid,))
        D.insert(c, "owned", {"property_id": pid, "purchase_price": price, "purchase_date": bought.isoformat(),
                              "closing_costs": round(price * .025), "rehab": 18000 if units == 4 else 6000})
        c.execute("delete from valuation where property_id=? and kind='value'", (pid,))
        D.insert(c, "valuation", {"property_id": pid, "kind": "value", "value": round(price * (1 + .045) ** (today.year - bought.year), -3),
                                  "low": None, "high": None, "n": 0, "source": "DEMO estimate", "as_of": today.isoformat()})
        rate = {2: .0425, 1: .0675, 4: .0725}[units]
        D.insert(c, "debt", {"property_id": pid, "lender": rnd.choice(["Huntington Bank", "Rocket Mortgage", "Fifth Third"]),
                             "principal": price * .75, "rate": rate, "years": 30, "start": bought.replace(day=1).isoformat(), "escrow": 0})
        for i, rent in enumerate(rents):
            uid = D.insert(c, "unit", {"property_id": pid, "name": ("Unit " + "ABCD"[i]) if units > 1 else "House",
                                       "beds": 2 if units > 1 else 3, "baths": 1 if units > 1 else 2,
                                       "market_rent": round((rent or 1100) * rnd.uniform(1.0, 1.08), -1),
                                       "status": "occupied" if rent else "vacant"})
            if not rent:
                D.insert(c, "maintenance", {"property_id": pid, "unit_id": uid, "title": "Turnover: paint and carpet", "status": "open",
                                            "priority": "high", "cost": 3200, "vendor": "Buckeye Painting"})
                continue
            tid = D.insert(c, "tenant", {"name": f"{rnd.choice(FIRST)} {rnd.choice(LAST)}", "email": "", "phone": ""})
            start = (bought + timedelta(days=rnd.randint(20, 75))).replace(day=1)
            end = portfolio.add_years(start, 1) - timedelta(days=1)
            while end < today - timedelta(days=60):
                end = portfolio.add_years(end + timedelta(days=1), 1) - timedelta(days=1)   # safe across 29 Feb
            lid = D.insert(c, "lease", {"unit_id": uid, "tenant_id": tid, "start": start.isoformat(), "end": end.isoformat(),
                                        "rent": rent, "deposit": rent, "due_day": 1, "late_fee": 75, "grace_days": 5,
                                        "escalation": 0.03, "status": "active"})
            late = (z == "43211" and i == 1)
            m = start
            while m <= today:
                pay_day = m + timedelta(days=rnd.randint(0, 3) if not late else rnd.randint(2, 12))
                if pay_day <= today and not (late and m >= (today.replace(day=1) - timedelta(days=40))):
                    D.insert(c, "ledger_entry", {"lease_id": lid, "date": pay_day.isoformat(), "type": "payment",
                                                 "amount": portfolio.rent_on({"start": start.isoformat(), "rent": rent, "escalation": 0.03}, m.year, m.month), "memo": "ACH rent"})
                m = (m.replace(day=28) + timedelta(days=5)).replace(day=1)
        # expenses
        m = bought.replace(day=1)
        tax = price * .016
        while m <= today:
            if m.month in (1, 7):
                D.insert(c, "expense", {"property_id": pid, "date": m.replace(day=20).isoformat(), "category": "Taxes",
                                        "amount": round(tax / 2, 2), "vendor": "Franklin County Treasurer"})
            if m.month == bought.month:
                D.insert(c, "expense", {"property_id": pid, "date": m.replace(day=5).isoformat(), "category": "Insurance",
                                        "amount": round(price * .0055, 2), "vendor": "State Farm"})
            if rnd.random() < .45:
                D.insert(c, "expense", {"property_id": pid, "date": m.replace(day=rnd.randint(3, 26)).isoformat(),
                                        "category": "Repairs", "amount": round(rnd.uniform(80, 900), 2),
                                        "vendor": rnd.choice(["Home Depot", "Roto-Rooter", "Lowe's", "Mr. Handyman"])})
            if units == 4:
                D.insert(c, "expense", {"property_id": pid, "date": m.replace(day=15).isoformat(), "category": "Utilities",
                                        "amount": round(rnd.uniform(260, 420), 2), "vendor": "City of Columbus Utilities"})
                D.insert(c, "expense", {"property_id": pid, "date": m.replace(day=10).isoformat(), "category": "Management fees",
                                        "amount": round(sum(r or 0 for r in rents) * .08, 2), "vendor": "Capital City PM"})
            m = (m.replace(day=28) + timedelta(days=5)).replace(day=1)
        if units == 2:
            D.insert(c, "maintenance", {"property_id": pid, "title": "Gutter cleaning", "status": "scheduled", "priority": "normal",
                                        "cost": 240, "vendor": "Clear Gutters"})
    c.execute("update property set source='DEMO' where source is null")
    return {"listings": len(pids), "owned": len(owned_specs)}
