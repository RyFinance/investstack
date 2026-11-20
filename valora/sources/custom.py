"""User-defined, read-only HTTPS property feeds with explicitly mapped JSON fields."""
from __future__ import annotations

import http.client
import ipaddress
import json
import math
import re
import secrets
import socket
from datetime import date
from urllib.parse import urlencode, urlsplit

from .. import config, db as D, net, property_data

CACHE = "custom-feed-preview"
FIELDS = ("beds", "baths", "sqft", "lot", "year_built", "value", "rent")
MAX_RESPONSE = 1024 * 1024
NAME = re.compile(r"[A-Za-z0-9_!#$%&'*+.^`|~-]{1,64}")
FIELD_PATH = re.compile(r"[\w-]+(?:\.[\w-]+)*")
RESERVED_HEADERS = {
    "host", "connection", "content-length", "transfer-encoding", "upgrade", "cookie",
    "accept-encoding", "proxy-authorization", "forwarded", "te", "trailer", "expect",
}


def public() -> list[dict]:
    return [{**{k: row[k] for k in ("id", "name", "endpoint", "address_param", "auth", "auth_name", "mapping", "currency")},
             "extra": [{k: entry[k] for k in ("auth", "auth_name")} for entry in row.get("extra", [])]}
            for row in config.connectors()]


def _endpoint(value: str):
    url = urlsplit(value)
    if (len(value) > 1500 or any(ch.isspace() for ch in value) or url.scheme != "https"
            or not url.hostname or not re.fullmatch(r"(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]+", url.hostname)
            or url.username is not None or url.port not in (None, 443) or url.query or url.fragment
            or "\\" in value):
        raise ValueError("Enter a public HTTPS endpoint with no credentials, query string, or fragment")
    return url


def _check_credential(auth: str, name: str, key: str, address_param: str) -> None:
    if auth in ("header", "query") and (not NAME.fullmatch(name) or (auth == "query" and name == address_param)):
        raise ValueError("Enter a separate credential name")
    if auth == "header" and name.lower() in RESERVED_HEADERS:
        raise ValueError("Choose a header designed for API authentication")
    if len(key) > 4096 or any(not 32 <= ord(ch) < 127 for ch in key):
        raise ValueError("Enter a single-line API key")


def _slot(auth: str, name: str) -> tuple:
    if auth == "bearer":
        return "header", "authorization"
    return auth, name.lower() if auth == "header" else name


def save(body: dict) -> dict:
    name = str(body.get("name") or "").strip()
    endpoint = str(body.get("endpoint") or "").strip()
    _endpoint(endpoint)
    address_param = str(body.get("address_param") or "").strip()
    auth = body.get("auth")
    auth_name = str(body.get("auth_name") or "").strip() if auth in ("header", "query") else ""
    key = str(body.get("key") or "").strip()
    mapping = body.get("mapping")
    currency = str(body.get("currency") or "").strip().upper()
    if not 1 <= len(name) <= 72 or not NAME.fullmatch(address_param):
        raise ValueError("Enter a provider name and an address parameter")
    if auth not in ("none", "bearer", "header", "query"):
        raise ValueError("Choose a credential type")
    _check_credential(auth, auth_name, key, address_param)
    if not isinstance(mapping, dict) or not mapping or set(mapping) - set(FIELDS) or any(
        not isinstance(path, str) or len(path) > 150 or not FIELD_PATH.fullmatch(path) for path in mapping.values()
    ):
        raise ValueError("Map at least one field using a JSON path such as result.bedrooms")
    if set(mapping) & {"rent", "value"} and not re.fullmatch(r"[A-Z]{3}", currency):
        raise ValueError("Enter the currency returned by this provider")
    connector_id = body.get("id") or secrets.token_hex(12)

    def update(rows):
        existing = next((row for row in rows if row["id"] == connector_id), None)
        if body.get("id") and not existing:
            raise ValueError("Provider no longer exists")
        if any(row["id"] != connector_id and row["name"].casefold() == name.casefold() for row in rows):
            raise ValueError("Use a different name for each provider")
        credential = key
        if auth != "none" and not credential:
            same_destination = existing and all(
                existing[k] == v for k, v in (("endpoint", endpoint), ("auth", auth), ("auth_name", auth_name))
            )
            if not same_destination:
                raise ValueError("Paste the key for this endpoint")
            credential = existing["key"]
        row = {"id": connector_id, "name": name, "endpoint": endpoint, "address_param": address_param,
               "auth": auth, "auth_name": auth_name, "key": credential if auth != "none" else "",
               "mapping": mapping, "currency": currency}
        if existing:
            if existing["endpoint"] == endpoint:
                row["extra"] = existing.get("extra", [])
                for entry in row["extra"]:
                    _check_credential(entry["auth"], entry["auth_name"], entry["key"], address_param)
                    if _slot(entry["auth"], entry["auth_name"]) == _slot(auth, auth_name):
                        raise ValueError("This credential name is already used by an additional key")
            rows[rows.index(existing)] = row
        else:
            rows.append(row)

    config.update_connectors(update)
    return {"ok": True}


