import helpers  # noqa: F401  (temp data folder + no network, before valora)

import unittest
from dataclasses import asdict

from valora import uw


def D(**k):
    base = dict(price=200000, rent_month=2000, taxes_year=2400, insurance_year=1200)
    return uw.Deal(**{**base, **k})


class TestDebt(unittest.TestCase):
    def test_payment(self):
        self.assertAlmostEqual(uw.payment(300000, 0.06, 30), 1798.65, places=2)
        self.assertAlmostEqual(uw.payment(150000, 0.07, 30), 997.95, places=2)
        self.assertAlmostEqual(uw.payment(120000, 0.0, 10), 1000.0)
        self.assertAlmostEqual(uw.payment(100000, 0.06, 30, io=True), 500.0)
        self.assertEqual(uw.payment(0, 0.06, 30), 0.0)
        self.assertEqual(uw.payment(-5, 0.06, 30), 0.0)

    def test_balance_closed_form(self):
        # 300k at 6% for 30 years: textbook balances after 1 and 5 years
        self.assertAlmostEqual(uw.balance(300000, 0.06, 30, 12), 296315.96, places=2)
        self.assertAlmostEqual(uw.balance(300000, 0.06, 30, 60), 279163.07, places=2)
        self.assertAlmostEqual(uw.balance(300000, 0.06, 30, 360), 0.0, places=4)
        self.assertAlmostEqual(uw.balance(300000, 0.06, 30, 999), 0.0, places=4)      # capped at the term
        self.assertAlmostEqual(uw.balance(300000, 0.06, 30, -3), 300000, places=4)    # never above principal
        self.assertAlmostEqual(uw.balance(120000, 0.0, 10, 60), 60000)
        self.assertEqual(uw.balance(100000, 0.06, 30, 100, io=True), 100000)

    def test_amortization(self):
        sched = uw.amortization(300000, 0.06, 30)
        self.assertEqual(len(sched), 30)
        self.assertAlmostEqual(sched[0]["interest"], 17899.78, places=2)
        self.assertAlmostEqual(sched[0]["balance"], uw.balance(300000, 0.06, 30, 12), places=4)
        self.assertAlmostEqual(sched[4]["balance"], 279163.07, places=2)
        self.assertAlmostEqual(sum(y["principal"] for y in sched), 300000, places=2)
        total_paid = sum(y["interest"] + y["principal"] for y in sched)
        self.assertAlmostEqual(total_paid, uw.payment(300000, 0.06, 30) * 360, places=2)
        self.assertAlmostEqual(sched[-1]["balance"], 0.0, places=6)

    def test_amortization_zero_rate_and_io(self):
        z = uw.amortization(120000, 0.0, 10)
        self.assertEqual(len(z), 10)
        self.assertTrue(all(abs(y["principal"] - 12000) < 1e-6 and y["interest"] == 0 for y in z))
        io = uw.amortization(100000, 0.06, 5, io=True)
        self.assertEqual(len(io), 5)
        self.assertTrue(all(abs(y["interest"] - 6000) < 1e-6 and y["balance"] == 100000 for y in io))


class TestIRR(unittest.TestCase):
    def test_known(self):
        self.assertAlmostEqual(uw.irr([-100, 110]), 0.10, places=6)
        self.assertAlmostEqual(uw.irr([-1000, 300, 400, 500]), 0.0889633947, places=6)
        self.assertAlmostEqual(uw.irr([-100, 0, 0, 133.1]), 0.10, places=6)
        self.assertAlmostEqual(uw.irr([-100, 50]), -0.5, places=6)
        self.assertAlmostEqual(uw.irr([-1, 10]), 9.0, places=5)
        self.assertAlmostEqual(uw.irr([-100, 100]), 0.0, places=6)

    def test_no_sign_change(self):
        self.assertIsNone(uw.irr([100, 50]))
        self.assertIsNone(uw.irr([-100, -50]))
        self.assertIsNone(uw.irr([0, 0, 0]))
        self.assertIsNone(uw.irr([]))

    def test_out_of_range_and_multiple_roots(self):
        self.assertIsNone(uw.irr([-1, 1e6]))                      # root far above 1000%
        # roots at 10% and 20%: the one nearest zero is reported
        self.assertAlmostEqual(uw.irr([-100, 230, -132]), 0.10, places=6)

    def test_npv_at_irr_is_zero(self):
        f = [-56000, 3000, 3200, 3400, 3600, 90000]
        self.assertAlmostEqual(uw.npv(uw.irr(f), f), 0.0, places=4)


