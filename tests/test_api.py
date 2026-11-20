import helpers  # noqa: F401  (temp data folder + no network, before valora)

import base64
import json
import threading
import unittest
import urllib.error
from datetime import date
from pathlib import Path

from valora import config, db as D, demo, server as S
from valora.sources import acs, hud

FIX = Path(__file__).parent / "fixtures"


def get(path, **q):
    r = S.api_get(path, {k: str(v) for k, v in q.items()})
    assert r is not None, f"{path} is not an API route"
    return r[0], json.loads(r[1])


def post(path, body=None):
    code, raw = S.api_post(path, body or {}, cli=True)
    return code, json.loads(raw)


class API(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        helpers.fresh_home()
        with D.db(True) as c:
            demo.build(c)
        cls.owned = get("/api/owned_props")[1]
        with D.db(True) as c:
            cls.listed = c.execute("select property_id from listing where status='Active' limit 1").fetchone()[0]
            cls.lease = c.execute("select id from lease where status='active' limit 1").fetchone()[0]

    def ok(self, path, **q):
        code, body = get(path, **q)
        self.assertEqual(code, 200, (path, q, body))
        return body


class TestGet(API):
    def test_state(self):
        s = self.ok("/api/state")
        for k in ("config", "demo", "job", "rentcast", "counts", "rates", "market", "today", "data_dir"):
            self.assertIn(k, s)
        self.assertTrue(s["demo"])
        self.assertEqual(s["counts"]["owned"], 3)
        self.assertGreater(s["counts"]["listings"], 200)
        for k in ("has_rentcast_key", "has_census_key", "has_hud_token", "has_google_key"):
            self.assertIs(s["config"][k], False)
        self.assertNotIn("rentcast_key", s["config"])
        self.assertIn(helpers.os.environ["VALORA_HOME"], s["data_dir"])

    def test_streetview(self):
        sv = self.ok("/api/streetview", lat=39.99, lon=-83.0)
        self.assertIn("viewpoint=39.99,-83.0", sv["link"])
        self.assertIsNone(sv["embed"])
        self.assertIn("query=", sv["maps"])
        junk = self.ok("/api/streetview", lat="abc", lon="999")
        self.assertIn("viewpoint=0.0,180.0", junk["link"])

    def test_listings(self):
        r = self.ok("/api/listings")
        self.assertGreater(len(r["rows"]), 200)
        row = r["rows"][0]
        for k in ("id", "address", "price", "status", "listed", "dom", "rent_est", "rent_src", "value_est", "ppsf", "cap", "coc",
                  "cf", "dscr", "grm", "one_pct", "score", "score_parts", "discount", "momentum"):
            self.assertIn(k, row)
        self.assertEqual(set(row["score_parts"]), set(r["weights"]))
        self.assertEqual(r["notes"], [])
        f = self.ok("/api/listings", zip="43201", min_price=100000, max_price=400000, min_beds=2)
        self.assertTrue(all(x["zip"] == "43201" and 100000 <= x["price"] <= 400000 and x["beds"] >= 2 for x in f["rows"]))
        self.assertEqual(len(self.ok("/api/listings", min_price="abc")["rows"]), len(r["rows"]))

    def test_property_and_comps(self):
        p = self.ok(f"/api/property/{self.listed}")
        for k in ("property", "listing", "listings", "parcels", "sales", "value", "rent", "comps", "zip", "zhvi", "zori", "deal",
                  "scenarios", "owned", "docs", "ctx", "quick", "tax", "missing"):
            self.assertIn(k, p)
        self.assertEqual(p["value"]["source"], "DEMO estimate")
        self.assertIn("rate", p["ctx"])
        self.assertEqual(get("/api/property/999999")[0], 404)
        self.assertEqual(get("/api/property/abc")[0], 404)
        self.assertEqual(get("/api/property/")[0], 404)
        c = self.ok(f"/api/comps/{self.listed}")
        self.assertEqual(set(c), {"sale", "rent", "value", "rent_value"})
        self.assertTrue(all({"id", "price", "adjusted", "lines", "gross_adj", "dist_mi", "included"} <= set(x) for x in c["sale"]))
        self.assertEqual(c["value"]["n"], len([x for x in c["sale"] if x["included"]]))
        self.assertEqual(self.ok("/api/comps/999999")["sale"], [])
        self.assertEqual(get("/api/comps/x")[0], 404)

    def test_find_market_zips(self):
        self.assertTrue(self.ok("/api/find", q="Columbus"))
        self.assertEqual(self.ok("/api/find", q="%"), [])
        m = self.ok("/api/market", zip="43201")
        self.assertEqual(set(m["rates"]), {"MORTGAGE30US", "DGS10", "RRVRUSQ156N", "CSUSHPINSA"})
        self.assertEqual(set(m["zip"]), {"zhvi", "zori"})
        self.assertIn("zip_snap", m)
        self.assertIsNone(m["acs"])
        self.assertIsNone(m["fmr"])
        self.assertNotIn("acs", self.ok("/api/market"))
        self.assertIsInstance(self.ok("/api/zips", state="oh", metro="Columbus"), list)

    def test_pipeline_routes(self):
        b = self.ok("/api/pipeline")
        self.assertEqual(len(b["stages"]), 7)
        self.assertEqual(len(b["deals"]), 9)
        for k in ("address", "open_tasks", "next_due", "lat", "lon", "stage"):
            self.assertIn(k, b["deals"][0])
        d = self.ok(f"/api/deal/{b['deals'][0]['id']}")
        self.assertEqual(set(d), {"deal", "events", "tasks"})
        self.assertEqual(get("/api/deal/x")[0], 404)

    def test_portfolio_routes(self):
        p = self.ok("/api/portfolio")
        self.assertEqual(len(p["properties"]), 3)
        for k in ("value", "value_src", "debt", "equity", "ltv", "noi", "income", "opex", "ds", "cf", "cap_on_value", "units_n",
                  "occupied", "occupancy", "rent_roll", "arrears", "cost", "gain", "dscr", "debts", "purchase_price", "purchase_date"):
            self.assertIn(k, p["properties"][0])
        for k in ("value", "debt", "equity", "noi", "ds", "cf", "units", "occupied", "arrears", "rent_roll", "cost", "ltv",
                  "occupancy", "cap", "dscr"):
            self.assertIn(k, p["total"])
        self.assertEqual((p["total"]["units"], p["total"]["occupied"]), (7, 6))
        self.assertGreater(p["total"]["arrears"], 0)                       # the demo has one late payer
        self.assertEqual(len(p["monthly"]), 24)
        self.assertEqual(set(p["monthly"][0]), {"month", "income", "opex", "noi", "debt", "cf"})
        rr = self.ok("/api/rentroll")
        self.assertEqual(len(rr), 7)
        for k in ("id", "property_id", "address", "name", "market_rent", "status", "lease_id", "tenant", "start", "end", "rent",
                  "current_rent", "deposit", "balance", "aging", "days_left", "loss_to_lease", "escalation", "late_fee", "due_day",
                  "lease_status"):
            self.assertIn(k, rr[0])
        pid = self.owned[0]["id"]
        self.assertTrue(all(r["property_id"] == pid for r in self.ok("/api/rentroll", property=pid)))
        self.assertEqual(self.ok("/api/rentroll", property="99999999999999999999999"), rr)   # junk id = unfiltered
        # posting is idempotent: a second read adds nothing
        with D.db(True) as c:
            n = c.execute("select count(*) from ledger_entry").fetchone()[0]
        self.ok("/api/portfolio")
        with D.db(True) as c:
            self.assertEqual(c.execute("select count(*) from ledger_entry").fetchone()[0], n)

    def test_ledger_books_routes(self):
        all_ = self.ok("/api/ledger")
        self.assertTrue(all_ and {"tenant", "unit", "address", "property_id", "type", "amount"} <= set(all_[0]))
        self.assertGreaterEqual(all_[0]["date"], all_[-1]["date"])
        lg = self.ok(f"/api/ledger/{self.lease}")
        self.assertEqual(set(lg), {"entries", "balance", "aging", "prepaid", "lease"})
        self.assertEqual(lg["entries"][-1]["running"], lg["balance"])
        self.assertEqual(get("/api/ledger/x")[0], 404)
        ex = self.ok("/api/expenses", property=self.owned[0]["id"], year=date.today().year)
        self.assertTrue(all(r["date"].startswith(str(date.today().year)) for r in ex["rows"]))
        self.assertIn("Repairs", ex["categories"])
        for q in ({"property": "1e30"}, {"year": "abc"}, {"property": "nan"}, {"year": "1e400"}):
            self.assertEqual(get("/api/expenses", **q)[0], 200, q)
        debts = self.ok("/api/debts")
        self.assertEqual(len(debts), 3)
        for k in ("address", "months_paid", "payment", "balance", "pi_year", "escrow", "schedule"):
            self.assertIn(k, debts[0])
        self.assertEqual(len(debts[0]["schedule"]), 30)
        for route in ("/api/maintenance", "/api/tenants", "/api/units", "/api/owned_props", "/api/searches"):
            self.assertIsInstance(self.ok(route), list, route)
        inbox = self.ok("/api/inbox")
        self.assertEqual(set(inbox), {"docs", "extractions", "txns", "leases", "properties", "categories"})
        self.assertIsNone(self.ok("/api/doc/999"))
        se = self.ok("/api/schedule_e", year=date.today().year)
        self.assertEqual((se["year"], len(se["properties"])), (date.today().year, 3))
        self.assertEqual(self.ok("/api/schedule_e", year="1e400")["year"], date.today().year)
        self.assertEqual(self.ok("/api/schedule_e", year="99999")["year"], date.today().year)

    def test_unknown_routes_and_odd_queries(self):
        self.assertIsNone(S.api_get("/index.html", {}))
        self.assertIsNone(S.api_get("/api/nope", {}))
        self.assertEqual(S.api_post("/api/nope", {})[0], 404)
        self.assertEqual(S.api_get("/api/listings", {"zip": ["a", "b"], "min_price": 5})[0], 200)   # non-string values dropped
        for path, q in (("/api/find", {"q": "\x00'\";--"}), ("/api/market", {"zip": "'; drop table market_snap; --", "metro": "\\"}),
                        ("/api/zips", {"state": "' or 1=1"}), ("/api/listings", {"kind": "x' or '1'='1", "type": "%"})):
            code, _ = S.api_get(path, q)
            self.assertEqual(code, 200, (path, q))
        with D.db(True) as c:
            self.assertGreater(c.execute("select count(*) from property").fetchone()[0], 200)

    def test_concurrent_reads(self):
        errs = []

        def work():
            try:
                for p in ("/api/portfolio", "/api/rentroll", "/api/listings", "/api/state"):
                    code, _ = S.api_get(p, {})
                    assert code == 200, p
            except Exception as e:      # pragma: no cover
                errs.append(e)
        ts = [threading.Thread(target=work) for _ in range(6)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(errs, [])


class TestPost(API):
    def test_underwrite_all_strategies(self):
        code, a = post("/api/underwrite", {"strategy": "rental", "inputs": {"price": 200000, "rent_month": 2000}})
        self.assertEqual(code, 200)
        for k in ("loan", "cash_in", "payment", "debt_year", "noi", "cap", "cash_flow", "cash_flow_month", "coc", "dscr", "grm",
                  "one_pct", "breakeven_occ", "opex_ratio", "sale", "net_sale", "irr", "multiple", "flows", "proforma", "sens", "amort",
                  "offer_coc_6", "offer_coc_8", "offer_coc_10", "offer_dscr_125", "inputs"):
            self.assertIn(k, a)
        for k in ("year", "gross", "vacancy", "egi", "opex", "noi", "capex", "debt", "cash_flow", "balance", "taxes", "insurance", "mgmt", "maint"):
            self.assertIn(k, a["proforma"][0])
        b = post("/api/underwrite", {"strategy": "brrrr", "inputs": {"price": 100000, "rehab": 30000, "arv": 180000, "rent_month": 1600}})[1]
        self.assertEqual(set(b), {"all_in", "loan", "cash_out", "left_in", "payment", "cash_flow_month", "coc", "infinite", "equity"})
        f = post("/api/underwrite", {"strategy": "flip", "inputs": {"price": 150000, "rehab": 40000, "arv": 260000}})[1]
        self.assertEqual(set(f), {"profit", "costs", "cash", "roi", "annualized", "rule70", "margin"})
        self.assertEqual(post("/api/underwrite", {"inputs": {"price": "1e400", "appreciation": 1e9}})[0], 200)

    def test_property_round_trip(self):
        code, r = post("/api/property/add", {"address": "742 Evergreen Ter, Columbus, OH 43201", "zip": "43201", "beds": "3",
                                             "baths": "", "sqft": "1,450", "price": "189000", "units": "1"})
        self.assertEqual(code, 200)
        pid = r["id"]
        p = self.ok(f"/api/property/{pid}")
        self.assertEqual((p["property"]["beds"], p["property"]["baths"], p["property"]["sqft"]), (3, None, 1450))
        self.assertEqual(p["listing"]["price"], 189000)
        self.assertIn("quick", p)
        self.assertEqual(post("/api/property/add", {"address": "742 Evergreen Terrace, Columbus, OH 43201"})[1]["id"], pid)
        self.assertIn("error", post("/api/property/add", {"address": " "})[1])
        self.assertEqual(post("/api/property/add", {"address": "1 Bad St", "beds": "three"})[0], 400)
        post("/api/property/edit", {"id": pid, "data": {"beds": "4", "notes": "corner lot", "owned": 1, "address": "x"}})
        p = self.ok(f"/api/property/{pid}")["property"]
        self.assertEqual((p["beds"], p["notes"], p["owned"]), (4, "corner lot", 0))
        self.assertEqual(post("/api/property/edit", {"id": pid, "data": {"sqft": "big"}})[0], 400)
        post("/api/property/value", {"id": pid, "kind": "value", "value": "205,000"})
        self.assertEqual(self.ok(f"/api/property/{pid}")["value"]["value"], 205000)
        self.assertEqual(post("/api/property/value", {"id": pid, "value": "nan"})[0], 400)
        self.assertEqual(post("/api/property/value", {"id": pid, "value": "x"})[0], 400)
        self.assertEqual(post("/api/property/value", {"id": pid, "kind": "bogus", "value": 1})[0], 400)
        self.assertTrue(any(x["id"] == pid for x in self.ok("/api/find", q="742 evergreen")))

    def test_comps_round_trip(self):
        sid = self.listed
        post("/api/comp", {"act": "add", "subject_id": sid, "kind": "sale", "address": "9 Comp St", "price": "250,000",
                           "beds": 3, "baths": 2, "sqft": "1500", "year_built": 1990, "date": "2026-10-01", "distance": "-0.5"})
        c = self.ok(f"/api/comps/{sid}")
        mine = [x for x in c["sale"] if x["price"] == 250000]
        self.assertEqual(len(mine), 1)
        self.assertEqual(post("/api/comp", {"act": "toggle", "id": mine[0]["id"], "included": False})[1], {"ok": True})
        c2 = self.ok(f"/api/comps/{sid}")
        self.assertFalse([x for x in c2["sale"] if x["id"] == mine[0]["id"]][0]["included"])
        self.assertEqual(c2["value"]["n"], c["value"]["n"] - 1)
        self.assertEqual(post("/api/comp", {"act": "add", "subject_id": sid, "kind": "sale", "price": "lots"})[0], 400)

    def test_scenario_weights_searches(self):
        pid = self.listed
        r1 = post("/api/scenario", {"property_id": pid, "name": "Base", "strategy": "rental", "inputs": {"price": 1}, "outputs": {"coc": 0.1}})[1]
        r2 = post("/api/scenario", {"property_id": pid, "name": "Base", "strategy": "rental", "inputs": {"price": 2}, "outputs": {}})[1]
        self.assertEqual(r1["id"], r2["id"])
        sc = self.ok(f"/api/property/{pid}")["scenarios"]
        self.assertEqual(json.loads(sc[0]["inputs"]), {"price": 2})
        post("/api/weights", {"cashflow": "50", "cap": -3, "risk": "abc"})
        w = self.ok("/api/listings")["weights"]
        self.assertEqual((w["cashflow"], w["cap"], w["risk"]), (50, 0, 10))
        post("/api/weights", dict.fromkeys(w, 20))
        post("/api/searches", {"name": "Cheap", "query": {"max_price": 150000}})
        s = self.ok("/api/searches")
        self.assertEqual([x["name"] for x in s], ["Cheap"])
        self.assertEqual(json.loads(s[0]["query"]), {"max_price": 150000})
        post("/api/searches", {"delete": s[0]["id"]})
        self.assertEqual(self.ok("/api/searches"), [])
        self.assertEqual(post("/api/searches", {"query": {}})[0], 400)

    def test_pipeline_round_trip(self):
        with D.db(True) as c:
            pid = c.execute("select l.property_id from listing l left join deal d on d.property_id=l.property_id where d.id is null limit 1").fetchone()[0]
        did = post("/api/pipeline", {"act": "add", "property_id": pid, "ask": 199000})[1]["id"]
        self.assertEqual(post("/api/pipeline", {"act": "move", "id": did, "stage": "diligence"})[1], {"ok": True})
        d = self.ok(f"/api/deal/{did}")
        self.assertEqual(d["deal"]["stage"], "diligence")
        self.assertEqual(len(d["tasks"]), len(set(t["title"] for t in d["tasks"])))
        self.assertIn("error", post("/api/pipeline", {"act": "move", "id": did, "stage": "won"})[1])
        self.assertEqual(post("/api/pipeline", {"act": "move", "stage": "offer"})[0], 400)
        post("/api/pipeline", {"act": "move", "id": did, "stage": "acquired"})
        self.assertTrue(any(p["id"] == pid for p in self.ok("/api/owned_props")))
        post("/api/pipeline", {"act": "delete", "id": did})
        self.assertEqual(get(f"/api/deal/{did}")[1]["deal"], None)

    def test_portfolio_round_trip(self):
        pid = self.owned[0]["id"]
        uid = post("/api/portfolio", {"act": "add", "table": "unit", "data": {"property_id": pid, "name": "Z", "market_rent": "1,300"}})[1]["id"]
        lid = post("/api/portfolio", {"act": "add", "table": "lease", "tenant_name": "Robin Test",
                                      "data": {"unit_id": uid, "start": date.today().replace(day=1).isoformat(), "rent": "1250",
                                               "late_fee": 50, "end": date(date.today().year + 1, 12, 31).isoformat()}})[1]["id"]
        rr = {r["id"]: r for r in self.ok("/api/rentroll", property=pid)}
        self.assertEqual((rr[uid]["tenant"], rr[uid]["rent"], rr[uid]["lease_id"]), ("Robin Test", 1250, lid))
        # this month's rent was posted on read; rent due on the 1st and unpaid after the 5-day grace (from the 6th) also
        # carries the $50 late fee
        owed = 1250 + (50 if date.today().day >= 6 else 0)
        self.assertEqual(rr[uid]["balance"], owed)
        post("/api/portfolio", {"act": "add", "table": "entry", "data": {"lease_id": lid, "date": date.today().isoformat(),
                                                                         "type": "payment", "amount": f"{owed:,}"}})
        lg = self.ok(f"/api/ledger/{lid}")
        self.assertEqual(lg["balance"], 0)
        self.assertEqual(lg["lease"]["tenant"], "Robin Test")
        self.assertEqual(post("/api/portfolio", {"act": "edit", "table": "lease", "id": lid, "data": {"rent": "abc"}})[0], 400)
        r = post("/api/portfolio", {"act": "renew", "id": lid, "rent": 1300, "years": 2})[1]
        self.assertIn("id", r)
        self.assertEqual(self.ok(f"/api/ledger/{r['id']}")["lease"]["rent"], 1300)
        self.assertEqual(post("/api/portfolio", {"act": "end_lease", "id": r["id"], "end": "2030-01-31"})[1], {"ok": True})
        x = post("/api/portfolio", {"act": "add", "table": "expense", "data": {"property_id": pid, "date": date.today().isoformat(),
                                                                                "category": "Repairs", "amount": "$95.50"}})[1]
        rows = self.ok("/api/expenses", property=pid)["rows"]
        self.assertEqual([e["amount"] for e in rows if e["id"] == x["id"]], [95.5])
        post("/api/portfolio", {"act": "delete", "table": "expense", "id": x["id"]})
        self.assertFalse([e for e in self.ok("/api/expenses", property=pid)["rows"] if e["id"] == x["id"]])
        dbt = post("/api/portfolio", {"act": "add", "table": "debt", "data": {"property_id": pid, "lender": "Test", "principal": "100000",
                                                                               "rate": "", "years": "", "start": ""}})[1]["id"]
        debts = {d["id"]: d for d in self.ok("/api/debts")}
        self.assertEqual(debts[dbt]["schedule"], [])               # blank term: no schedule, no crash
        self.assertIn("error", post("/api/portfolio", {"act": "add", "table": "bogus"})[1])
        self.assertIn("error", post("/api/portfolio", {"act": "frobnicate"})[1])
        self.assertEqual(post("/api/portfolio", {"act": "renew"})[0], 400)
        self.ok("/api/portfolio")

    def test_owned_add(self):
        pid = post("/api/property/add", {"address": "55 Owned Way, Columbus, OH 43206"})[1]["id"]
        post("/api/portfolio", {"act": "add", "table": "owned", "data": {"property_id": pid, "purchase_price": "250000",
                                                                         "purchase_date": "2024-05-01"}})
        self.assertTrue(any(p["id"] == pid for p in self.ok("/api/portfolio")["properties"]))
        self.assertIn("error", post("/api/portfolio", {"act": "add", "table": "owned", "data": {}})[1])
        post("/api/portfolio", {"act": "delete", "table": "owned", "id": pid})
        self.assertFalse(any(p["id"] == pid for p in self.ok("/api/portfolio")["properties"]))

    def test_import_and_upload(self):
        r = post("/api/import/text", {"text": "1200 Test Ave, Columbus, OH 43201 $210,000 3 bd 2 ba 1,400 sqft\n"})[1]
        self.assertEqual(r["rows"], 1)
        self.assertEqual(r["found"][0][:13], "1200 Test Ave")
        csv_text = "ADDRESS,CITY,STATE OR PROVINCE,ZIP OR POSTAL CODE,PRICE,BEDS,BATHS,SQUARE FEET\n77 Upload St,Columbus,OH,43201,199000,3,1,1200\n"
        u = post("/api/upload", {"name": "redfin.csv", "data": base64.b64encode(csv_text.encode()).decode()})[1]
        self.assertEqual((u["kind"], u["rows"]), ("listings", 1))
        bank = (FIX / "bank_chase_nov2026.csv").read_bytes()
        d = post("/api/upload", {"name": "bank.csv", "data": base64.b64encode(bank).decode(), "kind": "bank_csv"})[1]
        self.assertFalse(d["dup"])
        inbox = self.ok("/api/inbox")
        self.assertTrue(any(x["id"] == d["id"] for x in inbox["docs"]))
        self.assertTrue(inbox["txns"])
        self.assertTrue(post("/api/upload", {"name": "bank.csv", "data": base64.b64encode(bank).decode(), "kind": "bank_csv"})[1]["dup"])
        self.assertIn("accepted", post("/api/inbox", {"act": "accept_all", "min": 0.99})[1])
        post("/api/inbox", {"act": "delete_doc", "id": d["id"]})
        self.assertFalse(any(x["id"] == d["id"] for x in self.ok("/api/inbox")["docs"]))
        self.assertEqual(post("/api/upload", {"name": "x.csv"})[0], 400)

    def test_bad_bodies(self):
        self.assertEqual(S.api_post("/api/scenario", None)[0], 400)
        self.assertEqual(S.api_post("/api/scenario", ["not", "a", "dict"])[0], 400)
        self.assertEqual(post("/api/estimate", {"id": "abc"})[0], 200)       # reported as {error}
        self.assertEqual(post("/api/lookup", {})[0], 400)


class TestSettingsAndMarket(unittest.TestCase):
    def setUp(self):
        helpers.fresh_home()
        acs._down.clear()
        hud._down.clear()

    def test_settings_round_trip(self):
        code, s = post("/api/settings", {"rentcast_key": "secret", "home_zip": " 43201 ", "rentcast_budget": "25", "bogus": 1})
        self.assertEqual(code, 200)
        self.assertTrue(s["config"]["has_rentcast_key"])
        self.assertEqual((s["config"]["home_zip"], s["config"]["rentcast_budget"]), ("43201", 25))
        self.assertNotIn("secret", json.dumps(s))
        self.assertFalse(post("/api/settings", {"demo": "false"})[1]["demo"])
        self.assertFalse(config.load()["demo"])
        s = post("/api/settings", {"demo": True})[1]
        self.assertTrue(s["demo"])
        self.assertGreater(s["counts"]["properties"], 0)          # switching to demo builds it when empty
        self.assertEqual(post("/api/settings", {"rentcast_budget": "lots"})[1]["config"]["rentcast_budget"], 25)
        self.assertEqual(post("/api/market/refresh", {})[1], {"started": False})
        code, r = post("/api/demo/reset")
        self.assertEqual((code, r["owned"]), (200, 3))

    def test_market_acs_fmr(self):
        config.save({"census_key": "ck", "hud_token": "ht"})
        from test_sources import ACS_OK, HUD_FMR, HUD_XWALK, js

        def h(url, headers):
            if "api.census.gov" in url:
                return js(ACS_OK)
            return js(HUD_XWALK) if "/usps" in url else js(HUD_FMR)
        with helpers.FakeNet(h):
            m = get("/api/market", zip="43201")[1]
        self.assertEqual(m["acs"]["median_rent"], 1234)
        self.assertEqual(m["fmr"]["rents"]["2"], 1355)

        def boom(url, headers):
            raise urllib.error.URLError("offline")
        with helpers.FakeNet(boom):
            m = get("/api/market", zip="43202")[1]
        self.assertIsNone(m["acs"])
        self.assertIsNone(m["fmr"])
        self.assertEqual(get("/api/market", zip="abc")[0], 200)


class TestDemo(unittest.TestCase):
    def test_build_is_deterministic(self):
        helpers.fresh_home()

        def snapshot():
            with D.db(True) as c:
                demo.build(c)
                return {t: [tuple(r) for r in c.execute(f"select {cols} from {t} order by id")] for t, cols in (
                    ("property", "id, address, beds, baths, sqft, lat, lon, units"), ("listing", "property_id, price, listed"),
                    ("valuation", "property_id, kind, value"), ("comp", "subject_id, price, address"),
                    ("lease", "unit_id, start, end, rent"), ("ledger_entry", "lease_id, date, type, amount"),
                    ("expense", "property_id, date, amount"), ("debt", "property_id, principal, rate"),
                    ("deal", "property_id, stage, ask"), ("task", "deal_id, title, due"))}
        a, b = snapshot(), snapshot()
        for t in a:
            self.assertEqual(a[t], b[t], t)
        self.assertEqual(len(a["property"]), 243)
        self.assertEqual(len({r[1] for r in a["property"]}), 243)          # no two demo addresses collide
        with D.db(True) as c:
            norms = [r[0] for r in c.execute("select address_norm from property")]
        self.assertEqual(len(norms), len(set(norms)))


if __name__ == "__main__":
    unittest.main()
