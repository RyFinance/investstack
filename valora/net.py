"""HTTP with a permanent cache and a monthly call budget. Every response is stored with its fetch time,
so a page can always say "as of"; nothing is re-fetched unless the user asks for a refresh."""
from __future__ import annotations

import gzip
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

UA = "InvestStack/0.1 (desktop real-estate desk)"


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def month() -> str:
    return datetime.now().strftime("%Y-%m")


def fetch(url: str, headers: dict | None = None, timeout: float = 30) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            return r.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read() or b""


def download(url: str, dest, timeout: float = 300) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=timeout) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.replace(dest)


def cached(c, source: str, url: str, params: dict | None = None, headers: dict | None = None,
           refresh: bool = False, cost: int = 0, ttl_days: float | None = None, timeout: float = 30) -> dict:
    """GET JSON through the cache. Returns {status, data, fetched_at, cached}."""
    key = url + ("?" + urllib.parse.urlencode(sorted((params or {}).items())) if params else "")
    row = c.execute("select * from api_cache where source=? and key=?", (source, key)).fetchone()
    if row and not refresh:
        fresh = True
        if ttl_days is not None:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(row["fetched_at"])).total_seconds() / 86400
            fresh = age < ttl_days
        if fresh:
            return {"status": row["status"], "data": json.loads(row["body"] or "null"), "fetched_at": row["fetched_at"], "cached": True}
    status, body = fetch(key, headers, timeout)
    try:
        data = json.loads(body or b"null")
    except ValueError:            # an HTML error page, a captive portal...: report it, never cache it as a good answer
        data = {"error": (body or b"")[:300].decode("utf-8", "replace")}
        if 200 <= status < 300:
            status = 502
    if cost:
        c.execute("insert into api_usage (month, source, calls) values (?,?,?) on conflict(month, source) do update set calls=calls+?",
                  (month(), source, cost, cost))
    if 200 <= status < 300:
        c.execute("insert or replace into api_cache values (?,?,?,?,?,?)", (source, key, now(), status, json.dumps(data), cost))
    return {"status": status, "data": data, "fetched_at": now(), "cached": False}


def usage(c, source: str) -> int:
    r = c.execute("select calls from api_usage where month=? and source=?", (month(), source)).fetchone()
    return r["calls"] if r else 0
