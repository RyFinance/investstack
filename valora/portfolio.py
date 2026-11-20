"""Property management for what you own: units, tenants, leases, the rent ledger (charges, payments, late fees,
arrears ageing), expenses on Schedule E lines, debt, maintenance, and the portfolio roll-up."""
from __future__ import annotations

import bisect
import math
import threading
from datetime import date, timedelta

from . import db as D, uw

SCHED_E = ["Advertising", "Auto and travel", "Cleaning and maintenance", "Commissions", "Insurance",
           "Legal and other professional fees", "Management fees", "Mortgage interest", "Other interest", "Repairs",
           "Supplies", "Taxes", "Utilities", "Depreciation", "Other"]
OPEX_EXCLUDE = {"Mortgage interest", "Other interest", "Depreciation"}


def _d(s) -> date:
    return date.fromisoformat(str(s)[:10])


def _dq(s) -> date | None:
    """Date or None for blank / malformed values (leases applied from documents can lack dates)."""
    try:
        return _d(s) if s else None
    except ValueError:
        return None


def _months(a: date, b: date):
    y, m = a.year, a.month
    while (y, m) <= (b.year, b.month):
        yield y, m
        m += 1
        if m == 13:
            y, m = y + 1, 1


def add_months(d: date, n: int) -> date:
    """First of the month `n` months after (or before) d's month."""
    k = d.year * 12 + d.month - 1 + n
    return date(k // 12, k % 12 + 1, 1)


def add_years(d: date, n: int) -> date:
    try:
        return d.replace(year=d.year + n)
    except ValueError:                      # 29 Feb → 28 Feb
        return d.replace(year=d.year + n, day=28)


def _f(v, default: float = 0.0) -> float:
    """A stored number, tolerating rows written before input coercion ('' / text / NaN → default)."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return x if math.isfinite(x) else default


def _due_day(L: dict) -> int:
    return max(1, min(int(_f(L.get("due_day"), 1) or 1), 28))


def _grace(L: dict) -> int:
    g = L.get("grace_days")
    return 5 if g is None or g == "" else max(0, int(_f(g, 5)))


def _dim(y: int, m: int) -> int:
    return (add_months(date(y, m, 1), 1) - timedelta(days=1)).day


# ---------- ledger ----------

def rent_on(lease: dict, y: int, m: int) -> float:
    """Rent due in month y-m: the annual escalation applies from the first due date on or after each lease
    anniversary (a lease starting 15 Mar with rent due on the 1st steps up on 1 Apr of the next year)."""
    st = _d(lease["start"])
    due = date(y, m, _due_day(lease))
    yrs = due.year - st.year - ((due.month, due.day) < (st.month, st.day))
    esc = max(-0.99, min(10.0, _f(lease.get("escalation"))))
    return round(_f(lease.get("rent")) * (1 + esc) ** min(200, max(0, yrs)), 2)


_post_lock = threading.Lock()
CHARGE_STATUSES = ("active", "notice", "renewed")


def _missing(L: dict, have: dict, through: date):
    """Rent charges (and late-fee candidates) a lease should have by `through`: [(due, amount, memo, new)].
    A move-in after the 1st is prorated and due on move-in. An active lease past its end keeps charging
    month-to-month at the last rent (holdover). A 'renewed' lease (its successor starts the day after its end) stops
    at its end, and a final partial month is prorated so the two leases together charge exactly one month."""
    st, en = _dq(L.get("start")), _dq(L.get("end"))
    if not st or L.get("rent") in (None, ""):
        return []
    hold = bool(en) and L.get("status") in ("active", "notice") and en < through   # past its end, still in the unit
    stop = en if en and L.get("status") == "renewed" else None
    if stop and stop < st:
        return []
    out = []
    for y, m in _months(st, min(stop, through) if stop else through):
        dim = _dim(y, m)
        d0 = st.day if (y, m) == (st.year, st.month) else 1
        d1 = stop.day if stop and (y, m) == (stop.year, stop.month) else dim
        due = st if d0 > 1 else date(y, m, min(_due_day(L), d1))
        if due > through:
            continue
        amt, memo = rent_on(L, y, m), f"Rent {date(y, m, 1):%b %Y}"
        if d0 > 1 or d1 < dim:
            days = d1 - d0 + 1
            amt, memo = round(amt * days / dim, 2), f"{memo} (prorated {days}/{dim} days)"
        elif hold and due > en:
            memo += " (holdover)"
        out.append((due, amt, memo, f"{y}-{m:02d}" not in have["rent"]))
    return out


class _Sums:
    """Running totals of a lease's charges and payments by date, for the late-fee test (O(log n) per month)."""
    def __init__(self, es):
        ch = sorted((x[0], x[2]) for x in es if x[1] in ("rent", "charge"))
        pa = sorted((x[0], x[2]) for x in es if x[1] in ("payment", "credit"))
        self.cd, self.cs = [d for d, _ in ch], self._acc(ch)
        self.pd, self.ps = [d for d, _ in pa], self._acc(pa)

    @staticmethod
    def _acc(xs):
        out, t = [0.0], 0.0
        for _, a in xs:
            t += a
            out.append(t)
        return out

    def unpaid(self, due: str, late: str) -> float:
        """Rent and charges due on or before `due` less payments and credits made on or before `late`."""
        return self.cs[bisect.bisect_right(self.cd, due)] - self.ps[bisect.bisect_right(self.pd, late)]


def post_charges(c, through: date | None = None) -> int:
    """Create missing rent charges (one per lease per month; a move-in after the 1st is prorated) and late fees for
    rent still unpaid when the grace period ends. Idempotent and cheap when nothing is missing: two queries, the
    rest in memory. Serialised (thread lock + BEGIN IMMEDIATE) so two requests never post the same charge twice."""
    through = through or date.today()
    if not _post(c, through, dry=True):          # the common case: read-only, no write lock taken
        return 0
    with _post_lock:
        if c.in_transaction:
            c.commit()
        c.execute("begin immediate")
        try:
            n = _post(c, through)                 # re-check under the lock: another request may have posted them
            c.commit()
        except BaseException:
            c.rollback()
            raise
    return n


def _post(c, through: date, dry: bool = False) -> int:
    leases = D.rows(c, f"select * from lease where status in ({','.join('?' * len(CHARGE_STATUSES))})", CHARGE_STATUSES)
    if not leases:
        return 0
    ids = [L["id"] for L in leases]
    ents: dict[int, list] = {i: [] for i in ids}
    for e in c.execute(f"select lease_id, date, type, amount, memo from ledger_entry where lease_id in ({','.join('?' * len(ids))}) order by date, id", ids):
        ents[e[0]].append([str(e[1] or ""), e[2], _f(e[3]), e[4]])
    n = 0
    for L in leases:
        es = ents[L["id"]]
        have = {"rent": {x[0][:7] for x in es if x[1] == "rent"}, "late": {x[3] for x in es if x[1] == "late_fee"}}
        sched = _missing(L, have, through)
        for due, amt, memo, new in sched:
            if new and dry:
                return 1
            if new:
                D.insert(c, "ledger_entry", {"lease_id": L["id"], "date": due.isoformat(), "type": "rent", "amount": amt, "memo": memo})
                es.append([due.isoformat(), "rent", amt, memo])
                have["rent"].add(due.isoformat()[:7])
                n += 1
        fee = _f(L.get("late_fee"))
        if fee <= 0:
            continue
        # Late fee: rent (and other charges) due by the due date still unpaid when the grace period ends. Earlier
        # late fees are left out of that test, so an unpaid late fee never triggers another one by itself.
        g, sums = _grace(L), None
        for due, amt, memo, _ in sched:
            late = due + timedelta(days=g)
            lmemo = f"Late fee {due:%b %Y}"
            if late > through or lmemo in have["late"]:
                continue
            sums = sums or _Sums(es)
            if sums.unpaid(due.isoformat(), late.isoformat()) > 1:
                if dry:
                    return 1
                D.insert(c, "ledger_entry", {"lease_id": L["id"], "date": late.isoformat(), "type": "late_fee", "amount": fee, "memo": lmemo})
                have["late"].add(lmemo)
                n += 1
    return n


def lease_balance(c, lease_id: int, on: date | None = None) -> dict:
    """Balance and ageing: payments and credits are applied to the oldest charges first. A negative balance means
    the tenant has paid ahead (`prepaid`); ageing buckets only ever hold unpaid charges."""
    es = D.rows(c, "select * from ledger_entry where lease_id=? order by date, id", (lease_id,))
    charges = [[e["date"], _f(e["amount"])] for e in es if e["type"] in ("rent", "late_fee", "charge")]
    credit = sum(_f(e["amount"]) for e in es if e["type"] in ("payment", "credit"))
    credit += -sum(ch[1] for ch in charges if ch[1] < 0)          # a negative charge is a credit
    charges = [ch for ch in charges if ch[1] > 0]
    for ch in charges:
        if credit <= 0:
            break
        take = min(ch[1], credit)
        ch[1] -= take
        credit -= take
    today = on or date.today()
    buckets = {"0-30": 0.0, "31-60": 0.0, "61-90": 0.0, "90+": 0.0}
    for d, amt in charges:
        if amt <= 0.005:
            continue
        dd = _dq(d)
        age = (today - dd).days if dd else 0
        buckets["0-30" if age <= 30 else "31-60" if age <= 60 else "61-90" if age <= 90 else "90+"] += amt
    owed = sum(amt for _, amt in charges if amt > 0)
    bal = owed - credit                                           # credit < 0 (net refunds) raises what is owed
    return {"balance": round(bal, 2), "aging": {k: round(v, 2) for k, v in buckets.items()},
            "prepaid": round(max(0.0, credit), 2)}


def ledger(c, lease_id: int) -> list[dict]:
    es = D.rows(c, "select * from ledger_entry where lease_id=? order by date, id", (lease_id,))
    run = 0.0
    for e in es:
        amt = _f(e["amount"])
        run += amt if e["type"] in ("rent", "late_fee", "charge") else -amt
        e["running"] = round(run, 2)
    return es


# ---------- debt ----------
# Convention: a loan dated in month M makes its first payment in month M+1; k payments made by month M+k.

def _term(d: dict) -> int:
    return max(0, min(1200, round(_f(d.get("years")) * 12)))


def _loan(d: dict) -> tuple[float, float, float, bool]:
    """principal, rate, years, io from a debt row (blank / text values → 0)."""
    return _f(d.get("principal")), _f(d.get("rate")), _term(d) / 12, bool(_f(d.get("io")))


def debt_state(d: dict, on: date | None = None) -> dict:
    on = on or date.today()
    st = _dq(d.get("start")) or on
    principal, rate, years, io = _loan(d)
    k = max(0, min(_term(d), (on.year - st.year) * 12 + on.month - st.month))
    pmt = _f(d.get("payment")) or uw.payment(principal, rate, years, io)
    bal = uw.balance(principal, rate, years, k, io)
    if io and k >= _term(d) > 0:
        bal = 0.0                                                  # interest-only loan repaid at maturity
    return {"months_paid": k, "payment": pmt, "balance": bal, "pi_year": pmt * 12 if k < _term(d) or not _term(d) else 0.0,
            "escrow": _f(d.get("escrow"))}


def interest_in_year(d: dict, year: int) -> float:
    """Mortgage interest paid in a calendar year (payments k_a..k_b), from the amortisation, nothing after payoff."""
    st = _dq(d.get("start"))
    principal, rate, years, io = _loan(d)
    if not st or principal <= 0:
        return 0.0
    n = _term(d)
    k_a = max(1, (year - st.year) * 12 + 1 - st.month)
    k_b = min(n, (year - st.year) * 12 + 12 - st.month)
    if k_b < k_a:
        return 0.0
    pmt = uw.payment(principal, rate, years, io)
    paid_principal = uw.balance(principal, rate, years, k_a - 1, io) - uw.balance(principal, rate, years, k_b, io)
    return max(0.0, pmt * (k_b - k_a + 1) - paid_principal)


def debt_payment_in(d: dict, y: int, m: int) -> float:
    """Scheduled P&I for month y-m (0 before the first payment and after payoff)."""
    st = _dq(d.get("start"))
    if not st:
        return 0.0
    k = (y - st.year) * 12 + m - st.month
    if k < 1 or (_term(d) and k > _term(d)):
        return 0.0
    return _f(d.get("payment")) or uw.payment(*_loan(d))


# ---------- roll-ups ----------

def assessed_value(c, pid: int) -> dict | None:
    assessment = D.one(c, """select a.assessed_total as value, a.source, a.year
        from parcel a join property p on p.id=a.property_id
        where a.property_id=? and upper(p.state)='BC' and a.assessed_total>0 and a.year is not null
        order by a.year desc, a.id desc limit 1""", (pid,))
    if assessment:
        assessment["basis"] = "assessment"
        assessment["source"] = f"{assessment['year']} assessment · {assessment['source']}"
    return assessment


def property_value(c, pid: int) -> tuple[float | None, str]:
    o = D.one(c, "select * from owned where property_id=?", (pid,)) or {}
    if o.get("value_est"):
        return o["value_est"], o.get("value_src") or "your estimate"
    from . import props

    v = props.value_est(c, pid)
    if v:
        return v["value"], f"{v['source']} {v.get('as_of') or ''}".strip()
    p = D.one(c, "select zip from property where id=?", (pid,))
    if o.get("purchase_price") and o.get("purchase_date") and p and p.get("zip"):
        from .sources import zillow
        s = zillow.series(c, "zip", p["zip"], "zhvi")
        if s:
            base = next((x["value"] for x in s if x["date"][:7] >= o["purchase_date"][:7]), None)
            if base:
                return o["purchase_price"] * s[-1]["value"] / base, f"purchase price × ZIP ZHVI since {o['purchase_date'][:7]}"
    return o.get("purchase_price"), "purchase price"


def ttm(c, pid: int, end: date | None = None) -> dict:
    end = end or date.today()
    start = (end - timedelta(days=365)).isoformat()
    inc = c.execute("""select coalesce(sum(e.amount),0) from ledger_entry e join lease l on l.id=e.lease_id join unit u on u.id=l.unit_id
        where u.property_id=? and e.type='payment' and e.date>? and e.date<=?""", (pid, start, end.isoformat())).fetchone()[0]
    exp = D.rows(c, "select category, coalesce(sum(amount),0) as amt from expense where property_id=? and date>? and date<=? group by category",
                 (pid, start, end.isoformat()))
    opex = sum(r["amt"] for r in exp if r["category"] not in OPEX_EXCLUDE)
    return {"income": inc, "opex": opex, "noi": inc - opex, "by_cat": exp}


def budget_rows(c, pid: int | None = None) -> list[dict]:
    sql = "select * from property_budget"
    return D.rows(c, sql + " where property_id=? order by id", (pid,)) if pid is not None else D.rows(c, sql + " order by id")


def monthly_budget(rows: list[dict], kind: str) -> float | None:
    amounts = [r["amount"] / (12 if r["cadence"] == "annual" else 1) for r in rows if r["kind"] == kind]
    return round(sum(amounts), 2) if amounts else None


def monthly_net(rows: list[dict]) -> float | None:
    rent = monthly_budget(rows, "rent")
    return round(rent - (monthly_budget(rows, "expense") or 0), 2) if rent is not None else None


def _save_budget(c, b: dict) -> dict:
    action = b.get("act")
    if not c.in_transaction:
        c.execute("begin immediate")
    if action in ("edit", "delete"):
        row = D.one(c, "select * from property_budget where id=?", (int(b["id"]),))
        if not row:
            return {"error": "Budget item no longer exists"}
        if action == "delete":
            c.execute("delete from property_budget where id=?", (row["id"],))
            return {"ok": True}
    else:
        row = {}
    fields = D.clean(c, "property_budget", b["data"] if isinstance(b.get("data"), dict) else {}, drop=("id",))
    values = {**row, **fields}
    if action == "edit":
        values["property_id"] = row["property_id"]
    pid = values.get("property_id")
    if not pid or not D.one(c, "select id from property where id=? and owned=1", (pid,)):
        return {"error": "Choose an owned property"}
    values["name"] = (values.get("name") or "").strip()
    if (not values["name"] or values.get("kind") not in ("rent", "expense")
            or values.get("cadence") not in ("monthly", "annual") or values.get("amount") is None or values["amount"] < 0):
        return {"error": "Enter a name, frequency, and a nonnegative amount"}
    duplicate = D.one(c, "select id from property_budget where property_id=? and kind=? and name=?",
                      (pid, values["kind"], values["name"]))
    if duplicate and duplicate["id"] != row.get("id"):
        return {"error": "A budget item with this name already exists"}
    if action == "edit":
        D.update(c, "property_budget", row["id"], {k: v for k, v in values.items() if k != "id"})
        return {"ok": True}
    return {"id": D.insert(c, "property_budget", values)}


def overview(c) -> dict:
    post_charges(c)
    props = D.rows(c, "select p.*, o.purchase_price, o.purchase_date, o.closing_costs, o.rehab from property p left join owned o on o.property_id=p.id where p.owned=1 order by p.id")
    out, tot = [], {"value": 0, "debt": 0, "equity": 0, "noi": 0, "ds": 0, "cf": 0, "units": 0, "occupied": 0, "arrears": 0, "rent_roll": 0, "cost": 0}
    exp90 = []
    budgets: dict[int, list[dict]] = {}
    for item in budget_rows(c):
        budgets.setdefault(item["property_id"], []).append(item)
    for p in props:
        val, vsrc = property_value(c, p["id"])
        debts = [dict(d, **debt_state(d)) for d in D.rows(c, "select * from debt where property_id=?", (p["id"],))]
        debt = sum(d["balance"] for d in debts)
        ds = sum(d["pi_year"] for d in debts)
        t = ttm(c, p["id"])
        units = D.rows(c, "select * from unit where property_id=?", (p["id"],))
        leases = D.rows(c, """select l.*, u.name as unit, t.name as tenant from lease l join unit u on u.id=l.unit_id
            left join tenant t on t.id=l.tenant_id where u.property_id=? and l.status in ('active','notice')""", (p["id"],))
        occ = len({L["unit_id"] for L in leases})
        leased = {L["unit_id"] for L in leases}
        known_units = sum(u["status"] != "unverified" or u["id"] in leased for u in units)
        roll = sum(rent_on(L, date.today().year, date.today().month) if _dq(L.get("start")) else _f(L.get("rent")) for L in leases)
        arrears = sum(max(0, lease_balance(c, L["id"])["balance"]) for L in leases)
        arrears += sum(max(0, lease_balance(c, o["id"])["balance"]) for o in D.rows(c, """select l.id from lease l join unit u on u.id=l.unit_id
            where u.property_id=? and l.status='renewed'""", (p["id"],)))
        for L in leases:
            if _dq(L.get("end")):
                days = (_d(L["end"]) - date.today()).days
                if days <= 90:
                    exp90.append({"property_id": p["id"], "address": p["address"], "unit": L["unit"], "tenant": L["tenant"],
                                  "end": L["end"], "days": days, "rent": L["rent"], "lease_id": L["id"]})
        cost = (p.get("purchase_price") or 0) + (p.get("closing_costs") or 0) + (p.get("rehab") or 0)
        budget = budgets.get(p["id"], [])
        balance_unknown = not debts and any(
            b["kind"] == "expense" and b["name"].casefold() == "mortgage payment" and b["amount"] > 0 for b in budget
        )
        row = {**p, "value": val, "value_src": vsrc, "debt": None if balance_unknown else debt,
               "equity": val - debt if val is not None and not balance_unknown else None,
               "ltv": debt / val if val and not balance_unknown else None,
               "noi": t["noi"], "income": t["income"], "opex": t["opex"], "ds": ds, "cf": t["noi"] - ds,
               "cap_on_value": t["noi"] / val if val else None, "units_n": len(units), "occupied": occ,
               "vacant": max(0, known_units - occ), "known_units": known_units,
               "occupancy": occ / known_units if known_units else None, "rent_roll": roll, "arrears": arrears,
               "budget": budget, "budget_net_month": monthly_net(budget),
               "cost": cost, "gain": (val or 0) - cost if cost else None, "debts": debts,
               "dscr": t["noi"] / ds if ds else None}
        out.append(row)
        for k, v in (("value", val or 0), ("debt", debt), ("noi", t["noi"]), ("ds", ds), ("cf", t["noi"] - ds),
                     ("units", len(units)), ("occupied", occ), ("arrears", arrears), ("rent_roll", roll), ("cost", cost)):
            tot[k] += v
    tot["equity"] = tot["value"] - tot["debt"]
    tot["ltv"] = tot["debt"] / tot["value"] if tot["value"] else None
    if any(row["debt"] is None for row in out):
        tot.update(debt=None, equity=None, ltv=None)
    known_units = sum(row["known_units"] for row in out)
    tot["occupancy"] = tot["occupied"] / known_units if known_units else None
    tot["cap"] = tot["noi"] / tot["value"] if tot["value"] else None
    tot["dscr"] = tot["noi"] / tot["ds"] if tot["ds"] else None
    return {"properties": out, "total": tot, "expiring": sorted(exp90, key=lambda x: x["days"]), "monthly": monthly(c)}


def monthly(c, months: int = 24, today: date | None = None) -> list[dict]:
    """Income, operating expenses and debt service by month across the portfolio: exactly `months` calendar months
    ending with the current one."""
    today = today or date.today()
    months = max(1, int(months))
    first = add_months(today, -(months - 1))
    inc = {r["m"]: r["v"] for r in D.rows(c, """select substr(e.date,1,7) m, sum(e.amount) v from ledger_entry e
        join lease l on l.id=e.lease_id join unit u on u.id=l.unit_id join property p on p.id=u.property_id
        where p.owned=1 and e.type='payment' and e.date>=? group by m""", (first.isoformat(),))}
    exp = {r["m"]: r["v"] for r in D.rows(c, f"""select substr(x.date,1,7) m, sum(x.amount) v from expense x join property p on p.id=x.property_id
        where p.owned=1 and x.date>=? and coalesce(x.category,'') not in ({','.join('?' * len(OPEX_EXCLUDE))}) group by m""",
                                          (first.isoformat(), *OPEX_EXCLUDE))}
    debts = D.rows(c, "select d.* from debt d join property p on p.id=d.property_id where p.owned=1")
    out = []
    for y, m in _months(first, today):
        k = f"{y}-{m:02d}"
        ds = sum(debt_payment_in(d, y, m) for d in debts)
        i, e = inc.get(k) or 0, exp.get(k) or 0
        out.append({"month": k, "income": i, "opex": e, "noi": i - e, "debt": ds, "cf": i - e - ds})
    return out


def rent_roll(c, pid: int | None = None) -> list[dict]:
    post_charges(c)
    q = """select u.*, p.address, p.id as property_id, l.id as lease_id, l.start, l.end, l.rent, l.deposit, l.status as lease_status,
        l.due_day, l.late_fee, l.escalation, t.name as tenant, t.email, t.phone, t.id as tenant_id
        from unit u join property p on p.id=u.property_id
        left join lease l on l.unit_id=u.id and l.status in ('active','notice')
        left join tenant t on t.id=l.tenant_id where p.owned=1""" + (" and p.id=?" if pid else "") + " order by p.id, u.name"
    rows = D.rows(c, q, (pid,) if pid else ())
    today = date.today()
    for r in rows:
        if r.get("lease_id"):
            b = lease_balance(c, r["lease_id"])
            for o in D.rows(c, "select id from lease where unit_id=? and status='renewed' and id!=?", (r["id"], r["lease_id"])):
                ob = lease_balance(c, o["id"])                         # still running until its end after an early renewal
                b["balance"] = round(b["balance"] + ob["balance"], 2)
                b["aging"] = {k: round(b["aging"][k] + ob["aging"][k], 2) for k in b["aging"]}
            r.update(balance=b["balance"], aging=b["aging"],
                     current_rent=rent_on(r, today.year, today.month) if _dq(r.get("start")) else _f(r.get("rent")),
                     days_left=(_dq(r["end"]) - today).days if _dq(r.get("end")) else None)
            r["loss_to_lease"] = (_f(r["market_rent"]) - r["current_rent"]) if _f(r.get("market_rent")) else None
        else:
            r.update(balance=0, aging={"0-30": 0.0, "31-60": 0.0, "61-90": 0.0, "90+": 0.0}, current_rent=0, days_left=None,
                 loss_to_lease=r.get("market_rent"))
    return rows


def schedule_e(c, year: int) -> dict:
    """Schedule-E style summary per property (not tax advice). Depreciation: 27.5-year straight line on 80% of cost
    (assumed building share), mid-month convention ignored."""
    out = []
    for p in D.rows(c, "select p.*, o.purchase_price, o.purchase_date, o.closing_costs, o.rehab from property p join owned o on o.property_id=p.id where p.owned=1"):
        rents = c.execute("""select coalesce(sum(e.amount),0) from ledger_entry e join lease l on l.id=e.lease_id join unit u on u.id=l.unit_id
            where u.property_id=? and e.type='payment' and substr(e.date,1,4)=?""", (p["id"], str(year))).fetchone()[0]
        lines = {k: 0.0 for k in SCHED_E}
        for r in D.rows(c, "select category, coalesce(sum(amount),0) amt from expense where property_id=? and substr(date,1,4)=? group by category", (p["id"], str(year))):
            lines[r["category"] if r["category"] in lines else "Other"] += r["amt"]
        for d in D.rows(c, "select * from debt where property_id=?", (p["id"],)):
            lines["Mortgage interest"] += interest_in_year(d, year)
        basis = ((p.get("purchase_price") or 0) + (p.get("closing_costs") or 0)) * 0.8 + (p.get("rehab") or 0)
        pd_ = _dq(p.get("purchase_date"))
        if pd_ and pd_.year <= year:
            frac = (12 - pd_.month + 0.5) / 12 if pd_.year == year else 1      # mid-month convention, first year
            lines["Depreciation"] += basis / 27.5 * frac
        total = sum(lines.values())
        out.append({"property_id": p["id"], "address": p["address"], "rents": rents, "lines": lines, "expenses": total,
                    "net": rents - total, "basis": basis})
    return {"year": year, "properties": out, "lines": SCHED_E}


# ---------- writes ----------

def _drop_auto_after(c, lease_id: int, end: date) -> None:
    """Remove rent and late fees InvestStack posted on a lease after its end date (holdover months), when the lease is ended
    or renewed. Entries typed in by hand or matched to a bank line stay."""
    c.execute("""delete from ledger_entry where lease_id=? and date>? and type in ('rent','late_fee') and bank_txn_id is null
        and (memo like 'Rent %' or memo like 'Late fee %')""", (lease_id, end.isoformat()))


def post(c, b: dict) -> dict:
    act = b.get("act")
    if act == "add_owned_address":
        from . import props

        payment = b.get("monthly_mortgage")
        if payment is not None and (isinstance(payment, bool) or not isinstance(payment, (int, float))
                                    or not math.isfinite(payment) or payment < 0):
            return {"error": "Enter a valid non-negative monthly mortgage payment"}
        existing = props.get(c, b.get("property_id")) if b.get("property_id") else None
        address = existing["address"] if existing else str(b.get("address") or "").strip()
        if not D.norm_address(address):
            return {"error": "Enter a property address"}
        result = props.save_owned_address(c, address, existing)
        pid = result["id"]
        c.execute("update property set owned=1 where id=?", (pid,))
        c.execute("insert into owned (property_id) values (?) on conflict(property_id) do nothing", (pid,))
        if payment is not None:
            mortgage = D.one(c, """select id from property_budget
                where property_id=? and kind='expense' and lower(name)='mortgage payment' order by id limit 1""", (pid,))
            saved = _save_budget(c, {"act": "edit" if mortgage else "add", "id": mortgage["id"] if mortgage else None,
                                    "data": {"property_id": pid, "kind": "expense", "name": "Mortgage payment",
                                             "amount": payment, "cadence": "monthly"}})
            if saved.get("error"):
                raise ValueError(saved["error"])
        return result
    if b.get("table") == "budget" and act in ("add", "edit", "delete"):
        return _save_budget(c, b)
    T = {"unit": "unit", "tenant": "tenant", "lease": "lease", "entry": "ledger_entry", "expense": "expense",
         "debt": "debt", "maint": "maintenance", "owned": "owned"}
    if act in ("add", "edit", "delete"):
        t = T.get(b.get("table"))
        if not t:
            return {"error": f"unknown table {b.get('table')!r}"}
        key = "property_id" if t == "owned" else "id"
        data = D.clean(c, t, b.get("data") if isinstance(b.get("data"), dict) else {}, drop=() if t == "owned" else ("id",))
        if act == "add":
            if t == "owned":
                if not data.get("property_id"):
                    return {"error": "property_id is required"}
                c.execute("update property set owned=1 where id=?", (data["property_id"],))
                c.execute("insert or replace into owned (property_id, purchase_price, purchase_date, closing_costs, rehab, value_est, value_src) values (?,?,?,?,?,?,?)",
                          (data["property_id"], data.get("purchase_price"), data.get("purchase_date"), data.get("closing_costs") or 0,
                           data.get("rehab") or 0, data.get("value_est"), data.get("value_src")))
                return {"id": data["property_id"]}
            if t == "lease":
                if not data.get("unit_id"):
                    return {"error": "unit_id is required"}
                if b.get("tenant_name") and not data.get("tenant_id"):
                    data["tenant_id"] = D.insert(c, "tenant", {"name": b["tenant_name"], "email": b.get("email"), "phone": b.get("phone")})
            if not data:
                return {"error": "no data"}
            i = D.insert(c, t, data)
            if t == "lease":
                c.execute("update unit set status='occupied' where id=?", (data["unit_id"],))
            return {"id": i}
        if b.get("id") in (None, ""):
            return {"error": "id is required"}
        if act == "edit":
            data.pop(key, None)
            D.update(c, t, int(b["id"]), data, key)
        else:
            if t == "owned":
                c.execute("update property set owned=0 where id=?", (int(b["id"]),))
            c.execute(f"delete from {t} where {key}=?", (int(b["id"]),))
        return {"ok": True}
    if act == "end_lease":
        L = D.one(c, "select * from lease where id=?", (int(b["id"]),))
        if not L:
            return {"error": "no such lease"}
        end = _dq(b.get("end"))
        if not end:                                  # no date given: the lease ends today (or on its own end if sooner)
            end = min(_dq(L.get("end")) or date.today(), date.today())
        c.execute("update lease set status='ended', end=? where id=?", (end.isoformat(), L["id"]))
        _drop_auto_after(c, L["id"], end)
        for o in D.rows(c, "select id, end from lease where unit_id=? and status='renewed' and id!=?", (L["unit_id"], L["id"])):
            oe = min(_dq(o.get("end")) or end, end)              # moving out before a renewed lease ran out ends it too
            c.execute("update lease set status='ended', end=? where id=?", (oe.isoformat(), o["id"]))
            _drop_auto_after(c, o["id"], oe)
        c.execute("update unit set status='vacant' where id=?", (L["unit_id"],))
        return {"ok": True}
    if act == "renew":
        L = D.one(c, "select * from lease where id=?", (int(b["id"]),))
        if not L:
            return {"error": "no such lease"}
        old_end = _dq(L.get("end"))
        if not old_end:
            return {"error": "the lease has no end date to renew from"}
        # renewing early: the old lease keeps charging until its own end ('renewed'), the new one starts the day after
        c.execute("update lease set status=? where id=?", ("renewed" if old_end >= date.today() else "ended", L["id"]))
        _drop_auto_after(c, L["id"], old_end)        # holdover months posted on the old lease are charged on the new one
        new = {k: L[k] for k in ("unit_id", "tenant_id", "deposit", "due_day", "late_fee", "grace_days", "escalation")}
        st = old_end + timedelta(days=1)
        yrs = max(1, int(float(b.get("years") or 1)))
        new.update(start=st.isoformat(), end=(add_years(st, yrs) - timedelta(days=1)).isoformat(),
                   rent=float(b.get("rent") or L["rent"]), status="active")
        return {"id": D.insert(c, "lease", new)}
    if act == "post_charges":
        return {"posted": post_charges(c)}
    return {"error": "unknown action"}
