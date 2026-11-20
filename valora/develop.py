"""Development Studio maths: a parcel, its zoning envelope, a building massing and what it would cost and earn.

Geometry is deliberately simple and stated as such: the parcel is a rectangle derived from the lot area and a
frontage (real parcel boundaries need the county's GIS layer), the envelope is the parcel less setbacks up to
the height limit, and the massing is a box inside the envelope. All dimensions in feet, areas in square feet.
Zoning presets are typical values for illustration: always replace them with the site's actual code.
"""
from __future__ import annotations

import math

PRESETS = {
    "R-3 residential": {"use": "residential", "front": 20, "rear": 25, "side": 6, "max_height": 40, "max_far": 1.2, "max_coverage": 0.50},
    "MU mixed-use": {"use": "mixed", "front": 5, "rear": 15, "side": 0, "max_height": 60, "max_far": 3.0, "max_coverage": 0.80},
    "C-2 commercial": {"use": "retail", "front": 10, "rear": 15, "side": 5, "max_height": 45, "max_far": 1.5, "max_coverage": 0.60},
    "M-1 industrial": {"use": "industrial", "front": 25, "rear": 20, "side": 15, "max_height": 50, "max_far": 0.8, "max_coverage": 0.60},
}
USES = {  # floor height ft, efficiency (net / gross), hard cost $/sf, rent $/sf/yr net area, opex share, avg unit sf
    "residential": {"floor_h": 10.5, "eff": 0.82, "hard": 235, "rent": 21.0, "opex": 0.38, "unit": 850},
    "mixed": {"floor_h": 11.5, "eff": 0.80, "hard": 260, "rent": 23.0, "opex": 0.36, "unit": 800},
    "retail": {"floor_h": 16, "eff": 0.92, "hard": 210, "rent": 24.0, "opex": 0.22, "unit": 0},
    "industrial": {"floor_h": 28, "eff": 0.96, "hard": 125, "rent": 10.5, "opex": 0.15, "unit": 0},
    "office": {"floor_h": 13, "eff": 0.85, "hard": 290, "rent": 27.0, "opex": 0.40, "unit": 0},
}
DEFAULTS = {
    "lot_sqft": 8000, "frontage": 60, "zone": "MU mixed-use", "use": "mixed", "front": 5, "rear": 15, "side": 0,
    "max_height": 60, "max_far": 3.0, "max_coverage": 0.8, "floors": 4, "coverage": 0.65, "floor_h": 11.5,
    "eff": 0.80, "unit_sf": 800, "land": 0, "hard_sf": 260, "soft": 0.22, "contingency": 0.07, "rent_sf": 23.0,
    "vacancy": 0.06, "opex": 0.36, "exit_cap": 0.0575, "ltc": 0.65, "rate": 0.085, "months": 20, "sell_cost": 0.03,
    "rotation": 0,
}


def _f(b: dict, k: str) -> float:
    v = b.get(k)
    try:
        return float(v) if v not in (None, "") else float(DEFAULTS[k])
    except (TypeError, ValueError):
        return float(DEFAULTS[k])


