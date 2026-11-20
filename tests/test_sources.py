import helpers  # noqa: F401  (temp data folder + no network, before valora)

import json
import unittest
import urllib.error
from urllib.parse import parse_qs, urlparse

from valora import config, db as D, net, props as PR
from valora.sources import acs, hud, rentcast

ACS_OK = [["NAME", "B25064_001E", "B19013_001E", "B25002_001E", "B25002_003E", "zip code tabulation area"],
          ["ZCTA5 43201", "1234", "45678", "20000", "2000", "43201"]]
HUD_XWALK = {"data": {"year": "2025", "quarter": "2", "input": "43201", "crosswalk_type": "zip-county",
                      "results": [{"geoid": "39041", "res_ratio": "0.05"}, {"geoid": "39049", "res_ratio": "0.95"}]}}
HUD_FMR = {"data": {"county_name": "Franklin County", "area_name": "Columbus, OH HUD Metro FMR Area", "year": "2026",
                    "smallarea_status": "0",
                    "basicdata": {"Efficiency": 1046, "One-Bedroom": 1129, "Two-Bedroom": "1,355", "Three-Bedroom": 1754,
                                  "Four-Bedroom": 1992, "year": "2026"}}}
HUD_SAFMR = {"data": {"area_name": "Columbus, OH", "year": "2026", "smallarea_status": "1",
                      "basicdata": [{"zip_code": "MSA level", "Efficiency": 1000, "One-Bedroom": 1100, "Two-Bedroom": 1300,
                                     "Three-Bedroom": 1700, "Four-Bedroom": 1900},
                                    {"zip_code": "43201", "Efficiency": 1210, "One-Bedroom": 1330, "Two-Bedroom": 1560,
                                     "Three-Bedroom": 2030, "Four-Bedroom": 2300}]}}
RC_PROP = {"id": "5500-Grand-Lake-Dr", "formattedAddress": "5500 Grand Lake Dr, San Antonio, TX 78244",
           "addressLine1": "5500 Grand Lake Dr", "city": "San Antonio", "state": "TX", "zipCode": "78244", "county": "Bexar",
           "latitude": 29.475962, "longitude": -98.351442, "propertyType": "Single Family", "bedrooms": 3, "bathrooms": 2,
           "squareFootage": 1878, "lotSize": 8843, "yearBuilt": 1973, "lastSaleDate": "2017-10-19T00:00:00.000Z",
           "lastSalePrice": 185000, "features": {"garage": True, "unitCount": 1},
           "taxAssessments": {"2022": {"year": 2022, "value": 225790, "land": 59380, "improvements": 166410},
                              "2023": {"year": 2023, "value": 241000, "land": 61000, "improvements": 180000}},
           "propertyTaxes": {"2022": {"year": 2022, "total": 5340}, "2023": {"year": 2023, "total": 5610}},
           "history": {"2017-10-19": {"event": "Sale", "date": "2017-10-19T00:00:00.000Z", "price": 185000}},
           "owner": {"names": ["Michael Smith", "Jane Smith"], "type": "Individual"}, "ownerOccupied": True}
RC_COMP = {"formattedAddress": "5512 Grand Lake Dr, San Antonio, TX 78244", "latitude": 29.476, "longitude": -98.351,
           "propertyType": "Single Family", "bedrooms": 3, "bathrooms": 2, "squareFootage": 1800, "lotSize": 8000,
           "yearBuilt": 1975, "price": 215000, "listedDate": "2026-05-01T00:00:00.000Z", "removedDate": "2026-07-02T00:00:00.000Z",
           "daysOld": 120, "distance": 0.05, "correlation": 0.97}
RC_VALUE = {"price": 221000, "priceRangeLow": 208000, "priceRangeHigh": 233000, "comparables": [RC_COMP, dict(RC_COMP, price=230000)]}
RC_RENT = {"rent": 1650, "rentRangeLow": 1500, "rentRangeHigh": 1800, "comparables": [dict(RC_COMP, price=1700)]}
RC_LISTING = dict(RC_PROP, price=239000, status="Active", listedDate="2026-10-01T00:00:00.000Z", removedDate=None, daysOnMarket=46)
GEO = {"result": {"addressMatches": [{"matchedAddress": "5500 GRAND LAKE DR, SAN ANTONIO, TX, 78244",
                                      "coordinates": {"x": -98.351442, "y": 29.475962},
                                      "addressComponents": {"zip": "78244", "state": "TX", "city": "SAN ANTONIO"},
                                      "geographies": {"Counties": [{"NAME": "Bexar County", "GEOID": "48029"}],
                                                      "Census Tracts": [{"GEOID": "48029121802"}]}}]}}