def remove(connector_id: str) -> dict:
    config.update_connectors(lambda rows: rows.__setitem__(slice(None), [r for r in rows if r["id"] != connector_id]))
    return {"ok": True}


def credential(body: dict) -> dict:
    auth = body.get("auth")
    name = str(body.get("auth_name") or "").strip()
    key = str(body.get("key") or "").strip()
    removing = body.get("act") == "drop-credential"
    if auth not in ("header", "query") or (not key and not removing):
        raise ValueError("Choose a named header or query credential and provide its key")

    def update(rows):
        row = next((row for row in rows if row["id"] == body.get("id")), None)
        if not row:
            raise ValueError("Provider no longer exists")
        _check_credential(auth, name, key, row["address_param"])
        slot = _slot(auth, name)
        if slot == _slot(row["auth"], row["auth_name"]):
            raise ValueError("Edit the provider to change its primary key")
        extras = [entry for entry in row.get("extra", []) if _slot(entry["auth"], entry["auth_name"]) != slot]
        if not removing:
            extras.append({"auth": auth, "auth_name": name, "key": key})
        row["extra"] = extras

    config.update_connectors(update)
    return {"ok": True}


def _public_connection(host: str) -> http.client.HTTPSConnection:
    connection = http.client.HTTPSConnection(host, 443, timeout=8)
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not addresses or any(
        not ipaddress.ip_address(row[4][0]).is_global or ipaddress.ip_address(row[4][0]).is_multicast for row in addresses
    ):
        raise ValueError("This endpoint must resolve to a public internet address")

    def connect(_address, timeout, _source_address):
        # Use the validated DNS answer for the socket. TLS still verifies the original hostname.
        for family, socktype, protocol, _, target in addresses[:4]:
            stream = socket.socket(family, socktype, protocol)
            stream.settimeout(timeout)
            try:
                stream.connect(target)
                return stream
            except OSError:
                stream.close()
        raise OSError("Could not connect")

    connection._create_connection = connect
    return connection


def _request(row: dict, address: str):
    url = _endpoint(row["endpoint"])
    params = {row["address_param"]: address}
    headers = {"Accept": "application/json", "User-Agent": net.UA}
    for entry in [row, *row.get("extra", [])]:
        if entry["auth"] == "bearer":
            headers["Authorization"] = "Bearer " + entry["key"]
        elif entry["auth"] == "header":
            headers[entry["auth_name"]] = entry["key"]
        elif entry["auth"] == "query":
            params[entry["auth_name"]] = entry["key"]
    connection = None
    try:
        connection = _public_connection(url.hostname)
        connection.request("GET", (url.path or "/") + "?" + urlencode(params), headers=headers)
        response = connection.getresponse()
        if not 200 <= response.status < 300:
            raise ValueError(f"Provider returned HTTP {response.status}")
        body = response.read(MAX_RESPONSE + 1)
        if len(body) > MAX_RESPONSE:
            raise ValueError("Provider response is too large")
        try:
            return json.loads(body)
        except (ValueError, RecursionError):
            raise ValueError("Provider did not return a JSON response") from None
    except (OSError, http.client.HTTPException, UnicodeError):
        raise ValueError("Could not reach the provider over HTTPS") from None
    finally:
        if connection:
            connection.close()


