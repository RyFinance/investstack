"""Underwriting maths. Pure functions, no I/O, deterministic.

Conventions
- Money in dollars, rates as decimals (0.065 = 6.5%), periods monthly for debt and annual for the hold.
- NOI = effective gross income - operating expenses. Debt service and capex reserves are BELOW the NOI line
  (capex reserve is subtracted for cash flow, not NOI, which keeps cap rates comparable with brokers' figures).
- Cap rate = year-1 NOI / price.  Cash-on-cash = year-1 cash flow after debt / cash invested.
- DSCR = NOI / annual debt service.  IRR on annual levered cash flows, sale at the exit cap applied to the
  following year's NOI, less selling costs and the loan balance.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict


# ---------- debt ----------

def payment(principal: float, rate: float, years: float, io: bool = False) -> float:
    """Monthly payment on a fully amortising (or interest-only) loan."""
    if principal <= 0:
        return 0.0
    r = rate / 12
    if io:
        return principal * r
    n = round(years * 12)
    if n <= 0:
        return principal
    return principal / n if r == 0 else principal * r / (1 - (1 + r) ** -n)


def balance(principal: float, rate: float, years: float, months_paid: int, io: bool = False) -> float:
    """Loan balance after `months_paid` payments."""
    if principal <= 0:
        return 0.0
    if io:
        return principal
    r, pmt = rate / 12, payment(principal, rate, years)
    k = max(0, min(int(months_paid), round(years * 12)))
    if r == 0:
        return max(0.0, principal - pmt * k)
    return max(0.0, principal * (1 + r) ** k - pmt * ((1 + r) ** k - 1) / r)


def amortization(principal: float, rate: float, years: float, io: bool = False) -> list[dict]:
    """Yearly schedule: interest, principal, balance at year end."""
    out, bal = [], principal
    r, pmt = rate / 12, payment(principal, rate, years, io)
    for y in range(1, math.ceil(years) + 1):
        i_sum = p_sum = 0.0
        for _ in range(12):
            if bal <= 1e-9:
                break
            i = bal * r
            p = 0.0 if io else min(bal, pmt - i)
            bal -= p
            i_sum, p_sum = i_sum + i, p_sum + p
        out.append({"year": y, "interest": i_sum, "principal": p_sum, "balance": bal})
        if bal <= 1e-9:
            break
    return out


# ---------- return maths ----------

def npv(rate: float, flows: list[float]) -> float:
    return sum(cf / (1 + rate) ** t for t, cf in enumerate(flows))


def irr(flows: list[float]) -> float | None:
    """IRR by bracketing + bisection/secant. None when there is no sign change or no root in (-99%, 1000%)."""
    if not flows or all(x >= 0 for x in flows) or all(x <= 0 for x in flows):
        return None
    lo, hi = -0.99, 10.0
    f_lo, f_hi = npv(lo, flows), npv(hi, flows)
    # scan for a bracket nearest 0 first (avoids picking a far root when cash flows change sign twice)
    grid = [-0.9, -0.5, -0.2, 0.0, 0.05, 0.1, 0.2, 0.35, 0.5, 1.0, 2.0, 5.0, 10.0]
    prev_r, prev_v = lo, f_lo
    bracket = None
    for g in grid:
        v = npv(g, flows)
        if prev_v == 0:
            return prev_r
        if (prev_v < 0) != (v < 0):
            bracket = (prev_r, g, prev_v, v)
            break
        prev_r, prev_v = g, v
    if not bracket:
        return None
    a, b, fa, fb = bracket
    for _ in range(200):
        m = (a + b) / 2
        fm = npv(m, flows)
        if abs(fm) < 1e-7 or (b - a) < 1e-10:
            return m
        if (fa < 0) == (fm < 0):
            a, fa = m, fm
        else:
            b, fb = m, fm
    return (a + b) / 2


# ---------- rental hold ----------

@dataclass
class Deal:
    price: float
    rent_month: float                 # gross scheduled rent, all units, per month
    other_income_month: float = 0.0
    vacancy: float = 0.05             # of gross
    taxes_year: float = 0.0
    insurance_year: float = 0.0
    hoa_month: float = 0.0
    mgmt: float = 0.08                # of effective income
    maint: float = 0.05               # of gross rent (repairs)
    capex: float = 0.05               # of gross rent (reserve, below NOI)
    utilities_month: float = 0.0
    other_exp_year: float = 0.0
    closing: float = 0.03             # of price, buyer side
    rehab: float = 0.0
    down: float = 0.25                # of price
    rate: float = 0.07
    years: float = 30
    io: bool = False
    rent_growth: float = 0.03
    exp_growth: float = 0.03
    appreciation: float = 0.03        # used when exit_cap is None
    exit_cap: float | None = None
    hold: int = 10
    sell_cost: float = 0.06
    meta: dict = field(default_factory=dict)


def _year(d: Deal, y: int) -> dict:
    g, e = (1 + d.rent_growth) ** (y - 1), (1 + d.exp_growth) ** (y - 1)
    gross = (d.rent_month + d.other_income_month) * 12 * g
    rent = d.rent_month * 12 * g
    vac = gross * d.vacancy
    egi = gross - vac
    fixed = (d.taxes_year + d.insurance_year + d.hoa_month * 12 + d.utilities_month * 12 + d.other_exp_year) * e
    opex = fixed + egi * d.mgmt + rent * d.maint
    noi = egi - opex
    return {"year": y, "gross": gross, "vacancy": vac, "egi": egi, "opex": opex, "noi": noi,
            "capex": rent * d.capex, "taxes": d.taxes_year * e, "insurance": d.insurance_year * e,
            "mgmt": egi * d.mgmt, "maint": rent * d.maint}


def analyse(d: Deal) -> dict:
    """Full rental-hold underwriting: year-1 metrics, a pro forma, sale, IRR, equity multiple."""
    if d.hold < 1:
        d = Deal(**{**asdict(d), "hold": 1})
    loan = d.price * (1 - d.down)
    cash_in = d.price * d.down + d.price * d.closing + d.rehab
    pmt = payment(loan, d.rate, d.years, d.io)
    ds = pmt * 12
    years = [_year(d, y) for y in range(1, d.hold + 2)]
    flows, proforma = [-cash_in], []
    for y in years[:-1]:
        cf = y["noi"] - y["capex"] - ds
        bal = balance(loan, d.rate, d.years, y["year"] * 12, d.io)
        proforma.append({**y, "debt": ds, "cash_flow": cf, "balance": bal})
        flows.append(cf)
    nxt = years[-1]["noi"]
    sale = nxt / d.exit_cap if d.exit_cap and d.exit_cap > 0 else d.price * (1 + d.appreciation) ** d.hold
    bal_end = proforma[-1]["balance"] if proforma else loan
    net_sale = sale * (1 - d.sell_cost) - bal_end
    flows[-1] += net_sale
    y1 = proforma[0]
    total_in = cash_in
    out = sum(flows[1:])
    noi1 = y1["noi"]
    return {
        "loan": loan, "cash_in": cash_in, "payment": pmt, "debt_year": ds,
        "noi": noi1, "cap": noi1 / d.price if d.price else None,
        "cash_flow": y1["cash_flow"], "cash_flow_month": y1["cash_flow"] / 12,
        "coc": y1["cash_flow"] / cash_in if cash_in else None,
        "dscr": noi1 / ds if ds else None,
        "grm": d.price / (d.rent_month * 12) if d.rent_month else None,
        "one_pct": d.rent_month / (d.price + d.rehab) if d.price else None,
        "breakeven_occ": (y1["opex"] + ds) / y1["gross"] if y1["gross"] else None,
        "opex_ratio": y1["opex"] / y1["egi"] if y1["egi"] else None,
        "sale": sale, "net_sale": net_sale, "irr": irr(flows),
        "multiple": (out / total_in) if total_in else None,
        "flows": flows, "proforma": proforma,
    }


def sensitivity(d: Deal, row: tuple[str, list[float]], col: tuple[str, list[float]], metric: str = "irr") -> dict:
    """Grid of `metric` while two inputs vary. row/col: (field name, values)."""
    grid = []
    for rv in row[1]:
        line = []
        for cv in col[1]:
            x = Deal(**{**asdict(d), row[0]: rv, col[0]: cv})
            line.append(analyse(x)[metric])
        grid.append(line)
    return {"row": row, "col": col, "metric": metric, "grid": grid}


def max_offer(d: Deal, metric: str = "coc", target: float = 0.08) -> float | None:
    """Highest price that still meets `target` on `metric` (bisection; metric must fall as price rises)."""
    lo, hi = 1.0, d.price * 3 or 1e7
    base = asdict(d)
    def m(p):
        v = analyse(Deal(**{**base, "price": p}))[metric]
        return -1e9 if v is None else v
    if m(lo) < target:
        return None
    while m(hi) >= target and hi < 1e10:     # the answer is above the first guess: widen the bracket
        lo, hi = hi, hi * 4
    for _ in range(80):
        mid = (lo + hi) / 2
        if m(mid) >= target:
            lo = mid
        else:
            hi = mid
    return lo


# ---------- BRRRR and flip ----------

def brrrr(price: float, rehab: float, arv: float, rent_month: float, opex_month: float,
          refi_ltv: float = 0.75, refi_rate: float = 0.072, years: float = 30,
          closing: float = 0.03, refi_cost: float = 0.02, hold_months: int = 6, carry_month: float = 0.0) -> dict:
    all_in = price * (1 + closing) + rehab + carry_month * hold_months
    loan = arv * refi_ltv
    cash_out = loan * (1 - refi_cost)
    left_in = all_in - cash_out
    pmt = payment(loan, refi_rate, years)
    cf = rent_month - opex_month - pmt
    return {"all_in": all_in, "loan": loan, "cash_out": cash_out, "left_in": left_in, "payment": pmt,
            "cash_flow_month": cf, "coc": (cf * 12 / left_in) if left_in > 0 else None,
            "infinite": left_in <= 0, "equity": arv - loan}


def flip(price: float, rehab: float, arv: float, months: int = 6, closing: float = 0.02, sell_cost: float = 0.08,
         carry_month: float = 0.0, loan_ltc: float = 0.0, rate: float = 0.11, points: float = 0.02) -> dict:
    loan = (price + rehab) * loan_ltc
    interest = loan * rate / 12 * months
    costs = price * closing + arv * sell_cost + carry_month * months + interest + loan * points
    profit = arv - price - rehab - costs
    cash = price + rehab + price * closing + carry_month * months + interest + loan * points - loan
    return {"profit": profit, "costs": costs, "cash": cash, "roi": profit / cash if cash > 0 else None,
            "annualized": ((1 + profit / cash) ** (12 / months) - 1) if cash > 0 and months > 0 and profit > -cash else None,
            "rule70": arv * 0.70 - rehab, "margin": profit / arv if arv else None}


# ---------- comps ----------

def adjust_comp(subject: dict, comp: dict, per_sqft: float | None = None, bed: float = 7500, bath: float = 5000,
                age_year: float = 400, lot_sqft: float = 2.0) -> dict:
    """Paired-sales style adjustment of a comparable sale toward the subject. Returns the adjusted price and lines."""
    lines = []
    px = comp["price"]
    ppsf = per_sqft or (px / comp["sqft"] if comp.get("sqft") else 0)
    def add(name, delta):
        if delta:
            lines.append({"k": name, "v": delta})
    if subject.get("sqft") and comp.get("sqft"):
        add("Size", (subject["sqft"] - comp["sqft"]) * ppsf * 0.5)   # half the $/sqft: size has diminishing value
    if subject.get("beds") is not None and comp.get("beds") is not None:
        add("Beds", (subject["beds"] - comp["beds"]) * bed)
    if subject.get("baths") is not None and comp.get("baths") is not None:
        add("Baths", (subject["baths"] - comp["baths"]) * bath)
    if subject.get("year_built") and comp.get("year_built"):
        add("Age", (subject["year_built"] - comp["year_built"]) * age_year)
    if subject.get("lot") and comp.get("lot"):
        add("Lot", max(-50000, min(50000, (subject["lot"] - comp["lot"]) * lot_sqft)))
    adj = px + sum(x["v"] for x in lines)
    gross = sum(abs(x["v"]) for x in lines)
    return {"price": px, "adjusted": adj, "lines": lines, "gross_adj": gross / px if px else None}


def reconcile(adjusted: list[dict]) -> dict | None:
    """Weight comps by 1/(gross adjustment + distance factor); return value and range."""
    xs = [a for a in adjusted if a.get("adjusted")]
    if not xs:
        return None
    w = [1 / (0.05 + abs(a.get("gross_adj") or 0) + 0.1 * max(0.0, a.get("dist_mi") or 0)) for a in xs]   # a hand-typed negative distance must not zero the weight
    v = sum(a["adjusted"] * wi for a, wi in zip(xs, w)) / sum(w)
    vals = sorted(a["adjusted"] for a in xs)
    return {"value": v, "low": vals[0], "high": vals[-1], "n": len(xs)}