class TestRental(unittest.TestCase):
    def test_year1_golden(self):
        # gross 24000, vacancy 1200, EGI 22800; opex = 2400 + 1200 + 8% EGI (1824) + 5% rent (1200) = 6624
        a = uw.analyse(D(hold=5))
        self.assertAlmostEqual(a["noi"], 16176.0, places=6)
        self.assertAlmostEqual(a["cap"], 16176 / 200000)
        self.assertAlmostEqual(a["loan"], 150000)
        self.assertAlmostEqual(a["cash_in"], 56000)
        self.assertAlmostEqual(a["payment"], 997.95, places=2)
        self.assertAlmostEqual(a["cash_flow"], 3000.56, places=2)       # NOI - capex 1200 - debt service
        self.assertAlmostEqual(a["coc"], 0.0535813, places=6)
        self.assertAlmostEqual(a["dscr"], 16176 / (997.9537427687735 * 12), places=9)
        self.assertAlmostEqual(a["grm"], 200000 / 24000)
        self.assertAlmostEqual(a["one_pct"], 0.01)
        self.assertEqual(len(a["flows"]), 6)
        self.assertEqual(len(a["proforma"]), 5)
        self.assertIsNotNone(a["irr"])

    def test_exit_on_year_n_plus_1_noi(self):
        d = D(hold=5, exit_cap=0.08, rent_growth=0.03, exp_growth=0.02)
        a = uw.analyse(d)
        noi6 = uw._year(d, 6)["noi"]
        self.assertGreater(noi6, a["proforma"][-1]["noi"])
        self.assertAlmostEqual(a["sale"], noi6 / 0.08, places=6)
        bal = uw.balance(150000, 0.07, 30, 60)
        self.assertAlmostEqual(a["proforma"][-1]["balance"], bal, places=6)
        self.assertAlmostEqual(a["net_sale"], a["sale"] * 0.94 - bal, places=6)
        self.assertAlmostEqual(a["flows"][-1], a["proforma"][-1]["cash_flow"] + a["net_sale"], places=6)
        # flat growth: exit value is simply NOI / cap
        flat = uw.analyse(D(hold=5, exit_cap=0.08, rent_growth=0, exp_growth=0))
        self.assertAlmostEqual(flat["sale"], 16176 / 0.08, places=6)

    def test_appreciation_exit_when_no_cap(self):
        a = uw.analyse(D(hold=7, exit_cap=None, appreciation=0.04))
        self.assertAlmostEqual(a["sale"], 200000 * 1.04 ** 7, places=6)
        self.assertAlmostEqual(uw.analyse(D(hold=7, exit_cap=0, appreciation=0.04))["sale"], 200000 * 1.04 ** 7, places=6)

    def test_irr_matches_flows(self):
        a = uw.analyse(D(hold=10, exit_cap=0.07))
        self.assertAlmostEqual(uw.npv(a["irr"], a["flows"]), 0.0, places=3)
        self.assertAlmostEqual(a["multiple"], sum(a["flows"][1:]) / a["cash_in"])

    def test_degenerate(self):
        a = uw.analyse(D(hold=0))                      # treated as a one-year hold, no crash
        self.assertEqual(len(a["proforma"]), 1)
        z = uw.analyse(uw.Deal(price=0, rent_month=0))
        self.assertIsNone(z["cap"])
        self.assertIsNone(z["grm"])
        self.assertIsNone(z["one_pct"])
        self.assertIsNone(z["dscr"])
        cash = uw.analyse(D(down=1.0))                 # all cash: no debt service
        self.assertIsNone(cash["dscr"])
        self.assertEqual(cash["payment"], 0.0)

    def test_sensitivity_centre(self):
        d = D()
        s = uw.sensitivity(d, ("price", [180000, 200000, 220000]), ("rent_month", [1800, 2000, 2200]), "coc")
        self.assertAlmostEqual(s["grid"][1][1], uw.analyse(d)["coc"])
        self.assertGreater(s["grid"][0][2], s["grid"][2][0])         # cheaper + more rent is better


class TestMaxOffer(unittest.TestCase):
    def test_hits_target(self):
        d = D()
        for t in (0.06, 0.08, 0.10):
            p = uw.max_offer(d, "coc", t)
            self.assertAlmostEqual(uw.analyse(uw.Deal(**{**asdict(d), "price": p}))["coc"], t, places=4)
        p = uw.max_offer(d, "dscr", 1.25)
        self.assertAlmostEqual(uw.analyse(uw.Deal(**{**asdict(d), "price": p}))["dscr"], 1.25, places=4)

    def test_monotone_in_target(self):
        d = D()
        offers = [uw.max_offer(d, "coc", t) for t in (0.04, 0.06, 0.08, 0.10, 0.12)]
        self.assertTrue(all(a > b for a, b in zip(offers, offers[1:])), offers)
        self.assertGreater(uw.max_offer(d, "dscr", 1.1), uw.max_offer(d, "dscr", 1.4))

    def test_monotone_in_rent(self):
        lo, hi = uw.max_offer(D(rent_month=1800), "coc", 0.08), uw.max_offer(D(rent_month=2400), "coc", 0.08)
        self.assertGreater(hi, lo)

    def test_above_first_bracket(self):
        # asking price far below what the rent supports: the answer is above 3x the price
        d = uw.Deal(price=10000, rent_month=3000)
        p = uw.max_offer(d, "coc", 0.08)
        self.assertGreater(p, 30000)
        self.assertAlmostEqual(uw.analyse(uw.Deal(**{**asdict(d), "price": p}))["coc"], 0.08, places=4)

    def test_impossible(self):
        self.assertIsNone(uw.max_offer(uw.Deal(price=200000, rent_month=0, taxes_year=3000), "coc", 0.08))


