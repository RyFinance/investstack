"""FRED CSV series (no key): mortgage rates, Treasury yields, CPI shelter."""
from __future__ import annotations

import csv
import io

from .. import net

SERIES = {
    "MORTGAGE30US": "30-year fixed mortgage", "MORTGAGE15US": "15-year fixed mortgage", "DGS10": "10-year Treasury",
    "CUSR0000SAH1": "CPI shelter", "RRVRUSQ156N": "Rental vacancy rate (US)", "MSPUS": "Median US home sale price",
    "HOUST": "Housing starts", "CSUSHPINSA": "Case-Shiller US home price index",
}


def update(c, ids=None) -> int:
    n = 0
    for sid in ids or SERIES:
        try:
            st, body = net.fetch(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}", {"User-Agent": "curl/8.4.0"}, timeout=30)
        except Exception:
            continue
        if st != 200:
            continue
        rows = list(csv.reader(io.StringIO(body.decode())))[1:]
        data = [(r[0], float(r[1])) for r in rows if len(r) > 1 and r[1] not in (".", "")]
        c.executemany("insert or replace into market_series values ('us','US',?,?,?, 'FRED')",
                      [(sid, d, v) for d, v in data])
        n += len(data)
    return n


def latest(c, sid: str) -> dict | None:
    r = c.execute("select date, value from market_series where geo_type='us' and metric=? order by date desc limit 1", (sid,)).fetchone()
    return dict(r) if r else None
