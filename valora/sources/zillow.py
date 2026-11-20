"""Zillow Research public CSVs (no key; "Source: Zillow Research"). ZHVI = typical home value, ZORI = typical rent.
These are ZIP/metro indexes, not property values. The big ZIP file is downloaded once and kept in the cache folder;
a snapshot of every ZIP (latest, 1y, 5y change) goes into market_snap, full series are read on demand."""
from __future__ import annotations

import csv
from datetime import datetime, timedelta, timezone

from .. import net, paths

BASE = "https://files.zillowstatic.com/research/public_csvs"
FILES = {
    ("zip", "zhvi"): f"{BASE}/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
    ("zip", "zori"): f"{BASE}/zori/Zip_zori_uc_sfrcondomfr_sm_month.csv",
    ("metro", "zhvi"): f"{BASE}/zhvi/Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
    ("metro", "zori"): f"{BASE}/zori/Metro_zori_uc_sfrcondomfr_sm_month.csv",
}
SRC = "Zillow Research"


def _file(geo, metric):
    return paths.sub("cache") / FILES[(geo, metric)].rsplit("/", 1)[1]


def ensure(geo, metric, max_age_days=30, refresh=False):
    f = _file(geo, metric)
    old = f.exists() and (datetime.now().timestamp() - f.stat().st_mtime) > max_age_days * 86400
    if refresh or not f.exists() or old:
        net.download(FILES[(geo, metric)], f)
    return f


def _read(f):
    with open(f, newline="", encoding="utf-8") as fh:
        r = csv.reader(fh)
        head = next(r)
        first = next(i for i, h in enumerate(head) if h[:2] in ("19", "20"))
        yield head, first
        yield from r


def _fl(x):
    try:
        return float(x)
    except ValueError:
        return None


def snapshot(c, geo, metric, refresh=False) -> int:
    f = ensure(geo, metric, refresh=refresh)
    it = _read(f)
    head, first = next(it)
    dates = head[first:]
    n = 0
    rows = []
    for row in it:
        vals = [_fl(x) for x in row[first:]]
        idx = [i for i, v in enumerate(vals) if v is not None]
        if not idx:
            continue
        li = idx[-1]
        latest = vals[li]
        def back(m):
            j = li - m
            return latest / vals[j] - 1 if j >= 0 and vals[j] else None
        H = dict(zip(head[:first], row[:first]))
        geo_id = H["RegionName"].zfill(5) if geo == "zip" else H["RegionID"]
        rows.append((geo, geo_id, metric, H.get("City") or H["RegionName"], H.get("State") or H.get("StateName"),
                     H.get("Metro") or (H["RegionName"] if geo == "metro" else ""), latest, back(12), back(60), dates[li], SRC))
        if geo == "metro":
            c.executemany("insert or replace into market_series values (?,?,?,?,?,?)",
                          [(geo, geo_id, metric, dates[i], vals[i], SRC) for i in idx])
        n += 1
    c.executemany("insert or replace into market_snap values (?,?,?,?,?,?,?,?,?,?,?)", rows)
    return n


def series(c, geo, geo_id, metric) -> list[dict]:
    """Full monthly series for one ZIP or metro (ZIP rows are read from the file on first use, then stored)."""
    have = c.execute("select date, value from market_series where geo_type=? and geo_id=? and metric=? order by date",
                     (geo, geo_id, metric)).fetchall()
    if have or geo != "zip":
        return [dict(r) for r in have]
    f = _file(geo, metric)
    if not f.exists():
        return []
    it = _read(f)
    head, first = next(it)
    ri = head.index("RegionName")
    for row in it:
        if row[ri].zfill(5) == geo_id:
            pts = [(head[first + i], _fl(x)) for i, x in enumerate(row[first:])]
            pts = [(d, v) for d, v in pts if v is not None]
            c.executemany("insert or replace into market_series values (?,?,?,?,?,?)",
                          [(geo, geo_id, metric, d, v, SRC) for d, v in pts])
            return [{"date": d, "value": v} for d, v in pts]
    return []
