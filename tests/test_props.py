import helpers  # noqa: F401  (temp data folder + no network, before valora)

import json
import unittest
from datetime import date

from valora import config, db as D, props as PR, uw


class TestNormAddress(unittest.TestCase):
    N = staticmethod(D.norm_address)

    def test_equivalent_forms(self):
        a = self.N("123 North Main Street, Columbus, OH 43201")
        for b in ("123 N. Main St., Columbus, OH 43201-1234", "123 n main st columbus oh 43201, USA",
                  "123 N Main St, Columbus, OH 43201, United States", "  123  N  MAIN  ST , COLUMBUS , OH 43201 "):
            self.assertEqual(self.N(b), a, b)
        self.assertEqual(self.N("9 Oak Ave Apt #2"), self.N("9 Oak Avenue Unit 2"))
        self.assertEqual(self.N("9 Oak Ave #2"), "9 oak ave apt 2")

    def test_distinct_addresses_do_not_collide(self):
        pairs = [("123 Main St Apt 1", "123 Main St Apt 2"), ("12 1/2 Oak St", "12 Oak St"), ("12 1/2 Oak St", "12 1 2 Oak St"),
                 ("123 Main St, Columbus, OH 43201", "123 Main St, Columbus, OH 43202"), ("123 E Main St", "123 W Main St"),
                 ("1 Main St", "11 Main St"), ("12-34 56th St", "1234 56th St")]
        for a, b in pairs:
            self.assertNotEqual(self.N(a), self.N(b), (a, b))

    def test_degenerate(self):
        self.assertEqual(self.N(""), "")
        self.assertEqual(self.N(None), "")
        self.assertEqual(self.N("!!! ###"), "apt")
        self.assertEqual(self.N("USA"), "")


class DB(unittest.TestCase):
    def setUp(self):
        helpers.fresh_home()
        config.save({"demo": False})
        self._cm = D.db()
        self.c = self._cm.__enter__()

    def tearDown(self):
        self._cm.__exit__(None, None, None)

    def listing(self, address, price, zip_="43201", **p):
        dom = p.pop("dom", None)
        pid = PR.upsert(self.c, {"address": address, "zip": zip_, "city": "Columbus", **p})
        D.insert(self.c, "listing", {"property_id": pid, "kind": "sale", "price": price, "status": "Active",
                                     "listed": "2026-11-01", "dom": dom})
        return pid

    def snap(self, zip_, metric, latest, chg1y):
        D.insert(self.c, "market_snap", {"geo_type": "zip", "geo_id": zip_, "metric": metric, "latest": latest,
                                         "chg1y": chg1y, "as_of": "2026-10-31"})


class TestUpsertFind(DB):
    def test_upsert_merges_same_address(self):
        a = PR.upsert(self.c, {"address": "77 Elm Street, Columbus, OH 43201", "beds": 3})
        b = PR.upsert(self.c, {"address": "77 ELM ST, Columbus, OH 43201-0001", "sqft": 1400, "beds": None})
        self.assertEqual(a, b)
        p = PR.get(self.c, a)
        self.assertEqual((p["beds"], p["sqft"], p["address"]), (3, 1400, "77 Elm Street, Columbus, OH 43201"))
        self.assertNotEqual(a, PR.upsert(self.c, {"address": "77 Elm St Apt 2, Columbus, OH 43201"}))
        with self.assertRaises(ValueError):
            PR.upsert(self.c, {"address": "  , "})

    def test_find(self):
        a = PR.upsert(self.c, {"address": "100 Main St, Columbus, OH 43201", "zip": "43201", "city": "Columbus"})
        PR.upsert(self.c, {"address": "200 Oak Ave, Dayton, OH 45402", "zip": "45402", "city": "Dayton"})
        self.assertEqual([r["id"] for r in PR.find(self.c, "100 main street")], [a])
        self.assertEqual([r["id"] for r in PR.find(self.c, str(a))], [a])
        self.assertEqual(len(PR.find(self.c, "45402")), 1)
        self.assertEqual(PR.find(self.c, "%"), [])           # wildcards are literal
        self.assertEqual(PR.find(self.c, "_"), [])
        self.assertEqual(PR.find(self.c, ""), [])
        self.assertEqual(PR.find(self.c, "9" * 40), [])
        self.assertEqual(len(PR.find(self.c, "dayton")), 1)
        self.assertEqual(PR.find(self.c, "'; drop table property; --"), [])
        self.assertEqual(len(D.rows(self.c, "select id from property")), 2)


