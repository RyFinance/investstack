"""SQLite store. One file per workspace (real or demo). Dates ISO strings, money in dollars (2dp)."""
from __future__ import annotations

import json
import math
import sqlite3
import threading
from contextlib import contextmanager

from . import config, paths

SCHEMA = """
create table if not exists property (
  id integer primary key, address text not null, address_norm text unique, city text, state text, zip text,
  county text, county_fips text, lat real, lon real, type text, beds real, baths real, sqft real, lot real,
  year_built integer, units integer default 1, owned integer default 0, tags text default '',
  last_sale_price real, last_sale_date text, owner_name text, owner_occupied integer,
  source text, fetched_at text, extraction_id integer, created text default (datetime('now')), notes text default ''
);
create table if not exists parcel (
  id integer primary key, property_id integer references property(id) on delete cascade, apn text, year integer,
  assessed_land real, assessed_impr real, assessed_total real, tax_amount real, source text
);
create table if not exists listing (
  id integer primary key, property_id integer references property(id) on delete cascade, kind text, price real,
  status text, listed text, removed text, dom integer, source text, url text, fetched_at text, raw text
);
create table if not exists sale_history (
  id integer primary key, property_id integer references property(id) on delete cascade, date text, price real,
  kind text, source text
);
create table if not exists comp (
  id integer primary key, subject_id integer references property(id) on delete cascade, kind text, address text,
  lat real, lon real, price real, beds real, baths real, sqft real, lot real, year_built integer, date text,
  distance real, days_old integer, correlation real, included integer default 1, source text
);
create table if not exists valuation (
  id integer primary key, property_id integer references property(id) on delete cascade, kind text, value real,
  low real, high real, n integer, source text, as_of text
);
create table if not exists scenario (
  id integer primary key, property_id integer references property(id) on delete cascade, name text, strategy text,
  inputs text, outputs text, updated text default (datetime('now'))
);
create table if not exists market_series (
  geo_type text, geo_id text, metric text, date text, value real, source text,
  primary key (geo_type, geo_id, metric, date)
);
create table if not exists market_snap (
  geo_type text, geo_id text, metric text, name text, state text, metro text, latest real, chg1y real, chg5y real,
  as_of text, source text, primary key (geo_type, geo_id, metric)
);
create table if not exists api_cache (
  source text, key text, fetched_at text, status integer, body text, cost integer default 0, primary key (source, key)
);
create table if not exists api_usage (month text, source text, calls integer default 0, primary key (month, source));
create table if not exists deal (
  id integer primary key, property_id integer unique references property(id) on delete cascade, stage text,
  stage_entered text, ask real, offer real, strategy text, score real, notes text default '',
  created text default (datetime('now')), closed text, reason text
);
create table if not exists deal_event (
  id integer primary key, deal_id integer references deal(id) on delete cascade, ts text default (datetime('now')),
  kind text, text text
);
create table if not exists task (
  id integer primary key, deal_id integer references deal(id) on delete cascade, property_id integer,
  title text, due text, done integer default 0, created text default (datetime('now'))
);
create table if not exists document (
  id integer primary key, sha256 text unique, name text, path text, kind text, pages integer, property_id integer,
  imported text default (datetime('now')), status text default 'new', text text
);
create table if not exists extraction (
  id integer primary key, document_id integer references document(id) on delete cascade, page integer, line integer,
  field text, raw text, value text, confidence real, status text default 'proposed', target text
);
create table if not exists unit (
  id integer primary key, property_id integer references property(id) on delete cascade, name text, beds real,
  baths real, sqft real, market_rent real, status text default 'vacant'
);
create table if not exists tenant (
  id integer primary key, name text, email text, phone text, notes text default ''
);
create table if not exists lease (
  id integer primary key, unit_id integer references unit(id) on delete cascade, tenant_id integer references tenant(id),
  start text, end text, rent real, deposit real, due_day integer default 1, late_fee real default 0,
  grace_days integer default 5, escalation real default 0, status text default 'active', extraction_id integer
);
create table if not exists ledger_entry (
  id integer primary key, lease_id integer references lease(id) on delete cascade, date text, type text,
  amount real, memo text, bank_txn_id integer
);
create table if not exists bank_txn (
  id integer primary key, account text, date text, amount real, description text, hash text unique,
  matched text, document_id integer, line integer
);
create table if not exists expense (
  id integer primary key, property_id integer references property(id) on delete cascade, date text, category text,
  amount real, vendor text, memo text, bank_txn_id integer, document_id integer
);
create table if not exists property_budget (
  id integer primary key, property_id integer not null references property(id) on delete cascade,
  kind text not null check (kind in ('rent','expense')), name text not null, amount real not null check (amount >= 0),
  cadence text not null check (cadence in ('monthly','annual')),
  unique (property_id, kind, name)
);
create table if not exists property_source (
  id integer primary key, property_id integer not null references property(id) on delete cascade,
  kind text not null, source text not null, url text not null default '', fields text not null,
  imported text not null default (datetime('now')),
  unique (property_id, kind, source, url)
);
create table if not exists debt (
  id integer primary key, property_id integer references property(id) on delete cascade, lender text, principal real,
  rate real, years real, start text, payment real, escrow real default 0, io integer default 0, extraction_id integer
);
create table if not exists maintenance (
  id integer primary key, property_id integer references property(id) on delete cascade, unit_id integer,
  title text, opened text default (date('now')), closed text, status text default 'open', priority text default 'normal',
  cost real, vendor text
);
create table if not exists owned (
  property_id integer primary key references property(id) on delete cascade, purchase_price real, purchase_date text,
  closing_costs real default 0, rehab real default 0, value_est real, value_src text, value_as_of text
);
create table if not exists search (
  id integer primary key, name text, query text, created text default (datetime('now'))
);
create index if not exists ix_listing_prop on listing(property_id);
create index if not exists ix_comp_subj on comp(subject_id);
create index if not exists ix_ledger_lease on ledger_entry(lease_id, date);
create index if not exists ix_expense_prop on expense(property_id, date);
"""