def js(o, status=200):
    return status, json.dumps(o).encode()


class DB(unittest.TestCase):
    def setUp(self):
        helpers.fresh_home()
        config.save({"demo": False})
        self._cm = D.db()
        self.c = self._cm.__enter__()

    def tearDown(self):
        self._cm.__exit__(None, None, None)
        acs._down.clear()
        hud._down.clear()


class TestNetCache(DB):
    def test_cache_hit_and_refresh(self):
        with helpers.FakeNet(lambda u, h: js({"n": 1})) as f:
            a = net.cached(self.c, "t", "https://x.test/a", {"b": 2, "a": 1})
            b = net.cached(self.c, "t", "https://x.test/a", {"a": 1, "b": 2})
            self.assertEqual(len(f.calls), 1)
            self.assertEqual(f.calls[0], "https://x.test/a?a=1&b=2")
            self.assertFalse(a["cached"])
            self.assertTrue(b["cached"])
            self.assertEqual(b["data"], {"n": 1})
            net.cached(self.c, "t", "https://x.test/a", {"a": 1, "b": 2}, refresh=True)
            self.assertEqual(len(f.calls), 2)

    def test_non_json_is_reported_not_cached(self):
        with helpers.FakeNet(lambda u, h: (200, b"<html>captive portal</html>")) as f:
            r = net.cached(self.c, "t", "https://x.test/h")
            self.assertEqual(r["status"], 502)
            self.assertIn("captive", r["data"]["error"])
            net.cached(self.c, "t", "https://x.test/h")
            self.assertEqual(len(f.calls), 2)                # not cached
        with helpers.FakeNet(lambda u, h: (200, b"")) as f:
            self.assertIsNone(net.cached(self.c, "t", "https://x.test/e")["data"])
        with helpers.FakeNet(lambda u, h: (200, b"\xff\xfe garbage")) as f:
            self.assertEqual(net.cached(self.c, "t", "https://x.test/g")["status"], 502)

    def test_errors_not_cached_and_cost_counted(self):
        with helpers.FakeNet(lambda u, h: js({"message": "nope"}, 401)) as f:
            r = net.cached(self.c, "rc", "https://x.test/p", cost=1)
            net.cached(self.c, "rc", "https://x.test/p", cost=1)
            self.assertEqual((r["status"], len(f.calls)), (401, 2))
        self.assertEqual(net.usage(self.c, "rc"), 2)

    def test_ttl(self):
        with helpers.FakeNet(lambda u, h: js([1])) as f:
            net.cached(self.c, "t", "https://x.test/t", ttl_days=1)
            self.c.execute("update api_cache set fetched_at='2000-01-01T00:00:00+00:00'")
            net.cached(self.c, "t", "https://x.test/t", ttl_days=1)
            net.cached(self.c, "t", "https://x.test/t")       # no ttl: any age is fine
            self.assertEqual(len(f.calls), 2)