class TestQuickScore(DB):
    def test_no_price_gives_none_fields(self):
        pid = PR.upsert(self.c, {"address": "1 A St"})
        q = PR.quick(self.c, PR.get(self.c, pid))
        self.assertEqual(set(q), set(PR.QUICK_KEYS))
        self.assertTrue(all(v is None for v in q.values()))
        self.assertTrue(all(v is None for v in PR.quick(self.c, {"id": pid, "price": "abc"}).values()))
        self.assertTrue(all(v is None for v in PR.quick(self.c, {"id": pid, "price": -5}).values()))

    def test_missing_rent_and_value(self):
        pid = self.listing("2 B St", 200000, units=0, beds=None, sqft=0, year_built=0)
        row = dict(PR.get(self.c, pid), price=200000)
        q = PR.quick(self.c, row)
        for k in ("rent_est", "value_est", "ppsf", "cap", "coc", "cf", "dscr", "discount", "momentum"):
            self.assertIsNone(q[k], k)
        self.assertEqual(q["score_parts"]["risk"], 75)        # no value estimate
        self.assertEqual(q["score"], 75)                     # only the risk factor is known

    def test_zip_rent_fallback_with_odd_units_and_beds(self):
        self.snap("43201", "zori", 1500, 0.04)
        for units, beds, per in ((0, None, 1.0), (None, 0, 0.75), (2, 6, 1.18), (1, "abc", 1.0), (4, 4, 0.85)):
            pid = self.listing(f"{units}-{beds} C St", 250000, units=units, beds=beds)
            r = PR.rent_est(self.c, PR.get(self.c, pid))
            n = units if units and units > 1 else 1
            self.assertAlmostEqual(r["value"], 1500 * per * n, msg=(units, beds))
            self.assertIn("rough", r["source"])
            q = PR.quick(self.c, dict(PR.get(self.c, pid), price=250000))
            self.assertIsNotNone(q["coc"])

    def test_full_quick_matches_underwriting(self):
        self.snap("43201", "zhvi", 300000, 0.06)
        self.snap("43201", "zori", 1600, 0.02)
        pid = self.listing("3 D St", 200000, beds=3, sqft=1600, year_built=1990, dom=60)
        D.insert(self.c, "valuation", {"property_id": pid, "kind": "value", "value": 230000, "low": 210000, "high": 250000, "source": "RentCast AVM"})
        D.insert(self.c, "valuation", {"property_id": pid, "kind": "rent", "value": 2000, "low": 1800, "high": 2200, "source": "RentCast AVM"})
        row = dict(PR.get(self.c, pid), price=200000, dom=60)
        q = PR.quick(self.c, row)
        a = uw.analyse(PR.default_deal(self.c, row, 200000, 2000))
        self.assertAlmostEqual(q["coc"], a["coc"])
        self.assertAlmostEqual(q["cap"], a["cap"])
        self.assertAlmostEqual(q["ppsf"], 125)
        self.assertAlmostEqual(q["discount"], 0.15)
        self.assertAlmostEqual(q["momentum"], 0.04)
        parts = q["score_parts"]
        self.assertAlmostEqual(parts["discount"], 100)
        self.assertAlmostEqual(parts["momentum"], (0.04 + 0.04) / 0.12 * 100)
        self.assertAlmostEqual(parts["negotiable"], 50)
        self.assertAlmostEqual(parts["risk"], 100 - 0.2 * 60)
        w = PR.DEFAULT_WEIGHTS
        self.assertAlmostEqual(q["score"], sum(parts[k] * w[k] for k in w) / sum(w.values()))

    def test_weights(self):
        self.assertEqual(PR.weights(self.c), PR.DEFAULT_WEIGHTS)
        D.insert(self.c, "search", {"name": "__weights", "query": json.dumps({"cashflow": 0, "cap": 0, "discount": 0, "momentum": 0,
                                                                              "negotiable": 0, "risk": "7", "junk": 5})})
        w = PR.weights(self.c)
        self.assertEqual(w["risk"], 7)
        self.assertNotIn("junk", w)
        pid = self.listing("4 E St", 200000)
        q = PR.quick(self.c, dict(PR.get(self.c, pid), price=200000))
        self.assertEqual(q["score"], q["score_parts"]["risk"])
        self.c.execute("update search set query='not json' where name='__weights'")
        self.assertEqual(PR.weights(self.c), PR.DEFAULT_WEIGHTS)
        self.c.execute("update search set query='[1,2]' where name='__weights'")
        self.assertEqual(PR.weights(self.c), PR.DEFAULT_WEIGHTS)
        zero = {k: 0 for k in PR.DEFAULT_WEIGHTS}
        self.assertIsNone(PR.quick(self.c, dict(PR.get(self.c, pid), price=200000), w=zero)["score"])