_lock = threading.RLock()
_ready: set[str] = set()


def path():
    return paths.db_file(bool(config.load().get("demo")))


@contextmanager
def db(demo: bool | None = None):
    p = paths.db_file(bool(config.load().get("demo")) if demo is None else demo)
    c = sqlite3.connect(p, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute("pragma foreign_keys=on")
    if str(p) not in _ready:
        with _lock:
            c.execute("pragma journal_mode=wal")
            c.executescript(SCHEMA)
            _ready.add(str(p))
    try:
        yield c
        c.commit()
    finally:
        c.close()


def rows(c, sql: str, args=()) -> list[dict]:
    return [dict(r) for r in c.execute(sql, args)]


def one(c, sql: str, args=()) -> dict | None:
    r = c.execute(sql, args).fetchone()
    return dict(r) if r else None


def insert(c, table: str, data: dict) -> int:
    ks = list(data)
    cur = c.execute(f"insert into {table} ({','.join(ks)}) values ({','.join('?' * len(ks))})",
                    [json.dumps(v) if isinstance(v, (dict, list)) else v for v in data.values()])
    return cur.lastrowid


def update(c, table: str, id_: int, data: dict, key: str = "id") -> None:
    if not data:
        return
    c.execute(f"update {table} set {','.join(k + '=?' for k in data)} where {key}=?",
              [json.dumps(v) if isinstance(v, (dict, list)) else v for v in data.values()] + [id_])


_ABBR = {"street": "st", "avenue": "ave", "av": "ave", "road": "rd", "drive": "dr", "boulevard": "blvd", "lane": "ln",
         "court": "ct", "place": "pl", "north": "n", "south": "s", "east": "e", "west": "w", "northeast": "ne",
         "northwest": "nw", "southeast": "se", "southwest": "sw", "apartment": "apt", "unit": "apt", "suite": "ste",
         "highway": "hwy", "parkway": "pkwy", "terrace": "ter", "circle": "cir"}


def norm_address(a: str) -> str:
    """Comparable form of an address: lower case, punctuation dropped, USPS abbreviations, '#'/'unit' → 'apt',
    ZIP+4 cut to the ZIP and a trailing country dropped (so '... OH 43201-1234, USA' == '... OH 43201')."""
    import re
    s = (a or "").lower()
    s = re.sub(r"\b(\d{5})-\d{4}\b", r"\1", s)
    s = s.replace("#", " apt ")
    s = re.sub(r"(\d)/(\d)", r"\1_\2", s)                    # keep '1/2' (as in '123 1/2 Main St') distinct from '1 2'
    s = re.sub(r"[^a-z0-9_ ]", " ", s)
    ws = [_ABBR.get(w, w) for w in s.split()]
    while ws and ws[-1] in ("usa", "us", "america"):
        ws.pop()
        if ws and ws[-1] == "united":
            ws.pop()
    if ws[-2:] == ["united", "states"]:
        ws = ws[:-2]
    out = []
    for w in ws:                                            # 'apt apt 2' (from 'Apt #2') → 'apt 2'
        if not (w == "apt" and out and out[-1] == "apt"):
            out.append(w)
    return " ".join(out)


_cols: dict[str, set[str]] = {}


def columns(c, table: str) -> set[str]:
    """Column names of a table (for filtering user-supplied keys before they reach SQL)."""
    if table not in _cols:
        _cols[table] = {r[1] for r in c.execute(f"pragma table_info({table})")}
    return _cols[table]


_types: dict[str, dict[str, str]] = {}
_TRUE, _FALSE = ("true", "yes", "on", "y"), ("false", "no", "off", "n")


def coltypes(c, table: str) -> dict[str, str]:
    if table not in _types:
        _types[table] = {r[1]: (r[2] or "").lower() for r in c.execute(f"pragma table_info({table})")}
    return _types[table]


def coerce(col: str, typ: str, v):
    """A form value for a numeric column: '' → None, '$1,250' → 1250.0, 'true' → 1; anything else non-numeric
    raises ValueError (a typo must not reach the ledger as text and break every page that does arithmetic)."""
    if typ not in ("real", "integer") or v is None or isinstance(v, (int, float)) and not isinstance(v, bool):
        if isinstance(v, float) and not math.isfinite(v):
            raise ValueError(f"{col} must be a finite number")
        return v
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (dict, list)):
        raise ValueError(f"{col} must be a number")
    s = str(v).strip().replace(",", "").replace("$", "")
    if s == "":
        return None
    if typ == "integer" and s.lower() in _TRUE + _FALSE:
        return int(s.lower() in _TRUE)
    try:
        x = float(s)
    except ValueError:
        raise ValueError(f"{col} must be a number, got {str(v)[:40]!r}") from None
    if not math.isfinite(x):
        raise ValueError(f"{col} must be a finite number")
    return int(round(x)) if typ == "integer" and abs(x) < 2 ** 62 else x


def clean(c, table: str, data: dict, drop=("id",)) -> dict:
    """User-supplied columns for `table`: unknown keys dropped, numeric columns coerced (ValueError on garbage)."""
    types = coltypes(c, table)
    return {k: coerce(k, types[k], v) for k, v in (data or {}).items() if k in types and k not in drop}