def defaults_for(prop: dict | None, price: float | None = None) -> dict:
    d = dict(DEFAULTS)
    if prop:
        if prop.get("lot"):
            d["lot_sqft"] = float(prop["lot"])
            d["frontage"] = round(math.sqrt(d["lot_sqft"] / 2.2))
        t = (prop.get("type") or "").lower()
        zone = "M-1 industrial" if "industr" in t else "C-2 commercial" if any(k in t for k in ("retail", "commercial")) else \
            "MU mixed-use" if (prop.get("units") or 1) > 1 or "multi" in t else "R-3 residential"
        d.update(zone=zone, **{k: v for k, v in PRESETS[zone].items()})
        u = USES[d["use"]]
        d.update(floor_h=u["floor_h"], eff=u["eff"], hard_sf=u["hard"], rent_sf=u["rent"], opex=u["opex"], unit_sf=u["unit"])
        d["floors"] = max(1, min(int(d["max_height"] // d["floor_h"]), 6))
        d["coverage"] = round(min(d["max_coverage"], 0.65), 2)
        d["floors"] = max(1, min(d["floors"], int(d["max_far"] / d["coverage"])))   # start inside the floor-area limit
    if price:
        d["land"] = float(price)
    return d


def _rect(cx: float, cy: float, w: float, dpt: float, rot: float) -> list[tuple[float, float]]:
    """Rectangle corners (ft, x east / y north) centred at cx, cy, rotated `rot` degrees clockwise."""
    a = math.radians(-rot)
    pts = [(-w / 2, -dpt / 2), (w / 2, -dpt / 2), (w / 2, dpt / 2), (-w / 2, dpt / 2)]
    return [(cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a)) for x, y in pts]


def _hull(pts):
    """Convex hull (monotone chain), counter-clockwise."""
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0:
            hi.pop()
        hi.append(p)
    return lo[:-1] + hi[:-1]


def _geo(ring_ft, lat, lon):
    k_lat = 1 / 364000.0
    k_lon = 1 / (364000.0 * max(0.2, math.cos(math.radians(lat))))
    ring = [[lon + x * k_lon, lat + y * k_lat] for x, y in ring_ft]
    return ring + [ring[0]]


def model(b: dict, lat: float | None = None, lon: float | None = None) -> dict:
    g = lambda k: _f(b, k)
    lot = max(1.0, g("lot_sqft"))
    width = max(10.0, min(g("frontage"), lot / 10))
    depth = lot / width
    front, rear, side = max(0, g("front")), max(0, g("rear")), max(0, g("side"))
    env_w, env_d = max(0.0, width - 2 * side), max(0.0, depth - front - rear)
    env_area = env_w * env_d
    max_cov_area = lot * min(1.0, g("max_coverage"))
    floors = max(1, int(round(g("floors"))))
    floor_h = max(8.0, g("floor_h"))
    want = lot * max(0.01, min(1.0, g("coverage")))
    foot = min(want, env_area) if env_area > 0 else 0.0
    # footprint box keeps the envelope's proportions, sits at the front setback line
    s = math.sqrt(foot / env_area) if env_area > 0 else 0
    bw, bd = env_w * s, env_d * s
    height = floors * floor_h
    gfa = foot * floors
    far = gfa / lot
    cov = foot / lot
    max_floors_h = int(g("max_height") // floor_h)
    allowed_gfa = min(g("max_far") * lot, min(env_area, max_cov_area) * max(0, max_floors_h))
    checks = [
        {"k": "Floor-area ratio", "v": far, "limit": g("max_far"), "ok": far <= g("max_far") + 1e-9, "fmt": "x"},
        {"k": "Lot coverage", "v": cov, "limit": g("max_coverage"), "ok": cov <= g("max_coverage") + 1e-9, "fmt": "pct"},
        {"k": "Height", "v": height, "limit": g("max_height"), "ok": height <= g("max_height") + 1e-9, "fmt": "ft"},
        {"k": "Fits inside setbacks", "v": foot, "limit": env_area, "ok": want <= env_area + 1e-6, "fmt": "sf"},
    ]
    eff = min(1.0, max(0.3, g("eff")))
    net = gfa * eff
    unit_sf = g("unit_sf")
    use = b.get("use") or DEFAULTS["use"]
    resi_share = 1.0 if use == "residential" else ((floors - 1) / floors if use == "mixed" and floors > 1 else 0.0)
    units = int(net * resi_share // unit_sf) if unit_sf > 0 and resi_share else 0

    # feasibility
    land = max(0.0, g("land"))
    hard = gfa * g("hard_sf")
    soft = hard * g("soft")
    cont = (hard + soft) * g("contingency")
    months = max(1.0, g("months"))
    pre_fin = land + hard + soft + cont
    loan = pre_fin * min(0.9, g("ltc"))
    interest = loan * g("rate") * (months / 12) * 0.55   # average draw about 55% of the loan over the build
    cost = pre_fin + interest
    gross = net * g("rent_sf")
    egi = gross * (1 - g("vacancy"))
    noi = egi * (1 - g("opex"))
    cap = max(0.01, g("exit_cap"))
    value = noi / cap
    net_value = value * (1 - g("sell_cost"))
    profit = net_value - cost
    equity = cost - loan
    yrs = months / 12 + 1.0   # build plus a year to lease up
    em = (equity + profit) / equity if equity > 0 else None
    irr = (em ** (1 / yrs) - 1) if em and em > 0 else None
    out = {
        "inputs": {k: (b.get(k) if k in ("zone", "use") else g(k)) for k in DEFAULTS},
        "site": {"lot_sqft": lot, "width": width, "depth": depth, "envelope_sf": env_area, "env_w": env_w, "env_d": env_d},
        "massing": {"footprint": foot, "floors": floors, "height": height, "gfa": gfa, "far": far, "coverage": cov, "net_sf": net,
                    "units": units, "bw": bw, "bd": bd, "allowed_gfa": allowed_gfa, "used": gfa / allowed_gfa if allowed_gfa > 0 else None,
                    "max_floors": max_floors_h},
        "checks": checks, "compliant": all(x["ok"] for x in checks),
        "cost": {"land": land, "hard": hard, "soft": soft, "contingency": cont, "interest": interest, "total": cost,
                 "per_gsf": cost / gfa if gfa else None, "per_unit": cost / units if units else None, "loan": loan, "equity": equity},
        "income": {"gross": gross, "egi": egi, "noi": noi, "value": value, "net_value": net_value},
        "returns": {"profit": profit, "margin": profit / cost if cost else None, "yield_on_cost": noi / cost if cost else None,
                    "spread": (noi / cost - cap) if cost else None, "equity_multiple": em, "irr": irr,
                    "residual_land": net_value / 1.15 - (cost - land)},   # land value that leaves a 15% margin on cost
        "note": "Parcel drawn as a rectangle from lot area and frontage; zoning values are typical, not the site's code.",
    }
    if lat is not None and lon is not None:
        rot = g("rotation")
        a = math.radians(-rot)
        def at(dx, dy):   # offset in the parcel's own frame → world feet
            return dx * math.cos(a) - dy * math.sin(a), dx * math.sin(a) + dy * math.cos(a)
        ex, ey = at(0, (rear - front) / 2 * -1)              # envelope centre: shifted toward the rear by the setback difference
        bx, by = at(0, -(depth / 2) + front + bd / 2)        # building sits on the front setback line (front = south edge)
        foot_ft = _rect(bx, by, bw, bd, rot)
        # ground shadow: sun from the south-west at 40° altitude (a fixed reference, not a solar study)
        L = height / math.tan(math.radians(40))
        sx, sy = L * math.sin(math.radians(45)), L * math.cos(math.radians(45))
        shadow = _hull(foot_ft + [(x + sx, y + sy) for x, y in foot_ft])
        feats = [
            {"k": "shadow", "ring": _geo(shadow, lat, lon), "base": 0, "height": 0},
            {"k": "parcel", "ring": _geo(_rect(0, 0, width, depth, rot), lat, lon), "base": 0, "height": 0.6, "area": lot},
            {"k": "envelope", "ring": _geo(_rect(ex, ey, env_w, env_d, rot), lat, lon), "base": 0, "height": g("max_height"), "area": env_area},
        ]
        for i in range(floors):
            feats.append({"k": "floor", "i": i, "ring": _geo(foot_ft, lat, lon),
                          "base": i * floor_h, "height": (i + 1) * floor_h - 0.8, "area": foot,
                          "use": "retail" if use == "mixed" and i == 0 else use})
        out["geo"] = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"k": f["k"], "base": f["base"] * 0.3048, "height": f["height"] * 0.3048, "i": f.get("i", -1),
                                               "use": f.get("use", ""), "area": round(f.get("area") or 0), "ft": round(f["height"], 1)},
             "geometry": {"type": "Polygon", "coordinates": [f["ring"]]}} for f in feats]}
        out["bounds"] = _geo(_rect(0, 0, width + 2 * L, depth + 2 * L, rot), lat, lon)
    return out