class TestSearch(DB):
    def setUp(self):
        super().setUp()
        self.a = self.listing("10 A St", 150000, beds=2, baths=1, sqft=900, year_built=1950, units=1, type="Single Family")
        self.b = self.listing("20 B St", 300000, beds=4, baths=2, sqft=2000, year_built=2000, units=2, type="Multi-Family")
        self.z = self.listing("30 C St", 220000, zip_="43206", beds=3, baths=2, sqft=1500, year_built=1980, units=1, type="Single Family")
        D.insert(self.c, "listing", {"property_id": self.a, "kind": "sale", "price": 140000, "status": "Sold", "listed": "2020-01-01"})

    def ids(self, **q):
        return sorted(r["id"] for r in PR.search_listings(self.c, q)["rows"])

    def test_filters(self):
        self.assertEqual(self.ids(), sorted([self.a, self.b, self.z]))
        self.assertEqual(self.ids(min_price="200000"), sorted([self.b, self.z]))
        self.assertEqual(self.ids(max_price="200000"), [self.a])
        self.assertEqual(self.ids(min_beds="3", max_sqft="1600"), [self.z])
        self.assertEqual(self.ids(min_year="1990"), [self.b])
        self.assertEqual(self.ids(min_units="2"), [self.b])
        self.assertEqual(self.ids(zip="43206"), [self.z])
        self.assertEqual(self.ids(city="COLUMBUS"), sorted([self.a, self.b, self.z]))
        self.assertEqual(self.ids(type="Multi-Family"), [self.b])
        self.assertEqual(self.ids(kind="rent"), [])

    def test_junk_filters_are_ignored(self):
        everything = sorted([self.a, self.b, self.z])
        for q in ({"min_price": "abc"}, {"max_price": "1e999"}, {"min_beds": "nan"}, {"min_sqft": ""}, {"min_year": None},
                  {"min_baths": "inf"}):
            self.assertEqual(self.ids(**q), everything, q)
        self.assertEqual(self.ids(zip="' or 1=1 --"), [])
        r = PR.search_listings(self.c, {})
        self.assertEqual(r["weights"], PR.DEFAULT_WEIGHTS)
        self.assertTrue(all(set(PR.QUICK_KEYS) <= set(row) for row in r["rows"]))

    def test_fetch_without_key_notes_it(self):
        r = PR.search_listings(self.c, {"fetch": True, "zip": "43201"})
        self.assertTrue(any("RentCast" in n for n in r["notes"]))