class TestACS(DB):
    def test_no_key(self):
        self.assertEqual(acs.zcta(self.c, "43201"), acs.empty("43201"))
        self.assertTrue(all(v is None for k, v in acs.empty("43201").items() if k != "zip"))

    def test_parse(self):
        r = acs.parse(ACS_OK, "43201", 2024)
        self.assertEqual((r["median_rent"], r["median_income"], r["housing_units"], r["vacant_units"]), (1234, 45678, 20000, 2000))
        self.assertAlmostEqual(r["vacancy_rate"], 0.1)
        self.assertIn("2020–2024", r["source"])
        bad = [ACS_OK[0], ["ZCTA5 43201", "-666666666", None, "0", "0", "43201"]]
        r = acs.parse(bad, "43201", 2023)
        self.assertIsNone(r["median_rent"])
        self.assertIsNone(r["median_income"])
        self.assertIsNone(r["vacancy_rate"])
        for junk in (None, {}, [], [["a"]], "x", [ACS_OK[0], ["ZCTA5 1", "1", "1", "1", "1", "99999"]]):
            self.assertIsNone(acs.parse(junk, "43201", 2024))

    def test_fetch_falls_back_a_vintage_and_caches(self):
        config.save({"census_key": "k"})

        def h(url, headers):
            q = parse_qs(urlparse(url).query)
            self.assertEqual(q["for"], ["zip code tabulation area:43201"])
            return (404, b"error: unknown/unsupported geography hierarchy") if "/2024/" in url else js(ACS_OK)
        with helpers.FakeNet(h) as f:
            r = acs.zcta(self.c, "43201")
            self.assertEqual(r["year"], 2023)
            acs.zcta(self.c, "43201")
            self.assertEqual(len(f.calls), 3)                # 2024 404 (not cached) + 2023, then 2024 again + cache hit
        self.assertEqual(acs.zcta(self.c, "abcde")["median_rent"], None)

    def test_network_error_is_null_and_not_retried_at_once(self):
        config.save({"census_key": "k"})

        def boom(url, headers):
            raise urllib.error.URLError("offline")
        with helpers.FakeNet(boom) as f:
            self.assertIsNone(acs.zcta(self.c, "43201"))
            self.assertIsNone(acs.zcta(self.c, "43201"))
            self.assertEqual(len(f.calls), 1)


class TestHUD(DB):
    def test_no_token(self):
        self.assertIsNone(hud.fmr(self.c, "43201"))

    def test_parsers(self):
        self.assertEqual(hud.county_for_zip(HUD_XWALK), "39049")
        self.assertIsNone(hud.county_for_zip({"data": {"results": []}}))
        self.assertIsNone(hud.county_for_zip(None))
        f = hud.parse_fmr(HUD_FMR, "43201")
        self.assertEqual(f["rents"], {"0": 1046, "1": 1129, "2": 1355, "3": 1754, "4": 1992})
        self.assertFalse(f["small_area"])
        self.assertEqual(f["year"], "2026")
        self.assertIn("Columbus", f["source"])
        s = hud.parse_fmr(HUD_SAFMR, "43201")
        self.assertTrue(s["small_area"])
        self.assertEqual(s["rents"]["2"], 1560)
        m = hud.parse_fmr(HUD_SAFMR, "43299")                # ZIP not listed: metro row
        self.assertFalse(m["small_area"])
        self.assertEqual(m["rents"]["2"], 1300)
        for junk in (None, {}, {"data": []}, {"data": {"basicdata": {}}}, {"data": {"basicdata": [{"zip_code": "1"}]}}):
            self.assertIsNone(hud.parse_fmr(junk, "43201"))

    def test_fetch(self):
        config.save({"hud_token": "tok"})

        def h(url, headers):
            self.assertEqual(headers.get("Authorization"), "Bearer tok")
            if "/usps" in url:
                return js(HUD_XWALK)
            self.assertTrue(url.endswith("/fmr/data/3904999999"), url)
            return js(HUD_FMR)
        with helpers.FakeNet(h) as f:
            r = hud.fmr(self.c, "43201")
            self.assertEqual(r["rents"]["3"], 1754)
            hud.fmr(self.c, "43201")
            self.assertEqual(len(f.calls), 2)                # cached
        with helpers.FakeNet(lambda u, h: js({"error": "Unauthorized"}, 401)):
            self.assertIsNone(hud.fmr(self.c, "43202"))
        with helpers.FakeNet(lambda u, h: (200, b"<html>")):
            self.assertIsNone(hud.fmr(self.c, "43203"))

        def boom(url, headers):
            raise TimeoutError("slow")
        with helpers.FakeNet(boom) as f:
            self.assertIsNone(hud.fmr(self.c, "43204"))
            self.assertIsNone(hud.fmr(self.c, "43204"))
            self.assertEqual(len(f.calls), 1)


