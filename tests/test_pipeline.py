import helpers  # noqa: F401  (temp data folder + no network, before valora)

import unittest
from datetime import date

from valora import config, db as D, pipeline as PL


class TestPipeline(unittest.TestCase):
    def setUp(self):
        helpers.fresh_home()
        config.save({"demo": False})
        self._cm = D.db()
        self.c = self._cm.__enter__()
        self.pid = D.insert(self.c, "property", {"address": "5 Deal Rd", "address_norm": "5 deal rd"})

    def tearDown(self):
        self._cm.__exit__(None, None, None)

    def tasks(self, did):
        return [t["title"] for t in D.rows(self.c, "select title from task where deal_id=? order by id", (did,))]

    def test_add_is_idempotent_per_property(self):
        r = PL.post(self.c, {"act": "add", "property_id": self.pid, "ask": "$250,000"})
        again = PL.post(self.c, {"act": "add", "property_id": str(self.pid)})
        self.assertEqual(r["id"], again["id"])
        d = D.one(self.c, "select * from deal where id=?", (r["id"],))
        self.assertEqual((d["stage"], d["ask"]), ("discovered", 250000.0))
        self.assertEqual(self.tasks(r["id"]), [])            # discovered has no checklist
        self.assertEqual(PL.post(self.c, {"act": "add", "property_id": 9999}), {"error": "no such property"})

    def test_stage_moves_add_checklists_once(self):
        did = PL.add(self.c, self.pid)
        for s in ("researching", "underwriting", "diligence", "offer"):
            self.assertEqual(PL.post(self.c, {"act": "move", "id": did, "stage": s}), {"ok": True})
            self.assertEqual(D.one(self.c, "select stage from deal where id=?", (did,))["stage"], s)
        expect = sum((PL.CHECKLIST[s] for s in ("researching", "underwriting", "diligence", "offer")), [])
        self.assertEqual(self.tasks(did), expect)
        # back and forth: no duplicates, one event per real move
        PL.move(self.c, did, "researching")
        PL.move(self.c, did, "offer")
        PL.move(self.c, did, "offer")                        # same stage: no-op
        self.assertEqual(self.tasks(did), expect)
        ev = PL.detail(self.c, did)["events"]
        self.assertEqual(len([e for e in ev if e["kind"] == "stage"]), 1 + 4 + 2)
        due = [t["due"] for t in D.rows(self.c, "select due from task where deal_id=?", (did,))]
        self.assertTrue(all(d > date.today().isoformat() for d in due))

    def test_unknown_stage_and_action(self):
        did = PL.add(self.c, self.pid)
        self.assertIn("error", PL.post(self.c, {"act": "move", "id": did, "stage": "won"}))
        self.assertIn("error", PL.post(self.c, {"act": "nope"}))
        self.assertEqual(PL.add(self.c, D.insert(self.c, "property", {"address": "6 X", "address_norm": "6 x"}), stage="bogus"),
                         did + 1)
        self.assertEqual(D.one(self.c, "select stage from deal where id=?", (did + 1,))["stage"], "discovered")

    def test_acquired_marks_owned(self):
        did = PL.add(self.c, self.pid, ask=300000)
        PL.post(self.c, {"act": "update", "id": did, "offer": "285,000"})
        PL.post(self.c, {"act": "move", "id": did, "stage": "acquired"})
        self.assertEqual(D.one(self.c, "select owned from property where id=?", (self.pid,))["owned"], 1)
        o = D.one(self.c, "select * from owned where property_id=?", (self.pid,))
        self.assertEqual((o["purchase_price"], o["purchase_date"]), (285000.0, date.today().isoformat()))
        d = D.one(self.c, "select * from deal where id=?", (did,))
        self.assertIsNotNone(d["closed"])
        # moving away and back does not overwrite the owned row
        D.update(self.c, "owned", self.pid, {"purchase_price": 280000}, "property_id")
        PL.move(self.c, did, "offer")
        PL.move(self.c, did, "acquired")
        self.assertEqual(D.one(self.c, "select purchase_price from owned where property_id=?", (self.pid,))["purchase_price"], 280000)

    def test_rejected_keeps_reason(self):
        did = PL.add(self.c, self.pid)
        PL.post(self.c, {"act": "move", "id": did, "stage": "rejected", "reason": "Roof"})
        d = D.one(self.c, "select * from deal where id=?", (did,))
        self.assertEqual((d["stage"], d["reason"]), ("rejected", "Roof"))
        self.assertIn("Roof", PL.detail(self.c, did)["events"][0]["text"])
        self.assertEqual(D.one(self.c, "select owned from property where id=?", (self.pid,))["owned"], 0)

    def test_update_note_task_delete(self):
        did = PL.add(self.c, self.pid)
        PL.post(self.c, {"act": "update", "id": did, "offer": "abc", "notes": "n"})
        d = D.one(self.c, "select * from deal where id=?", (did,))
        self.assertEqual((d["offer"], d["notes"]), (None, "n"))
        PL.post(self.c, {"act": "update", "id": did, "offer": "inf"})
        self.assertIsNone(D.one(self.c, "select offer from deal where id=?", (did,))["offer"])
        PL.post(self.c, {"act": "note", "id": did, "text": "called agent"})
        PL.post(self.c, {"act": "task", "id": did, "property_id": self.pid, "title": "Call lender", "due": "2026-12-01"})
        t = D.one(self.c, "select * from task where title='Call lender'")
        PL.post(self.c, {"act": "task_done", "task_id": t["id"], "done": True})
        self.assertEqual(D.one(self.c, "select done from task where id=?", (t["id"],))["done"], 1)
        PL.post(self.c, {"act": "task_done", "task_id": t["id"], "done": False})
        self.assertEqual(D.one(self.c, "select done from task where id=?", (t["id"],))["done"], 0)
        b = PL.board(self.c)
        self.assertEqual([s["id"] for s in b["stages"]], PL.STAGES)
        self.assertEqual(b["deals"][0]["open_tasks"], 1)
        self.assertEqual(b["deals"][0]["next_due"], "2026-12-01")
        PL.post(self.c, {"act": "delete", "id": did})
        self.assertIsNone(D.one(self.c, "select * from deal where id=?", (did,)))
        self.assertEqual(D.rows(self.c, "select * from task where deal_id=?", (did,)), [])      # cascade


if __name__ == "__main__":
    unittest.main()