class TestUnderwrite(unittest.TestCase):
    def test_blank_inputs_use_defaults(self):
        a = PR.underwrite({"strategy": "rental", "inputs": {"price": "200000", "rent_month": "2000", "vacancy": "", "taxes_year": "2400",
                                                           "insurance_year": "1200", "exit_cap": None, "io": "", "hold": "abc"}})
        ref = uw.analyse(uw.Deal(price=200000, rent_month=2000, taxes_year=2400, insurance_year=1200))
        for k in ("noi", "cap", "coc", "dscr", "irr", "sale"):
            self.assertAlmostEqual(a[k], ref[k], msg=k)
        self.assertIsNone(a["inputs"]["exit_cap"])
        self.assertEqual(a["inputs"]["hold"], 10)
        self.assertEqual(len(a["sens"]["grid"]), 5)
        self.assertEqual(a["sens"]["metric"], "coc")
        self.assertAlmostEqual(a["sens"]["grid"][2][2], a["coc"])
        self.assertIsNotNone(a["offer_coc_8"])
        self.assertEqual(len(a["amort"]), 30)

    def test_exit_cap_and_flags(self):
        a = PR.underwrite({"inputs": {"price": 200000, "rent_month": 2000, "exit_cap": "0"}})
        self.assertIsNone(a["inputs"]["exit_cap"])
        a = PR.underwrite({"inputs": {"price": 200000, "rent_month": 2000, "exit_cap": "0.07", "io": "false", "hold": "5.7", "years": "0"}})
        self.assertEqual(a["inputs"]["exit_cap"], 0.07)
        self.assertFalse(a["inputs"]["io"])
        self.assertEqual(a["inputs"]["hold"], 5)
        self.assertEqual(a["inputs"]["years"], 1.0)
        self.assertTrue(PR.underwrite({"inputs": {"price": 1, "rent_month": 1, "io": "yes"}})["inputs"]["io"])

    def test_sensitivity_choice(self):
        a = PR.underwrite({"inputs": {"price": 200000, "rent_month": 2000}, "sens": {"row": "rate", "col": "vacancy", "metric": "irr"}})
        self.assertEqual(a["sens"]["row"][0], "rate")
        self.assertEqual(a["sens"]["col"][0], "vacancy")
        self.assertEqual(a["sens"]["metric"], "irr")
        b = PR.underwrite({"inputs": {"price": 200000, "rent_month": 2000}, "sens": {"row": "exit_cap", "col": "__class__", "metric": "x"}})
        self.assertEqual((b["sens"]["row"][0], b["sens"]["col"][0], b["sens"]["metric"]), ("price", "rent_month", "coc"))

    def test_garbage_and_extremes_do_not_crash(self):
        for inputs in ({}, {"price": "", "rent_month": ""}, {"price": "1e400", "rent_month": "nan"}, {"price": 1e300, "rent_month": 1e300},
                       {"price": 200000, "rent_month": 2000, "appreciation": 1e9, "hold": 50}, {"price": 200000, "rate": -12},
                       {"price": 200000, "rent_month": 2000, "rent_growth": -5, "down": 7}):
            a = PR.underwrite({"inputs": inputs})
            self.assertIn("coc", a)
        self.assertIsNotNone(PR.underwrite({"inputs": "not a dict"}))
        z = PR.underwrite({"inputs": {}})
        self.assertIsNone(z["cap"])

    def test_brrrr_and_flip_coercion(self):
        b = PR.underwrite({"strategy": "brrrr", "inputs": {"price": "50000", "rehab": "20000", "arv": "150000", "rent_month": "1500",
                                                          "opex_month": "400", "hold_months": "6.9", "junk": 1, "years": ""}})
        ref = uw.brrrr(50000, 20000, 150000, 1500, 400, hold_months=6)
        self.assertEqual(b, ref)
        self.assertTrue(b["infinite"])
        f = PR.underwrite({"strategy": "flip", "inputs": {"price": "150000", "rehab": "40000", "arv": "260000", "months": ""}})
        self.assertEqual(f, uw.flip(150000, 40000, 260000))
        e = PR.underwrite({"strategy": "flip", "inputs": {}})
        self.assertEqual(e["profit"], 0)
        x = PR.underwrite({"strategy": "flip", "inputs": {"price": 1, "rehab": 0, "arv": 1e300, "months": 1}})
        self.assertIn("annualized", x)
        y = PR.underwrite({"strategy": "brrrr", "inputs": {"refi_rate": -12, "years": 0, "arv": 100000}})
        self.assertIn("payment", y)


if __name__ == "__main__":
    unittest.main()