class TestRentCast(DB):
    def test_normalisers(self):
        p = rentcast.prop_row(RC_PROP)
        self.assertEqual((p["address"], p["zip"], p["beds"], p["baths"], p["sqft"], p["year_built"], p["units"]),
                         ("5500 Grand Lake Dr, San Antonio, TX 78244", "78244", 3, 2, 1878, 1973, 1))
        self.assertEqual((p["last_sale_date"], p["owner_name"], p["owner_occupied"]), ("2017-10-19", "Michael Smith, Jane Smith", 1))
        self.assertEqual(rentcast.taxes(RC_PROP), [
            {"year": 2022, "assessed_total": 225790, "assessed_land": 59380, "assessed_impr": 166410, "tax_amount": 5340},
            {"year": 2023, "assessed_total": 241000, "assessed_land": 61000, "assessed_impr": 180000, "tax_amount": 5610}])
        self.assertEqual(rentcast.history(RC_PROP), [{"date": "2017-10-19", "price": 185000, "kind": "Sale"}])
        cr = rentcast.comp_row(RC_COMP, "sale")
        self.assertEqual((cr["date"], cr["distance"], cr["price"], cr["kind"]), ("2026-07-02", 0.05, 215000, "sale"))
        prop, lst = rentcast.listing_row(RC_LISTING, "sale")
        self.assertEqual((lst["price"], lst["status"], lst["listed"], lst["removed"], lst["dom"]), (239000, "Active", "2026-10-01", None, 46))
        bare = rentcast.prop_row({})
        self.assertEqual((bare["address"], bare["units"], bare["owner_name"], bare["owner_occupied"], bare["last_sale_date"]),
                         (None, 1, None, None, None))
        self.assertEqual(rentcast.taxes({}), [])
        self.assertEqual(rentcast.history({"history": {"2020-01-02": {}}}), [{"date": "2020-01-02", "price": None, "kind": "Sale"}])

    def test_no_key_and_budget(self):
        with self.assertRaises(rentcast.NoKey):
            rentcast.call(self.c, "/properties", {"address": "x"})
        config.save({"rentcast_key": "k", "rentcast_budget": 0})
        self.c.execute("insert into api_usage values (?, 'rentcast', 50)", (net.month(),))
        with self.assertRaises(rentcast.OverBudget):
            rentcast.call(self.c, "/properties", {"address": "x"})
        s = rentcast.status(self.c)
        self.assertEqual((s["used"], s["allowance"], s["billable"]), (50, 50, 0))

    def test_lookup_end_to_end(self):
        config.save({"rentcast_key": "k"})

        def h(url, headers):
            if "geocoding.geo.census.gov" in url:
                return js(GEO)
            self.assertEqual(headers.get("X-Api-Key"), "k")
            if "/v1/properties" in url:
                return js([RC_PROP])
            if "/avm/value" in url:
                return js(RC_VALUE)
            if "/avm/rent" in url:
                return js(RC_RENT)
            return 404, b"{}"
        with helpers.FakeNet(h) as f:
            r = PR.lookup(self.c, "5500 Grand Lake Dr, San Antonio, TX 78244")
            self.assertEqual(r["notes"], [])
            prof = PR.profile(self.c, r["id"])
            self.assertEqual(prof["property"]["sqft"], 1878)
            self.assertEqual(prof["property"]["lat"], 29.475962)
            self.assertEqual([x["year"] for x in prof["parcels"]], [2022, 2023])
            self.assertEqual((prof["value"]["value"], prof["value"]["low"], prof["value"]["n"]), (221000, 208000, 2))
            self.assertEqual(prof["rent"]["value"], 1650)
            self.assertEqual(len([x for x in prof["comps"] if x["kind"] == "sale"]), 2)
            self.assertEqual(prof["tax"], {"amount": 5610, "src": "2023 tax bill"})
            n = len(f.calls)
            again = PR.lookup(self.c, "5500 Grand Lake Dr, San Antonio, TX 78244")    # all from cache
            self.assertEqual(again["id"], r["id"])
            self.assertEqual(len(f.calls), n)
        self.assertEqual(net.usage(self.c, "rentcast"), 3)
        self.assertEqual(len(D.rows(self.c, "select id from parcel")), 2)        # replaced, not duplicated
        comps = PR.comps_analysis(self.c, r["id"])
        self.assertEqual(comps["value"]["n"], 2)
        self.assertEqual(comps["rent_value"]["n"], 1)

    def test_lookup_offline_keeps_address(self):
        r = PR.lookup(self.c, "1 Nowhere Rd, Columbus, OH 43201")         # network blocked, no key
        self.assertTrue(any("geocoded" in n for n in r["notes"]))
        self.assertTrue(any("RentCast" in n for n in r["notes"]))
        self.assertEqual(PR.get(self.c, r["id"])["address"], "1 Nowhere Rd, Columbus, OH 43201")


if __name__ == "__main__":
    unittest.main()
