"""FHFA house price index master file (no key): state and metro purchase-only / all-transactions indexes."""
from __future__ import annotations

import csv

from .. import net, paths

URL = "https://www.fhfa.gov/hpi/download/monthly/hpi_master.csv"


def update(c, refresh=False) -> int:
    f = paths.sub("cache") / "hpi_master.csv"
    if refresh or not f.exists():
        net.download(URL, f)
    n = 0
    rows = []
    with open(f, newline="", encoding="utf-8", errors="replace") as fh:
        for r in csv.DictReader(fh):
            if r.get("hpi_flavor") != "all-transactions" and r.get("frequency") != "monthly":
                continue
            lvl = r.get("level", "")
            if lvl not in ("State", "USA or Census Division"):
                continue
            geo = "state" if lvl == "State" else "us"
            gid = r.get("place_id") or r.get("place_name")
            per = int(r.get("period") or 1)
            yr = r.get("yr")
            date = f"{yr}-{per:02d}-01" if r.get("frequency") == "monthly" else f"{yr}-{per * 3:02d}-01"
            try:
                v = float(r.get("index_sa") or r.get("index_nsa"))
            except (TypeError, ValueError):
                continue
            rows.append((geo, gid, "fhfa_hpi_" + (r.get("frequency") or "q")[0], date, v, "FHFA"))
            n += 1
    c.executemany("insert or replace into market_series values (?,?,?,?,?,?)", rows)
    return n
