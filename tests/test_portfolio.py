import helpers  # noqa: F401  (temp data folder + no network, before valora)

import threading
import time
import unittest
from datetime import date, timedelta

from valora import config, db as D, portfolio as P, uw


class Base(unittest.TestCase):
    """Each test gets an empty user workspace (not the demo) and an open connection."""
    def setUp(self):
        helpers.fresh_home()
        config.save({"demo": False})
        self._cm = D.db()
        self.c = self._cm.__enter__()

    def tearDown(self):
        self._cm.__exit__(None, None, None)

    def prop(self, address="10 Test St, Columbus, OH 43201", **owned):
        pid = D.insert(self.c, "property", {"address": address, "address_norm": D.norm_address(address), "zip": "43201", "owned": 1})
        D.insert(self.c, "owned", {"property_id": pid, **owned})
        return pid

    def lease(self, start, end=None, rent=1000.0, pid=None, **kw):
        pid = pid or self.prop(f"{len(D.rows(self.c, 'select id from property')) + 1} Lease Ave, Columbus, OH 43201")
        uid = P.post(self.c, {"act": "add", "table": "unit", "data": {"property_id": pid, "name": "A", "market_rent": 1100}})["id"]
        data = {"unit_id": uid, "start": start, "end": end, "rent": rent, "due_day": 1, "late_fee": 0, "grace_days": 5,
                "escalation": 0, **kw}
        lid = P.post(self.c, {"act": "add", "table": "lease", "data": data, "tenant_name": "Pat Tenant"})["id"]
        return lid

    def entries(self, lid, typ=None):
        q = "select * from ledger_entry where lease_id=?" + (" and type=?" if typ else "") + " order by date, id"
        return D.rows(self.c, q, (lid, typ) if typ else (lid,))

    def pay(self, lid, d, amt, typ="payment"):
        P.post(self.c, {"act": "add", "table": "entry", "data": {"lease_id": lid, "date": d, "type": typ, "amount": amt}})


class TestDates(unittest.TestCase):
    def test_add_months_and_years(self):
        self.assertEqual(P.add_months(date(2025, 11, 30), 3), date(2026, 2, 1))
        self.assertEqual(P.add_months(date(2026, 1, 15), -1), date(2025, 12, 1))
        self.assertEqual(P.add_months(date(2026, 1, 15), -13), date(2024, 12, 1))
        self.assertEqual(P.add_years(date(2024, 2, 29), 1), date(2025, 2, 28))
        self.assertEqual(list(P._months(date(2025, 11, 20), date(2026, 2, 1))), [(2025, 11), (2025, 12), (2026, 1), (2026, 2)])
        self.assertEqual(P._dim(2024, 2), 29)
        self.assertEqual(P._dim(2025, 12), 31)

    def test_rent_escalates_on_anniversary(self):
        L = {"start": "2024-03-15", "rent": 1000, "escalation": 0.03, "due_day": 1}
        self.assertEqual(P.rent_on(L, 2024, 4), 1000)
        self.assertEqual(P.rent_on(L, 2025, 3), 1000)        # 1 Mar 2025 is before the anniversary
        self.assertEqual(P.rent_on(L, 2025, 4), 1030)        # first due date after it
        self.assertEqual(P.rent_on(L, 2026, 4), round(1000 * 1.03 ** 2, 2))
        L2 = {"start": "2024-03-01", "rent": 1000, "escalation": 0.05, "due_day": 1}
        self.assertEqual(P.rent_on(L2, 2025, 3), 1050)       # due on the anniversary itself steps up
        self.assertEqual(P.rent_on(L2, 2025, 2), 1000)

    def test_rent_on_tolerates_bad_rows(self):
        L = {"start": "2024-01-01", "rent": "abc", "escalation": "", "due_day": "15th"}
        self.assertEqual(P.rent_on(L, 2025, 6), 0)
        self.assertEqual(P._due_day({"due_day": 45}), 28)
        self.assertEqual(P._due_day({"due_day": None}), 1)
        self.assertEqual(P._grace({"grace_days": "x"}), 5)
        self.assertEqual(P._grace({"grace_days": 0}), 0)