def scenarios(b: dict) -> list[dict]:
    """Three quick alternatives from the same site: as drawn, the zoning maximum, and a low-rise version."""
    base = model(b)
    lot = base["site"]["lot_sqft"]
    mx = dict(b)
    mx["floors"] = max(1, base["massing"]["max_floors"])
    mx["coverage"] = min(_f(b, "max_coverage"), base["site"]["envelope_sf"] / lot if lot else 0)
    m = model(mx)
    if m["massing"]["far"] > _f(b, "max_far") and m["massing"]["floors"] > 1:   # FAR binds before height: drop floors
        mx["floors"] = max(1, int(_f(b, "max_far") * lot // max(1.0, m["massing"]["footprint"])))
        m = model(mx)
    lo = dict(b)
    lo["floors"] = max(1, min(2, int(_f(b, "floors"))))
    out = []
    for name, r in (("As drawn", base), ("Zoning maximum", m), ("Low-rise", model(lo))):
        out.append({"name": name, "floors": r["massing"]["floors"], "gfa": r["massing"]["gfa"], "far": r["massing"]["far"],
                    "units": r["massing"]["units"], "cost": r["cost"]["total"], "noi": r["income"]["noi"], "value": r["income"]["value"],
                    "profit": r["returns"]["profit"], "yield_on_cost": r["returns"]["yield_on_cost"], "margin": r["returns"]["margin"],
                    "compliant": r["compliant"], "inputs": r["inputs"]})
    return out
