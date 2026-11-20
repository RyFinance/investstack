"""Acquisition pipeline: deals move through stages, with events, tasks and due-diligence checklists."""
from __future__ import annotations

from datetime import date, timedelta

from . import db as D, net

STAGES = ["discovered", "researching", "underwriting", "diligence", "offer", "acquired", "rejected"]
STAGE_LABEL = {"discovered": "Discovered", "researching": "Researching", "underwriting": "Underwriting",
               "diligence": "Due diligence", "offer": "Offer", "acquired": "Acquired", "rejected": "Rejected"}
CHECKLIST = {
    "researching": ["Confirm zoning and permitted use", "Pull tax bill and assessment", "Check flood zone (FEMA map)",
                    "Drive the neighbourhood"],
    "underwriting": ["Get rent comps", "Get sold comps", "Get an insurance quote", "Get a lender quote"],
    "diligence": ["Home inspection", "Title search", "Review leases and estoppels", "Verify rent roll against bank deposits",
                  "Sewer scope", "Appraisal"],
    "offer": ["Submit offer", "Earnest money deposit", "Inspection contingency deadline", "Financing contingency deadline",
              "Closing date"],
}


def add(c, pid: int, stage: str = "discovered", ask=None, strategy="rental", score=None) -> int:
    stage = stage if stage in STAGES else "discovered"
    have = D.one(c, "select id from deal where property_id=?", (pid,))
    if have:
        return have["id"]
    did = D.insert(c, "deal", {"property_id": pid, "stage": stage, "stage_entered": net.now(), "ask": ask,
                               "strategy": strategy, "score": score})
    D.insert(c, "deal_event", {"deal_id": did, "kind": "stage", "text": f"Added at {STAGE_LABEL[stage]}"})
    _checklist(c, did, pid, stage)
    return did


def _checklist(c, did, pid, stage):
    days = {"researching": 7, "underwriting": 7, "diligence": 14, "offer": 30}.get(stage, 7)
    for i, t in enumerate(CHECKLIST.get(stage, [])):
        if not D.one(c, "select 1 from task where deal_id=? and title=?", (did, t)):
            D.insert(c, "task", {"deal_id": did, "property_id": pid, "title": t,
                                 "due": (date.today() + timedelta(days=days + i)).isoformat()})


def move(c, did: int, stage: str, reason: str = "") -> None:
    d = D.one(c, "select * from deal where id=?", (did,))
    if not d or stage not in STAGES or d["stage"] == stage:
        return
    D.update(c, "deal", did, {"stage": stage, "stage_entered": net.now(),
                              "closed": net.now() if stage in ("acquired", "rejected") else None,
                              "reason": reason or d.get("reason")})
    D.insert(c, "deal_event", {"deal_id": did, "kind": "stage",
                               "text": f"{STAGE_LABEL[d['stage']]} → {STAGE_LABEL[stage]}" + (f": {reason}" if reason else "")})
    _checklist(c, did, d["property_id"], stage)
    if stage == "acquired":
        c.execute("update property set owned=1 where id=?", (d["property_id"],))
        if not D.one(c, "select 1 from owned where property_id=?", (d["property_id"],)):
            D.insert(c, "owned", {"property_id": d["property_id"], "purchase_price": d.get("offer") or d.get("ask"),
                                  "purchase_date": date.today().isoformat()})


def board(c) -> dict:
    deals = D.rows(c, """select d.*, p.address, p.city, p.state, p.zip, p.beds, p.baths, p.sqft, p.units, p.type, p.lat, p.lon,
        (select count(*) from task t where t.deal_id=d.id and t.done=0) as open_tasks,
        (select min(due) from task t where t.deal_id=d.id and t.done=0) as next_due
        from deal d join property p on p.id=d.property_id order by d.stage_entered desc""")
    tasks = D.rows(c, """select t.*, p.address from task t left join property p on p.id=t.property_id
        where t.done=0 order by t.due limit 300""")
    return {"stages": [{"id": s, "label": STAGE_LABEL[s]} for s in STAGES], "deals": deals, "tasks": tasks}


def detail(c, did: int) -> dict:
    return {"deal": D.one(c, "select * from deal where id=?", (did,)),
            "events": D.rows(c, "select * from deal_event where deal_id=? order by ts desc, id desc", (did,)),
            "tasks": D.rows(c, "select * from task where deal_id=? order by done, due, id", (did,))}


def post(c, b: dict) -> dict:
    act = b.get("act")
    if act == "add":
        if not D.one(c, "select 1 from property where id=?", (int(b["property_id"]),)):
            return {"error": "no such property"}
        return {"id": add(c, int(b["property_id"]), b.get("stage") or "discovered", _money(b.get("ask")), b.get("strategy") or "rental", b.get("score"))}
    if act == "move":
        if b.get("stage") not in STAGES:
            return {"error": f"unknown stage {b.get('stage')!r}"}
        move(c, int(b["id"]), b["stage"], b.get("reason") or "")
    elif act == "update":
        up = {k: b[k] for k in ("offer", "ask", "notes", "strategy") if k in b}
        for k in ("offer", "ask"):
            if k in up:
                up[k] = _money(up[k])
        D.update(c, "deal", int(b["id"]), up)
        if "offer" in b:
            D.insert(c, "deal_event", {"deal_id": int(b["id"]), "kind": "offer",
                                       "text": f"Offer set to ${up['offer']:,.0f}" if up["offer"] is not None else "Offer cleared"})
    elif act == "note":
        D.insert(c, "deal_event", {"deal_id": int(b["id"]), "kind": "note", "text": b["text"]})
    elif act == "task":
        D.insert(c, "task", {"deal_id": b.get("id"), "property_id": b.get("property_id"), "title": b["title"], "due": b.get("due")})
    elif act == "task_done":
        c.execute("update task set done=? where id=?", (1 if b.get("done", True) else 0, int(b["task_id"])))
    elif act == "delete":
        c.execute("delete from deal where id=?", (int(b["id"]),))
    else:
        return {"error": "unknown action"}
    return {"ok": True}


def _money(v):
    try:
        x = float(str(v).replace(",", "").replace("$", "")) if v not in (None, "") else None
    except ValueError:
        return None
    return x if x is None or x == x and abs(x) != float("inf") else None