class TestCharges(Base):
    def test_posting_is_idempotent_and_prorates_move_in(self):
        lid = self.lease("2026-01-15", "2026-12-31", rent=1550)
        n1 = P.post_charges(self.c, date(2026, 4, 10))
        self.assertEqual(n1, 4)                              # Jan (prorated), Feb, Mar, Apr
        self.assertEqual(P.post_charges(self.c, date(2026, 4, 10)), 0)
        self.assertEqual(P.post_charges(self.c, date(2026, 4, 10)), 0)
        rents = self.entries(lid, "rent")
        self.assertEqual([r["date"] for r in rents], ["2026-01-15", "2026-02-01", "2026-03-01", "2026-04-01"])
        self.assertAlmostEqual(rents[0]["amount"], round(1550 * 17 / 31, 2))
        self.assertIn("prorated 17/31", rents[0]["memo"])
        self.assertTrue(all(r["amount"] == 1550 for r in rents[1:]))
        self.assertEqual(P.post_charges(self.c, date(2026, 5, 1)), 1)

    def test_due_day_respected(self):
        lid = self.lease("2026-01-01", "2026-12-31", due_day=15)
        P.post_charges(self.c, date(2026, 3, 14))
        self.assertEqual([r["date"] for r in self.entries(lid, "rent")], ["2026-01-15", "2026-02-15"])

    def test_late_fee_after_grace_only(self):
        lid = self.lease("2026-01-01", "2026-12-31", rent=1000, late_fee=50, grace_days=5)
        self.pay(lid, "2026-01-03", 1000)                    # on time
        self.pay(lid, "2026-02-06", 1000)                    # last day of grace: still on time
        self.pay(lid, "2026-03-09", 1000)                    # late
        P.post_charges(self.c, date(2026, 4, 5))             # April grace runs to the 6th: no fee yet
        fees = self.entries(lid, "late_fee")
        self.assertEqual([(f["date"], f["amount"], f["memo"]) for f in fees], [("2026-03-06", 50, "Late fee Mar 2026")])
        P.post_charges(self.c, date(2026, 4, 7))
        fees = self.entries(lid, "late_fee")
        self.assertEqual([f["memo"] for f in fees], ["Late fee Mar 2026", "Late fee Apr 2026"])
        P.post_charges(self.c, date(2026, 4, 30))
        self.assertEqual(len(self.entries(lid, "late_fee")), 2)   # idempotent

    def test_unpaid_late_fee_does_not_trigger_another(self):
        lid = self.lease("2026-01-01", "2026-12-31", rent=1000, late_fee=50, grace_days=5)
        self.pay(lid, "2026-01-10", 1000)                    # Jan late → fee, never paid
        self.pay(lid, "2026-02-01", 1000)                    # Feb on time
        P.post_charges(self.c, date(2026, 2, 28))
        self.assertEqual([f["memo"] for f in self.entries(lid, "late_fee")], ["Late fee Jan 2026"])
        self.assertEqual(P.lease_balance(self.c, lid, date(2026, 2, 28))["balance"], 50)

    def test_no_charges_without_start_or_rent(self):
        lid = self.lease(None, None)
        lid2 = self.lease("2026-01-01", None, rent=None)
        self.assertEqual(P.post_charges(self.c, date(2026, 3, 1)), 0)
        self.assertEqual(self.entries(lid) + self.entries(lid2), [])

    def test_post_charges_cheap_when_nothing_missing(self):
        for i in range(25):
            lid = self.lease("2016-01-01", "2035-12-31", rent=1000 + i, late_fee=50)
            m = date(2016, 1, 1)
            rows = []
            while m <= date(2026, 11, 1):
                rows.append((lid, m.isoformat(), "payment", 1000 + i, "ACH"))
                m = P.add_months(m, 1)
            self.c.executemany("insert into ledger_entry (lease_id, date, type, amount, memo) values (?,?,?,?,?)", rows)
        through = date(2026, 11, 16)
        t = time.perf_counter()
        P.post_charges(self.c, through)
        first = time.perf_counter() - t
        n_after = self.c.execute("select count(*) from ledger_entry").fetchone()[0]
        t = time.perf_counter()
        for _ in range(5):
            self.assertEqual(P.post_charges(self.c, through), 0)
        again = (time.perf_counter() - t) / 5
        self.assertEqual(self.c.execute("select count(*) from ledger_entry").fetchone()[0], n_after)
        self.assertLess(again, 0.25, f"no-op post_charges took {again:.3f}s (first run {first:.3f}s)")

    def test_concurrent_posting_never_duplicates(self):
        self.lease("2025-01-01", "2026-12-31", rent=900, late_fee=40)
        self.lease("2025-06-10", "2026-12-31", rent=1200)
        self._cm.__exit__(None, None, None)                  # commit the setup; workers use their own connections
        errs = []

        def work():
            try:
                with D.db() as c:
                    P.post_charges(c, date(2026, 11, 16))
            except Exception as e:                           # pragma: no cover - reported below
                errs.append(e)
        ts = [threading.Thread(target=work) for _ in range(8)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self._cm = D.db()
        self.c = self._cm.__enter__()
        self.assertEqual(errs, [])
        dup = self.c.execute("""select lease_id, substr(date,1,7) m, count(*) n from ledger_entry where type='rent'
            group by lease_id, m having n > 1""").fetchall()
        self.assertEqual([tuple(r) for r in dup], [])
        dupf = self.c.execute("select lease_id, memo, count(*) n from ledger_entry where type='late_fee' group by lease_id, memo having n > 1").fetchall()
        self.assertEqual([tuple(r) for r in dupf], [])


class TestBalance(Base):
    def test_payments_oldest_first_and_ageing(self):
        lid = self.lease("2026-01-01", "2026-12-31", rent=1000)
        P.post_charges(self.c, date(2026, 3, 1))
        self.pay(lid, "2026-03-05", 1500)
        b = P.lease_balance(self.c, lid, date(2026, 3, 15))
        self.assertEqual(b["balance"], 1500)
        self.assertEqual(b["prepaid"], 0)
        # Jan fully paid, Feb half paid (42 days old), Mar unpaid (14 days old)
        self.assertEqual(b["aging"], {"0-30": 1000, "31-60": 500, "61-90": 0, "90+": 0})
        b = P.lease_balance(self.c, lid, date(2026, 6, 15))
        self.assertEqual(b["aging"], {"0-30": 0, "31-60": 0, "61-90": 0, "90+": 1500})

    def test_credits_exceed_charges(self):
        lid = self.lease("2026-01-01", "2026-12-31", rent=1000)
        P.post_charges(self.c, date(2026, 1, 20))
        self.pay(lid, "2026-01-02", 2500)
        b = P.lease_balance(self.c, lid, date(2026, 1, 20))
        self.assertEqual(b["balance"], -1500)
        self.assertEqual(b["prepaid"], 1500)
        self.assertEqual(b["aging"], {"0-30": 0, "31-60": 0, "61-90": 0, "90+": 0})
        self.pay(lid, "2026-01-21", 100, typ="credit")
        self.assertEqual(P.lease_balance(self.c, lid, date(2026, 1, 25))["prepaid"], 1600)

    def test_refund_and_negative_charge(self):
        lid = self.lease("2026-01-01", "2026-12-31", rent=1000)
        P.post_charges(self.c, date(2026, 1, 20))
        self.pay(lid, "2026-01-02", 1000)
        self.pay(lid, "2026-01-10", -200)                    # refund of a payment raises what is owed
        self.assertEqual(P.lease_balance(self.c, lid, date(2026, 1, 20))["balance"], 200)
        self.pay(lid, "2026-01-11", -200, typ="charge")      # a negative charge is a credit
        self.assertEqual(P.lease_balance(self.c, lid, date(2026, 1, 20))["balance"], 0)

    def test_running_ledger(self):
        lid = self.lease("2026-01-01", "2026-12-31", rent=1000)
        P.post_charges(self.c, date(2026, 2, 1))
        self.pay(lid, "2026-01-03", 1000)
        led = P.ledger(self.c, lid)
        self.assertEqual([e["running"] for e in led], [1000, 0, 1000])
        self.assertEqual(led[-1]["running"], P.lease_balance(self.c, lid, date(2026, 2, 1))["balance"])


class TestLeaseLifecycle(Base):
    def test_renew_mid_month_charges_one_month_in_total(self):
        today = date.today()
        nxt = P.add_months(today, 1)
        start = P.add_months(today, -6)
        end = date(nxt.year, nxt.month, 14)
        lid = self.lease(start.isoformat(), end.isoformat(), rent=1000)
        r = P.post(self.c, {"act": "renew", "id": lid, "rent": 1100, "years": 1})
        new = D.one(self.c, "select * from lease where id=?", (r["id"],))
        self.assertEqual(D.one(self.c, "select status from lease where id=?", (lid,))["status"], "renewed")
        self.assertEqual(new["start"], (end + timedelta(days=1)).isoformat())
        self.assertEqual(new["end"], (P.add_years(end + timedelta(days=1), 1) - timedelta(days=1)).isoformat())
        self.assertEqual(new["rent"], 1100)
        P.post_charges(self.c, date(nxt.year, nxt.month, P._dim(nxt.year, nxt.month)))
        ym = f"{nxt.year}-{nxt.month:02d}"
        old_m = [e for e in self.entries(lid, "rent") if e["date"][:7] == ym]
        new_m = [e for e in self.entries(r["id"], "rent") if e["date"][:7] == ym]
        dim = P._dim(nxt.year, nxt.month)
        self.assertEqual(len(old_m), 1)
        self.assertEqual(len(new_m), 1)
        self.assertAlmostEqual(old_m[0]["amount"], round(1000 * 14 / dim, 2))
        self.assertAlmostEqual(new_m[0]["amount"], round(1100 * (dim - 14) / dim, 2))
        self.assertEqual(old_m[0]["date"], f"{ym}-01")
        self.assertEqual(new_m[0]["date"], f"{ym}-15")

    def test_renew_without_end_is_refused(self):
        lid = self.lease("2026-01-01", None)
        self.assertIn("error", P.post(self.c, {"act": "renew", "id": lid}))
        self.assertIn("error", P.post(self.c, {"act": "renew", "id": 99999}))

    def test_end_lease_stops_charges_and_vacates(self):
        lid = self.lease("2025-01-01", "2027-12-31", rent=1000)
        P.post_charges(self.c, date(2026, 3, 20))
        self.assertEqual(P.post(self.c, {"act": "end_lease", "id": lid, "end": "2026-03-31"}), {"ok": True})
        L = D.one(self.c, "select l.*, u.status as ustatus from lease l join unit u on u.id=l.unit_id where l.id=?", (lid,))
        self.assertEqual((L["status"], L["end"], L["ustatus"]), ("ended", "2026-03-31", "vacant"))
        before = len(self.entries(lid))
        self.assertEqual(P.post_charges(self.c, date(2026, 9, 1)), 0)
        self.assertEqual(len(self.entries(lid)), before)

    def test_holdover_keeps_charging_active_lease(self):
        lid = self.lease("2025-01-01", "2025-12-31", rent=1000)
        P.post_charges(self.c, date(2026, 2, 10))
        rents = self.entries(lid, "rent")
        self.assertEqual(len(rents), 14)
        self.assertIn("holdover", rents[-1]["memo"])

    def test_add_lease_creates_tenant_and_occupies_unit(self):
        lid = self.lease("2026-01-01", "2026-12-31")
        L = D.one(self.c, "select l.*, t.name, u.status as ustatus from lease l join tenant t on t.id=l.tenant_id join unit u on u.id=l.unit_id where l.id=?", (lid,))
        self.assertEqual((L["name"], L["ustatus"]), ("Pat Tenant", "occupied"))
        self.assertIn("error", P.post(self.c, {"act": "add", "table": "lease", "data": {"rent": 5}}))
        self.assertIn("error", P.post(self.c, {"act": "add", "table": "nope", "data": {}}))
        self.assertIn("error", P.post(self.c, {"act": "edit", "table": "unit", "data": {}}))

    def test_numeric_inputs_are_coerced(self):
        pid = self.prop()
        uid = P.post(self.c, {"act": "add", "table": "unit", "data": {"property_id": str(pid), "name": "B", "market_rent": "$1,250"}})["id"]
        u = D.one(self.c, "select * from unit where id=?", (uid,))
        self.assertEqual((u["property_id"], u["market_rent"]), (pid, 1250.0))
        lid = P.post(self.c, {"act": "add", "table": "lease", "data": {"unit_id": uid, "start": "2026-01-01", "rent": "1,200",
                                                                        "late_fee": "", "due_day": "5"}})["id"]
        L = D.one(self.c, "select * from lease where id=?", (lid,))
        self.assertEqual((L["rent"], L["late_fee"], L["due_day"]), (1200.0, None, 5))
        with self.assertRaises(ValueError):
            P.post(self.c, {"act": "edit", "table": "lease", "id": lid, "data": {"rent": "twelve hundred"}})
        with self.assertRaises(ValueError):
            P.post(self.c, {"act": "add", "table": "entry", "data": {"lease_id": lid, "amount": "nan"}})

    def test_bad_stored_values_do_not_break_pages(self):
        lid = self.lease("2026-01-01", "2026-12-31")
        self.c.execute("update lease set due_day='first', rent='abc', escalation='x', grace_days='y', late_fee='z' where id=?", (lid,))
        P.post_charges(self.c, date(2026, 3, 1))
        rows = P.rent_roll(self.c)
        self.assertEqual(len(rows), 1)
        P.overview(self.c)


class TestDebt(Base):
    LOAN = {"principal": 240000.0, "rate": 0.065, "years": 30, "start": "2019-12-01", "io": 0}

    def test_debt_state_balance(self):
        s = P.debt_state(self.LOAN, date(2020, 12, 15))
        self.assertEqual(s["months_paid"], 12)
        self.assertAlmostEqual(s["balance"], uw.balance(240000, 0.065, 30, 12))
        self.assertAlmostEqual(s["payment"], uw.payment(240000, 0.065, 30))
        self.assertAlmostEqual(s["pi_year"], s["payment"] * 12)
        done = P.debt_state(self.LOAN, date(2055, 1, 1))
        self.assertEqual((done["months_paid"], done["pi_year"]), (360, 0.0))
        self.assertAlmostEqual(done["balance"], 0.0, places=6)
        blank = P.debt_state({"principal": None, "rate": "", "years": None, "start": ""})
        self.assertEqual(blank["balance"], 0.0)

    def test_interest_in_year_matches_amortisation(self):
        sched = uw.amortization(240000, 0.065, 30)
        # first payment Jan 2020, so calendar years line up with loan years
        for i, y in enumerate(range(2020, 2050)):
            self.assertAlmostEqual(P.interest_in_year(self.LOAN, y), sched[i]["interest"], places=4, msg=y)
        self.assertEqual(P.interest_in_year(self.LOAN, 2019), 0.0)
        self.assertEqual(P.interest_in_year(self.LOAN, 2050), 0.0)       # paid off Dec 2049

    def test_interest_partial_years_sum_to_total(self):
        d = dict(self.LOAN, start="2021-06-01")
        total = sum(P.interest_in_year(d, y) for y in range(2020, 2056))
        sched = uw.amortization(240000, 0.065, 30)
        self.assertAlmostEqual(total, sum(x["interest"] for x in sched), places=3)
        r = 0.065 / 12
        # 2021: payments July..December = 6 months, interest from the closed-form balance path
        bal, interest = 240000.0, 0.0
        pmt = uw.payment(240000, 0.065, 30)
        for _ in range(6):
            interest += bal * r
            bal -= pmt - bal * r
        self.assertAlmostEqual(P.interest_in_year(d, 2021), interest, places=6)

    def test_interest_only_and_zero_rate(self):
        io = {"principal": 100000, "rate": 0.06, "years": 5, "start": "2025-12-01", "io": 1}
        self.assertAlmostEqual(P.interest_in_year(io, 2026), 6000.0)
        self.assertEqual(P.debt_state(io, date(2031, 1, 1))["balance"], 0.0)   # repaid at maturity
        z = {"principal": 120000, "rate": 0, "years": 10, "start": "2025-12-01"}
        self.assertEqual(P.interest_in_year(z, 2026), 0.0)

    def test_payment_in_month(self):
        self.assertEqual(P.debt_payment_in(self.LOAN, 2019, 12), 0.0)
        self.assertAlmostEqual(P.debt_payment_in(self.LOAN, 2020, 1), uw.payment(240000, 0.065, 30))
        self.assertAlmostEqual(P.debt_payment_in(self.LOAN, 2049, 12), uw.payment(240000, 0.065, 30))
        self.assertEqual(P.debt_payment_in(self.LOAN, 2050, 1), 0.0)
        self.assertEqual(P.debt_payment_in(dict(self.LOAN, payment=1500), 2030, 5), 1500)


class TestRollups(Base):
    def test_monthly_window(self):
        m = P.monthly(self.c, 3, today=date(2026, 1, 15))
        self.assertEqual([x["month"] for x in m], ["2025-11", "2025-12", "2026-01"])
        m = P.monthly(self.c)
        self.assertEqual(len(m), 24)
        self.assertEqual(m[-1]["month"], date.today().strftime("%Y-%m"))
        ks = [x["month"] for x in m]
        self.assertEqual(ks, sorted(set(ks)))
        self.assertEqual(len(P.monthly(self.c, 0)), 1)
        m = P.monthly(self.c, 12, today=date(2026, 3, 31))
        self.assertEqual((m[0]["month"], m[-1]["month"]), ("2025-04", "2026-03"))

    def test_monthly_sums(self):
        pid = self.prop()
        lid = self.lease("2025-01-01", "2026-12-31", pid=pid)
        self.pay(lid, "2026-01-03", 1000)
        for cat, amt in (("Repairs", 200), ("Mortgage interest", 900), (None, 50)):
            D.insert(self.c, "expense", {"property_id": pid, "date": "2026-01-10", "category": cat, "amount": amt})
        D.insert(self.c, "debt", {"property_id": pid, "principal": 120000, "rate": 0.0, "years": 10, "start": "2025-06-01"})
        jan = P.monthly(self.c, 2, today=date(2026, 1, 20))[-1]
        self.assertEqual(jan["income"], 1000)
        self.assertEqual(jan["opex"], 250)                   # interest is below NOI; a blank category is still an expense
        self.assertEqual(jan["debt"], 1000)
        self.assertEqual(jan["cf"], 1000 - 250 - 1000)
        t = P.ttm(self.c, pid, date(2026, 1, 31))
        self.assertEqual((t["income"], t["opex"]), (1000, 250))

    def test_schedule_e(self):
        pid = self.prop(purchase_price=200000, purchase_date="2025-03-10", closing_costs=5000, rehab=10000)
        lid = self.lease("2025-04-01", "2026-03-31", pid=pid)
        self.pay(lid, "2025-04-02", 1000)
        self.pay(lid, "2026-01-02", 1000)
        D.insert(self.c, "expense", {"property_id": pid, "date": "2025-06-01", "category": "Repairs", "amount": 300})
        D.insert(self.c, "expense", {"property_id": pid, "date": "2025-07-01", "category": "Pet grooming", "amount": 40})
        D.insert(self.c, "expense", {"property_id": pid, "date": "2025-08-01", "category": None, "amount": None})
        loan = {"property_id": pid, "principal": 150000, "rate": 0.07, "years": 30, "start": "2025-03-01"}
        D.insert(self.c, "debt", loan)
        s = P.schedule_e(self.c, 2025)
        row = s["properties"][0]
        self.assertEqual(row["rents"], 1000)
        self.assertEqual(row["lines"]["Repairs"], 300)
        self.assertEqual(row["lines"]["Other"], 40)
        self.assertAlmostEqual(row["lines"]["Mortgage interest"], P.interest_in_year(loan, 2025))
        basis = (200000 + 5000) * 0.8 + 10000
        self.assertEqual(row["basis"], basis)
        self.assertAlmostEqual(row["lines"]["Depreciation"], basis / 27.5 * (12 - 3 + 0.5) / 12)
        self.assertAlmostEqual(row["net"], row["rents"] - row["expenses"])
        self.assertAlmostEqual(row["expenses"], sum(row["lines"].values()))
        self.assertAlmostEqual(P.schedule_e(self.c, 2026)["properties"][0]["lines"]["Depreciation"], basis / 27.5)
        self.assertEqual(P.schedule_e(self.c, 2024)["properties"][0]["lines"]["Depreciation"], 0)
        self.assertEqual(s["lines"], P.SCHED_E)

    def test_overview_and_rent_roll(self):
        pid = self.prop(purchase_price=300000, value_est=360000)
        lid = self.lease("2025-01-01", (date.today() + timedelta(days=40)).isoformat(), pid=pid, rent=1500)
        D.insert(self.c, "unit", {"property_id": pid, "name": "B", "market_rent": 1400, "status": "vacant"})
        D.insert(self.c, "debt", {"property_id": pid, "principal": 200000, "rate": 0.06, "years": 30,
                                  "start": P.add_months(date.today(), -12).isoformat()})
        o = P.overview(self.c)
        p = o["properties"][0]
        self.assertEqual(p["value"], 360000)
        self.assertEqual((p["units_n"], p["occupied"], p["occupancy"]), (2, 1, 0.5))
        self.assertAlmostEqual(p["debt"], uw.balance(200000, 0.06, 30, 12))
        self.assertAlmostEqual(p["ltv"], p["debt"] / 360000)
        self.assertGreater(p["arrears"], 0)                  # nothing was paid
        self.assertEqual(len(o["expiring"]), 1)
        self.assertEqual(o["expiring"][0]["lease_id"], lid)
        self.assertEqual(len(o["monthly"]), 24)
        self.assertAlmostEqual(o["total"]["equity"], o["total"]["value"] - o["total"]["debt"])
        rr = {r["name"]: r for r in P.rent_roll(self.c, pid)}
        self.assertEqual(rr["A"]["lease_id"], lid)
        self.assertEqual(rr["A"]["balance"], p["arrears"])
        self.assertEqual(rr["B"]["loss_to_lease"], 1400)
        self.assertIsNone(rr["B"]["lease_id"])
        self.assertEqual(rr["A"]["loss_to_lease"], 1100 - rr["A"]["current_rent"])

    def test_empty_portfolio(self):
        o = P.overview(self.c)
        self.assertEqual(o["properties"], [])
        self.assertIsNone(o["total"]["ltv"])
        self.assertIsNone(o["total"]["occupancy"])
        self.assertEqual(P.rent_roll(self.c), [])
        self.assertEqual(P.schedule_e(self.c, 2026)["properties"], [])


if __name__ == "__main__":
    unittest.main()
