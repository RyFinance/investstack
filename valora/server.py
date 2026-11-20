"""Local server: JSON API + the web app. `python -m valora serve [port]` → http://127.0.0.1:8780
All routes are in api_get / api_post, also reachable from the CLI (`python -m valora api GET /api/state`)."""
from __future__ import annotations

import base64
import json
import math
import threading
import time
import traceback
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import config, db as D, demo, jobs, paths, pipeline, portfolio, props, uw
from .ingest import files
from .sources import acs, custom, fred, hud, rentcast, zillow

PORT = 8780


def _clean(o):
    """NaN / inf are not JSON: they become null (the page shows a dash)."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    return o


def _dump(o) -> bytes:
    try:
        return json.dumps(o, default=lambda v: None, allow_nan=False).encode()
    except ValueError:
        return json.dumps(_clean(o), default=lambda v: None).encode()


def _id(path: str) -> int | None:
    """Trailing integer id of a route like /api/property/12, or None when it is missing or not a number."""
    t = path.rstrip("/").rsplit("/", 1)[-1]
    return int(t) if t.isdigit() and len(t) < 16 else None


def _int(v, default=None):
    """An integer from a query value, or `default` for blanks, junk, NaN/inf and values SQLite cannot hold."""
    try:
        x = int(float(v)) if v not in (None, "") else default
    except (TypeError, ValueError, OverflowError):
        return default
    return x if x is None or -2 ** 63 < x < 2 ** 63 else default


def _flt(v, default=0.0):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return x if math.isfinite(x) else default


NOT_FOUND = 404, _dump({"error": "not found"})


def state() -> dict:
    cfg = config.public()
    with D.db() as c:
        counts = {t: c.execute(f"select count(*) from {q}").fetchone()[0] for t, q in (
            ("listings", "listing where status='Active'"), ("properties", "property"), ("owned", "property where owned=1"),
            ("deals", "deal where stage not in ('acquired','rejected')"), ("tasks_due", "task where done=0 and due<=date('now','+3 day')"),
            ("inbox", "document where status in ('new','read','no_text')"),
            ("txns", "bank_txn where coalesce(matched,'') not like '%\"done\": true%'"))}
        rates = {k: fred.latest(c, k) for k in ("MORTGAGE30US", "MORTGAGE15US", "DGS10")}
        rc = rentcast.status(c)
        mk = c.execute("select max(as_of) a, count(*) n from market_snap where geo_type='zip' and metric='zhvi'").fetchone()
    return {"config": cfg, "demo": bool(cfg.get("demo")), "job": jobs.JOB.state(), "rentcast": rc, "counts": counts,
            "rates": rates, "market": {"zips": mk["n"], "as_of": mk["a"]}, "today": date.today().isoformat(),
            "data_dir": str(paths.home())}


def market(c, q: dict) -> dict:
    z, metro = q.get("zip"), q.get("metro")
    out = {"rates": {k: D.rows(c, "select date, value from market_series where geo_type='us' and metric=? and date>=date('now','-10 years') order by date", (k,))
                     for k in ("MORTGAGE30US", "DGS10", "RRVRUSQ156N", "CSUSHPINSA")}}
    if z:
        z = str(z).strip()[:10]
        out["zip"] = {m: zillow.series(c, "zip", z, m)[-180:] for m in ("zhvi", "zori")}
        out["zip_snap"] = D.rows(c, "select * from market_snap where geo_type='zip' and geo_id=?", (z,))
        mname = next((r["metro"] for r in out["zip_snap"] if r.get("metro")), None)
        if mname and not metro:
            m = D.one(c, "select geo_id from market_snap where geo_type='metro' and name=?", (mname,))
            metro = m and m["geo_id"]
    if metro:
        out["metro"] = {m: D.rows(c, "select date, value from market_series where geo_type='metro' and geo_id=? and metric=? order by date", (metro, m))[-180:]
                        for m in ("zhvi", "zori")}
        out["metro_snap"] = D.rows(c, "select * from market_snap where geo_type='metro' and geo_id=?", (metro,))
    if z:                                      # optional Census ACS and HUD FMR figures: null without a key or on failure
        out["acs"] = acs.zcta(c, z) if config.load().get("census_key") else None
        out["fmr"] = hud.fmr(c, z) if config.load().get("hud_token") else None
    return out


def zips(c, q: dict) -> list[dict]:
    """Every ZIP with both indexes: value, rent, gross yield, 1y/5y changes. Filter by state or metro."""
    where, args = ["h.geo_type='zip'", "h.metric='zhvi'"], []
    if q.get("state"):
        where.append("h.state=?"); args.append(q["state"].upper())
    if q.get("metro"):
        where.append("h.metro like ?"); args.append(f"%{q['metro']}%")
    rows = D.rows(c, f"""select h.geo_id as zip, h.name as city, h.state, h.metro, h.latest as value, h.chg1y as value_1y, h.chg5y as value_5y,
        r.latest as rent, r.chg1y as rent_1y, r.chg5y as rent_5y, h.as_of
        from market_snap h left join market_snap r on r.geo_type='zip' and r.metric='zori' and r.geo_id=h.geo_id
        where {' and '.join(where)} limit 40000""", args)
    for r in rows:
        r["yield"] = r["rent"] * 12 / r["value"] if r.get("rent") and r.get("value") else None
    return rows


def api_get(path: str, q: dict | None = None):
    q = {k: v for k, v in (q or {}).items() if isinstance(v, str)}
    try:
        return _get(path, q)
    except (KeyError, ValueError, OverflowError) as e:
        return 400, _dump({"error": f"bad request: {e}"})


def _get(path: str, q: dict):
    if path == "/api/state":
        return 200, _dump(state())
    if path == "/api/streetview":
        lat, lon = max(-90.0, min(90.0, _flt(q.get("lat")))), max(-180.0, min(180.0, _flt(q.get("lon"))))
        key = config.load().get("google_key")
        return 200, _dump({
            "link": f"https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={lat},{lon}",
            "maps": f"https://www.google.com/maps/search/?api=1&query={lat},{lon}",
            "embed": f"https://www.google.com/maps/embed/v1/streetview?key={key}&location={lat},{lon}&fov=80" if key else None})
    with D.db() as c:
        if path == "/api/listings":
            return 200, _dump(props.search_listings(c, q))
        if path.startswith("/api/property/"):
            p = props.profile(c, _id(path)) if _id(path) is not None else None
            return (200, _dump(p)) if p else (404, _dump({"error": "no such property"}))
        if path.startswith("/api/comps/"):
            if _id(path) is None:
                return NOT_FOUND
            return 200, _dump(props.comps_analysis(c, _id(path)))
        if path == "/api/find":
            return 200, _dump(props.find(c, q.get("q", "")))
        if path == "/api/market":
            return 200, _dump(market(c, q))
        if path == "/api/zips":
            return 200, _dump(zips(c, q))
        if path == "/api/overview":
            from . import overview
            return 200, _dump(overview.build(c))
        if path == "/api/properties":
            from . import overview
            return 200, _dump(overview.register(c))
        if path.startswith("/api/develop/"):
            from . import develop
            p = props.profile(c, _id(path))
            if not p:
                return 404, _dump({"error": "no such property"})
            pr = p["property"]
            price = (p.get("listing") or {}).get("price") or (p.get("deal") or {}).get("ask") or (p.get("value") or {}).get("value")
            saved = [x for x in p.get("scenarios", []) if x.get("strategy") == "develop"]
            lst, deal, val = p.get("listing") or {}, p.get("deal") or {}, p.get("value") or {}
            src = (pr.get("source") or "record")
            prov = {
                "lot_sqft": {"status": "illustrative" if src == "DEMO" else "verified", "source": f"Property record ({src})", "updated": (pr.get("fetched_at") or "")[:10]}
                if pr.get("lot") else {"status": "assumed", "source": "No lot size on record: default", "updated": None},
                "land": {"status": "illustrative" if lst.get("source") == "DEMO" else "verified", "source": f"Asking price, {lst.get('source') or 'listing'}", "updated": lst.get("listed")} if lst.get("price")
                else {"status": "manual", "source": "Deal ask", "updated": (deal.get("stage_entered") or "")[:10]} if deal.get("ask")
                else {"status": "estimated", "source": val.get("source") or "value estimate", "updated": val.get("as_of")} if val.get("value")
                else {"status": "assumed", "source": "No price on record", "updated": None},
            }
            return 200, _dump({"defaults": develop.defaults_for(pr, price), "presets": develop.PRESETS, "uses": develop.USES, "saved": saved, "prov": prov})
        if path == "/api/pipeline":
            return 200, _dump(pipeline.board(c))
        if path.startswith("/api/deal/"):
            if _id(path) is None:
                return NOT_FOUND
            return 200, _dump(pipeline.detail(c, _id(path)))
        if path == "/api/portfolio":
            return 200, _dump(portfolio.overview(c))
        if path == "/api/rentroll":
            return 200, _dump(portfolio.rent_roll(c, _int(q.get("property"))))
        if path.startswith("/api/ledger/"):
            lid = _id(path)
            if lid is None:
                return NOT_FOUND
            return 200, _dump({"entries": portfolio.ledger(c, lid), **portfolio.lease_balance(c, lid),
                               "lease": D.one(c, "select l.*, t.name as tenant, u.name as unit, p.address from lease l join unit u on u.id=l.unit_id join property p on p.id=u.property_id left join tenant t on t.id=l.tenant_id where l.id=?", (lid,))})
        if path == "/api/ledger":
            return 200, _dump(D.rows(c, """select e.*, t.name as tenant, u.name as unit, p.address, p.id as property_id from ledger_entry e
                join lease l on l.id=e.lease_id join unit u on u.id=l.unit_id join property p on p.id=u.property_id
                left join tenant t on t.id=l.tenant_id order by e.date desc, e.id desc limit 3000"""))
        if path == "/api/expenses":
            where, args = ["1=1"], []
            if _int(q.get("property")) is not None:
                where.append("x.property_id=?"); args.append(_int(q["property"]))
            if _int(q.get("year")) is not None:
                where.append("substr(x.date,1,4)=?"); args.append(str(_int(q["year"])))
            return 200, _dump({"rows": D.rows(c, f"select x.*, p.address from expense x join property p on p.id=x.property_id where {' and '.join(where)} order by x.date desc", args),
                               "categories": portfolio.SCHED_E})
        if path == "/api/debts":
            out = []
            for d in D.rows(c, "select d.*, p.address from debt d join property p on p.id=d.property_id"):
                st = portfolio.debt_state(d)
                out.append({**d, **st, "schedule": uw.amortization(*portfolio._loan(d))})     # blank fields → 0, never a crash
            return 200, _dump(out)
        if path == "/api/maintenance":
            return 200, _dump(D.rows(c, "select m.*, p.address, u.name as unit from maintenance m join property p on p.id=m.property_id left join unit u on u.id=m.unit_id order by (m.status='closed'), m.opened desc"))
        if path == "/api/tenants":
            return 200, _dump(D.rows(c, """select t.*, l.id as lease_id, l.rent, l.start, l.end, l.status, u.name as unit, p.address
                from tenant t left join lease l on l.tenant_id=t.id left join unit u on u.id=l.unit_id left join property p on p.id=u.property_id order by t.name"""))
        if path == "/api/inbox":
            docs = D.rows(c, "select id, name, kind, pages, imported, status, property_id from document order by imported desc")
            ex = D.rows(c, "select * from extraction order by document_id, page, line")
            for e in ex:
                e["value"] = _json(e["value"], None)
            txns = D.rows(c, "select * from bank_txn order by date desc limit 2000")
            for t in txns:
                t["matched"] = _json(t["matched"], {})
            return 200, _dump({"docs": docs, "extractions": ex, "txns": txns,
                               "leases": D.rows(c, "select l.id, t.name as tenant, u.name as unit, p.address, l.rent from lease l join unit u on u.id=l.unit_id join property p on p.id=u.property_id left join tenant t on t.id=l.tenant_id where l.status in ('active','notice')"),
                               "properties": D.rows(c, "select id, address from property where owned=1"),
                               "categories": portfolio.SCHED_E})
        if path.startswith("/api/doc/"):
            d = D.one(c, "select id, name, kind, pages, text, status from document where id=?", (_id(path),))
            return 200, _dump(d)
        if path == "/api/schedule_e":
            y = _int(q.get("year"), date.today().year)
            return 200, _dump(portfolio.schedule_e(c, y if 1900 <= y <= 2200 else date.today().year))
        if path == "/api/owned_props":
            return 200, _dump(D.rows(c, "select id, address, units from property where owned=1 order by id"))
        if path == "/api/units":
            return 200, _dump(D.rows(c, "select u.*, p.address from unit u join property p on p.id=u.property_id where p.owned=1 order by p.id, u.name"))
        if path == "/api/searches":
            return 200, _dump(D.rows(c, "select * from search where name!='__weights' order by id desc"))
    return None


def _json(s, default):
    try:
        return json.loads(s) if s else default
    except (TypeError, ValueError):
        return default


def api_post(path: str, b: dict | None = None, cli: bool = False):
    b = b if isinstance(b, dict) else {}
    try:
        return _post(path, b, cli)
    except (KeyError, ValueError, TypeError, OverflowError) as e:          # missing / malformed field in the body
        return 400, _dump({"error": f"bad request: {type(e).__name__}: {e}"})


def _post(path: str, b: dict, cli: bool = False):
    if path == "/api/setup/providers":
        action = b.get("act")
        if action == "list":
            return 200, _dump({"providers": custom.public()})
        if action == "save":
            return 200, _dump(custom.save(b))
        if action == "remove":
            return 200, _dump(custom.remove(b.get("id")))
        if action in ("save-credential", "drop-credential"):
            return 200, _dump(custom.credential(b))
        with D.db() as c:
            if action == "preview":
                return 200, _dump(custom.preview(c, b))
            if action == "apply":
                return 200, _dump(custom.apply(c, b.get("token")))
        return 400, _dump({"error": "Choose an action for this provider"})
    if path == "/api/settings":
        if "demo" in b:
            on = props._flag(b["demo"])                     # "false" from a form is False, not a truthy string
            config.save({"demo": on})
            if on:
                with D.db(True) as c:
                    if not c.execute("select count(*) from property").fetchone()[0]:
                        demo.build(c)
        config.save({k: v for k, v in b.items() if k not in ("demo", "connectors_json")})
        return 200, _dump(state())
    if path == "/api/market/refresh":
        return 200, _dump({"started": False if cli else jobs.JOB.start(refresh=bool(b.get("force")))})
    if path == "/api/develop":
        from . import develop
        inp = b.get("inputs") or {}
        lat, lon = b.get("lat"), b.get("lon")
        out = develop.model(inp, float(lat) if lat is not None else None, float(lon) if lon is not None else None)
        out["scenarios"] = develop.scenarios(inp)
        return 200, _dump(out)
    if path == "/api/underwrite":
        return 200, _dump(props.underwrite(b))
    with D.db() as c:
        if path == "/api/demo/reset":
            config.save({"demo": True})
            with D.db(True) as cd:
                return 200, _dump(demo.build(cd))
        if path == "/api/lookup":
            return 200, _dump(props.lookup(c, b["address"], bool(b.get("refresh"))))
        if path == "/api/estimate":
            try:
                props.estimate(c, int(b["id"]), bool(b.get("refresh")))
                return 200, _dump({"ok": True})
            except Exception as e:
                return 200, _dump({"error": str(e)})
        if path == "/api/listings":
            return 200, _dump(props.search_listings(c, {**b, "fetch": True}, bool(b.get("refresh"))))
        if path == "/api/import/text":
            from .ingest import listings
            return 200, _dump(listings.import_text(c, b.get("text", ""), b.get("source") or "pasted", geocode=not cli or bool(b.get("geocode"))))
        if path == "/api/property/add":
            if not D.norm_address(b.get("address") or ""):
                return 200, _dump({"error": "an address is required"})
            row = D.clean(c, "property", {k: v for k, v in b.items() if k in ("address", "city", "state", "zip", "type", "beds", "baths", "sqft", "lot", "year_built", "units", "lat", "lon")})
            pid = props.upsert(c, {k: (v if v != "" else None) for k, v in row.items()} | {"source": "manual"})
            notes = []
            if str(row.get("state") or "").upper() == "BC":
                notes = props.lookup_bc_property(c, row["address"], existing=props.get(c, pid))["notes"]
            if props._num(b.get("price")):
                D.insert(c, "listing", {"property_id": pid, "kind": "sale", "price": float(b["price"]), "status": "Active",
                                        "listed": date.today().isoformat(), "source": "manual"})
            return 200, _dump({"id": pid, "notes": notes})
        if path == "/api/property/edit":
            data = b.get("data") if isinstance(b.get("data"), dict) else {}
            data = D.clean(c, "property", {k: v for k, v in data.items() if k in ("beds", "baths", "sqft", "lot", "year_built", "units", "type", "notes", "tags")})
            D.update(c, "property", int(b["id"]), {k: (v if v != "" else None) for k, v in data.items()})
            return 200, _dump({"ok": True})
        if path in ("/api/property/listing-data", "/api/property/bc-location"):
            from . import property_data

            pid = int(b["id"])
            if not props.get(c, pid):
                return NOT_FOUND
            if path.endswith("/listing-data"):
                if b.get("preview") is True:
                    return 200, _dump({"facts": property_data.listing_facts(str(b.get("text") or ""))})
                c.execute("begin immediate")
                return 200, _dump(property_data.apply_listing(c, pid, b))
            address = str(b.get("address") or "").strip()
            if not 8 <= len(address) <= 240:
                raise ValueError("enter a complete B.C. street address")
            if b.get("site"):
                c.execute("begin immediate")
                return 200, _dump(property_data.save_bc(c, pid, address, str(b["site"])))
            return 200, _dump(property_data.lookup_bc(c, address))
        if path == "/api/property/municipal-data":
            from .sources import municipal

            pid = int(b["id"])
            if not props.get(c, pid):
                return NOT_FOUND
            token = str(b.get("token") or "")
            if token:
                c.execute("begin immediate")
                return 200, _dump(municipal.apply(c, pid, token))
            return 200, _dump(municipal.preview(c, pid, b))
        if path == "/api/property/value":
            v = D.coerce("value", "real", b["value"])
            if v is None or b.get("kind", "value") not in ("value", "rent"):
                return 400, _dump({"error": "value must be a number and kind 'value' or 'rent'"})
            D.insert(c, "valuation", {"property_id": int(b["id"]), "kind": b.get("kind", "value"), "value": v,
                                      "source": b.get("source") or "your figure", "as_of": date.today().isoformat(), "n": 0})
            return 200, _dump({"ok": True})
        if path == "/api/comp":
            if b.get("act") == "toggle":
                c.execute("update comp set included=? where id=?", (1 if b.get("included") else 0, int(b["id"])))
            elif b.get("act") == "add":
                D.insert(c, "comp", {**D.clean(c, "comp", {k: b[k] for k in ("kind", "address", "price", "beds", "baths", "sqft", "year_built", "date", "distance") if k in b}),
                                     "subject_id": int(b["subject_id"]), "source": "manual"})
            return 200, _dump({"ok": True})
        if path == "/api/scenario":
            return 200, _dump({"id": props.scenario_save(c, int(b["property_id"]), b.get("name", "Base case"), b.get("strategy", "rental"),
                                                         b.get("inputs", {}), b.get("outputs", {}))})
        if path == "/api/weights":
            w = {k: max(0.0, props._num(b.get(k))) for k in props.DEFAULT_WEIGHTS if props._num(b.get(k)) is not None}
            w = {**props.weights(c), **w}
            c.execute("delete from search where name='__weights'")
            D.insert(c, "search", {"name": "__weights", "query": json.dumps(w)})
            return 200, _dump({"ok": True})
        if path == "/api/searches":
            if b.get("delete"):
                c.execute("delete from search where id=?", (int(b["delete"]),))
            else:
                D.insert(c, "search", {"name": b["name"], "query": json.dumps(b["query"])})
            return 200, _dump({"ok": True})
        if path == "/api/pipeline":
            return 200, _dump(pipeline.post(c, b))
        if path == "/api/portfolio":
            return 200, _dump(portfolio.post(c, b))
        if path == "/api/upload":
            data = base64.b64decode(b["data"])
            from .ingest import listings
            low = b["name"].lower()
            if low.endswith((".csv", ".tsv", ".txt")) and b.get("kind") in (None, "listings"):
                text = data.decode("utf-8-sig", "replace")
                if listings.is_listings_csv(text):
                    return 200, _dump({"kind": "listings", **listings.import_csv(c, text, b["name"])})
            if low.endswith(".eml") or b.get("kind") == "listings":
                text = listings.eml_text(data) if low.endswith(".eml") else data.decode("utf-8", "replace")
                return 200, _dump({"kind": "listings", **listings.import_text(c, text, f"file: {b['name']}")})
            r = files.store(c, b["name"], data, b.get("kind"), b.get("property_id"))
            if not r.get("dup"):
                r["extract"] = files.extract(c, r["id"])
            return 200, _dump(r)
        if path == "/api/inbox":
            act = b.get("act")
            if act == "accept_txn":
                return 200, _dump(files.accept_txn(c, int(b["id"]), b.get("override")))
            if act == "accept_all":
                n = 0
                for t in D.rows(c, "select id, matched from bank_txn"):
                    m = _json(t["matched"], {})
                    if not m.get("done") and m.get("confidence", 0) >= float(b.get("min", 0.6)):
                        if files.accept_txn(c, t["id"]).get("ok"):
                            n += 1
                return 200, _dump({"accepted": n})
            if act == "apply_doc":
                return 200, _dump(files.apply_doc(c, int(b["id"]), b.get("values", {}), b.get("property_id"), b.get("unit_id")))
            if act == "extract":
                return 200, _dump(files.extract(c, int(b["id"])))
            if act == "delete_doc":
                c.execute("""delete from bank_txn where document_id=? and matched not like '%"done": true%'""", (int(b["id"]),))
                c.execute("delete from document where id=?", (int(b["id"]),))
                return 200, _dump({"ok": True})
            if act == "kind":
                c.execute("update document set kind=? where id=?", (b["kind"], int(b["id"])))
                return 200, _dump(files.extract(c, int(b["id"])))
    return 404, _dump({"error": "not found"})


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(paths.WEB), **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        try:
            r = api_get(u.path, {k: v[-1] for k, v in parse_qs(u.query).items()})
        except Exception as e:
            traceback.print_exc()
            r = 500, _dump({"error": f"{type(e).__name__}: {e}"})
        if r is None:
            return super().do_GET()
        self._send(*r)

    def do_POST(self):
        path = urlparse(self.path).path
        if path in ("/api/setup/providers", "/api/settings"):
            port = self.server.server_address[1]
            hosts = (f"127.0.0.1:{port}", f"localhost:{port}")
            host, origin = self.headers.get("Host"), self.headers.get("Origin")
            if (host not in hosts or (origin and origin != f"http://{host}")
                    or self.headers.get_content_type() != "application/json"
                    or self.headers.get("Sec-Fetch-Site") == "cross-site"):
                return self._send(403, _dump({"error": "Use InvestStack to manage your data connections"}))
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
            r = api_post(path, body)
        except Exception as e:
            traceback.print_exc()
            r = 500, _dump({"error": f"{type(e).__name__}: {e}"})
        self._send(*r)


def boot():
    """First run: build the demo workspace; start the market refresh if indexes are missing."""
    with D.db(True) as c:
        if not c.execute("select count(*) from property").fetchone()[0]:
            demo.build(c)
    try:
        if jobs.JOB.due():
            jobs.JOB.start()
    except Exception:
        traceback.print_exc()


def make_server(port: int = PORT) -> ThreadingHTTPServer:
    boot()
    ThreadingHTTPServer.allow_reuse_address = True
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def serve(port: int = PORT):
    httpd = make_server(port)
    print(f"InvestStack on http://127.0.0.1:{port}", flush=True)
    httpd.serve_forever()