def _number(payload, path: str):
    for part in path.split("."):
        if isinstance(payload, dict):
            payload = payload.get(part)
        elif isinstance(payload, list) and part.isascii() and part.isdigit() and int(part) < len(payload):
            payload = payload[int(part)]
        else:
            return None
    if isinstance(payload, bool) or not isinstance(payload, (int, float, str)):
        return None
    try:
        value = float(payload)
    except (ValueError, OverflowError):
        return None
    return value if math.isfinite(value) and 0 <= value < 10**15 else None


def preview(c, body: dict) -> dict:
    row = next((r for r in config.connectors() if r["id"] == body.get("id")), None)
    prop = D.one(c, "select id, address from property where id=?", (body.get("property_id"),))
    if not row or not prop:
        raise ValueError("Choose a provider and a saved property")
    currency = "USD" if config.load()["demo"] else config.load()["currency"]
    payload = _request(row, prop["address"])
    facts = {k: v for k, path in row["mapping"].items() if (v := _number(payload, path)) is not None}
    if "year_built" in facts and not 1500 <= facts["year_built"] <= date.today().year + 5:
        facts.pop("year_built")
    currency_mismatch = bool(set(facts) & {"rent", "value"}) and row["currency"] != currency
    if currency_mismatch:
        facts.pop("rent", None)
        facts.pop("value", None)
    if facts.get("value") == 0:
        facts.pop("value")
    if not facts:
        raise ValueError("Provider currency differs from the workspace" if currency_mismatch else "No usable mapped numbers returned")
    token = secrets.token_urlsafe(20)
    result = {"property_id": prop["id"], "facts": facts, "source": row["name"], "url": row["endpoint"],
              "currency": currency, "currency_mismatch": currency_mismatch, "address": prop["address"]}
    c.execute("delete from api_cache where source=? and julianday('now')-julianday(fetched_at)>1", (CACHE,))
    D.insert(c, "api_cache", {"source": CACHE, "key": token, "fetched_at": net.now(), "status": 200, "body": json.dumps(result)})
    return {**result, "token": token}


def apply(c, token: str) -> dict:
    c.execute("begin immediate")
    saved = D.one(c, "select body from api_cache where source=? and key=? and julianday('now')-julianday(fetched_at)<=1", (CACHE, token))
    if not saved:
        raise ValueError("Pull the provider again before importing")
    row = json.loads(saved["body"])
    pid, facts = row["property_id"], row["facts"]
    current = D.one(c, "select address from property where id=?", (pid,))
    currency = "USD" if config.load()["demo"] else config.load()["currency"]
    if not current or current["address"] != row["address"] or (set(facts) & {"rent", "value"} and row["currency"] != currency):
        raise ValueError("The property or workspace changed. Pull the provider again.")
    details = D.clean(c, "property", {k: v for k, v in facts.items() if k in property_data.FACTS})
    if details:
        D.update(c, "property", pid, details)
    source = "Custom provider · " + row["source"]
    for kind in ("value", "rent"):
        if kind in facts:
            c.execute("delete from valuation where property_id=? and kind=? and source=?", (pid, kind, source))
            D.insert(c, "valuation", {"property_id": pid, "kind": kind, "value": facts[kind], "source": source,
                                      "as_of": date.today().isoformat()})
    property_data._record(c, pid, "provider", source, row["url"], {**facts, "currency": row["currency"]})
    c.execute("delete from api_cache where source=? and key=?", (CACHE, token))
    return {"ok": True}