class TestBrrrrFlip(unittest.TestCase):
    def test_brrrr(self):
        b = uw.brrrr(100000, 30000, 180000, 1600, 500)
        self.assertAlmostEqual(b["all_in"], 133000)
        self.assertAlmostEqual(b["loan"], 135000)
        self.assertAlmostEqual(b["cash_out"], 132300)
        self.assertAlmostEqual(b["left_in"], 700)
        self.assertFalse(b["infinite"])
        self.assertAlmostEqual(b["coc"], b["cash_flow_month"] * 12 / 700)
        self.assertAlmostEqual(b["equity"], 45000)

    def test_brrrr_infinite(self):
        b = uw.brrrr(50000, 20000, 150000, 1500, 400)
        self.assertAlmostEqual(b["all_in"], 71500)
        self.assertAlmostEqual(b["loan"], 112500)
        self.assertAlmostEqual(b["left_in"], 71500 - 110250)
        self.assertTrue(b["infinite"])
        self.assertIsNone(b["coc"])
        self.assertAlmostEqual(b["payment"], 763.64, places=2)
        self.assertAlmostEqual(b["cash_flow_month"], 1500 - 400 - 763.6367356508973, places=6)

    def test_flip_cash(self):
        f = uw.flip(150000, 40000, 260000)
        self.assertAlmostEqual(f["costs"], 23800)
        self.assertAlmostEqual(f["profit"], 46200)
        self.assertAlmostEqual(f["cash"], 193000)
        self.assertAlmostEqual(f["roi"], 46200 / 193000)
        self.assertAlmostEqual(f["annualized"], (1 + 46200 / 193000) ** 2 - 1)
        self.assertAlmostEqual(f["rule70"], 142000)
        self.assertAlmostEqual(f["margin"], 46200 / 260000)

    def test_flip_financed(self):
        f = uw.flip(150000, 40000, 260000, loan_ltc=0.8)
        self.assertAlmostEqual(f["costs"], 3000 + 20800 + 8360 + 3040)
        self.assertAlmostEqual(f["profit"], 34800)
        self.assertAlmostEqual(f["cash"], 52400)

    def test_flip_edges(self):
        self.assertIsNone(uw.flip(150000, 40000, 260000, months=0)["annualized"])
        self.assertIsNone(uw.flip(0, 0, 0)["margin"])
        loss = uw.flip(200000, 80000, 200000)
        self.assertLess(loss["profit"], 0)


class TestComps(unittest.TestCase):
    S = {"sqft": 1500, "beds": 3, "baths": 2, "year_built": 1990}

    def test_adjust(self):
        a = uw.adjust_comp(self.S, {"price": 200000, "sqft": 1400, "beds": 2, "baths": 2, "year_built": 1980})
        lines = {x["k"]: x["v"] for x in a["lines"]}
        self.assertAlmostEqual(lines["Size"], 100 * (200000 / 1400) * 0.5)
        self.assertEqual(lines["Beds"], 7500)
        self.assertNotIn("Baths", lines)                     # zero adjustments are not listed
        self.assertEqual(lines["Age"], 4000)
        self.assertAlmostEqual(a["adjusted"], 200000 + 7142.857142857143 + 7500 + 4000)
        self.assertAlmostEqual(a["gross_adj"], (7142.857142857143 + 7500 + 4000) / 200000)

    def test_lot_cap_and_missing(self):
        a = uw.adjust_comp({"lot": 100000}, {"price": 300000, "lot": 1000})
        self.assertEqual(a["lines"], [{"k": "Lot", "v": 50000}])
        b = uw.adjust_comp({}, {"price": 300000})
        self.assertEqual(b["adjusted"], 300000)
        self.assertEqual(b["gross_adj"], 0)

    def test_reconcile(self):
        r = uw.reconcile([{"adjusted": 200000, "gross_adj": 0, "dist_mi": 0},
                          {"adjusted": 220000, "gross_adj": 0.1, "dist_mi": 1}])
        self.assertAlmostEqual(r["value"], (200000 * 20 + 220000 * 4) / 24)
        self.assertEqual((r["low"], r["high"], r["n"]), (200000, 220000, 2))
        self.assertIsNone(uw.reconcile([]))
        self.assertIsNone(uw.reconcile([{"adjusted": None}]))


if __name__ == "__main__":
    unittest.main()
