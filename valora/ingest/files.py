"""Drop-in files → proposals with provenance (file, page, line). Nothing is written to the books until the user
accepts a proposal in the Inbox.

- Bank CSV: any bank's export. Columns are detected (date, description, amount or debit/credit). Deposits that
  match a tenant (name in the description or the rent amount) become proposed rent payments; withdrawals get a
  Schedule E category guess from the payee.
- Lease PDF: text PDFs are read with pypdf; labelled patterns pull tenant, unit, dates, rent, deposit, due day,
  late fee. Scanned PDFs have no text: the Inbox says so and asks for the handful of fields.
- Mortgage statement PDF: lender, principal balance, rate, monthly payment, escrow.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import shutil
from datetime import datetime
from pathlib import Path

from .. import db as D, paths

MONEY = r"\$?\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)"
DATE_PATTERNS = ["%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%d-%b-%Y", "%b %d, %Y", "%B %d, %Y", "%m-%d-%Y", "%Y/%m/%d"]

PAYEE_CATEGORIES = [
    (r"home depot|lowe'?s|menards|ace hardware|plumb|electric(al)? (co|svc|service)|hvac|handyman|roof", "Repairs"),
    (r"insur|state farm|allstate|geico|progressive|farmers|nationwide|lemonade", "Insurance"),
    (r"treasurer|county tax|property tax|tax collector|assessor", "Taxes"),
    (r"water|sewer|gas co|gas of|columbia gas|aep |power|energy|edison|duke energy|electric(?! co)|trash|waste|rumpke|utilit", "Utilities"),
    (r"property manage|management fee|mgmt", "Management fees"),
    (r"lawyer|attorney|law office|cpa|accountant|legal", "Legal and other professional fees"),
    (r"zillow rental|apartments\.com|craigslist|advertis|facebook ads", "Advertising"),
    (r"clean|janitor|landscap|lawn|snow|pest", "Cleaning and maintenance"),
    (r"amazon|walmart|target|supply|supplies", "Supplies"),
    (r"uber|lyft|shell|chevron|exxon|bp |mileage|parking", "Auto and travel"),
]
LOAN_WORDS = r"mortgage|loan pmt|loan payment|mtg|rocket|wells fargo home|chase home|mr\.? cooper|pennymac|freedom mortgage|navy federal mtg"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def store(c, name: str, data: bytes, kind: str | None = None, property_id: int | None = None) -> dict:
    h = sha(data)
    have = D.one(c, "select * from document where sha256=?", (h,))
    if have:
        return {"id": have["id"], "dup": True}
    dest = paths.sub("docs") / f"{h[:12]}_{Path(name).name}"
    dest.write_bytes(data)
    kind = kind or guess_kind(name, data)
    did = D.insert(c, "document", {"sha256": h, "name": Path(name).name, "path": str(dest), "kind": kind, "property_id": property_id})
    return {"id": did, "dup": False, "kind": kind}


def guess_kind(name: str, data: bytes) -> str:
    n = name.lower()
    if n.endswith((".csv", ".tsv")) or n.endswith(".txt") and b"," in data[:2000]:
        return "bank_csv"
    if n.endswith(".pdf"):
        t = pdf_text(data)[:6000].lower()
        if any(w in t for w in ("lease agreement", "residential lease", "rental agreement", "landlord", "tenant shall")):
            return "lease"
        if any(w in t for w in ("principal balance", "escrow balance", "mortgage statement", "loan number", "amount due")):
            return "mortgage"
        if any(w in t for w in ("offering memorandum", "rent roll", "cap rate", "noi")):
            return "brochure"
        return "pdf"
    return "other"


def pdf_pages(data: bytes) -> list[str]:
    try:
        from pypdf import PdfReader
        r = PdfReader(io.BytesIO(data))
        return [(p.extract_text() or "") for p in r.pages]
    except Exception:
        return []


def pdf_text(data: bytes) -> str:
    return "\n".join(pdf_pages(data))


def parse_date(s: str) -> str | None:
    s = s.strip().replace("  ", " ")
    s = re.sub(r"(\d)(st|nd|rd|th)", r"\1", s)
    for f in DATE_PATTERNS:
        try:
            return datetime.strptime(s, f).date().isoformat()
        except ValueError:
            pass
    return None


def money(s: str) -> float | None:
    s = (s or "").strip()
    neg = s.startswith("(") and s.endswith(")") or s.startswith("-")
    s = re.sub(r"[^0-9.]", "", s)
    if not s or s == ".":
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


# ---------- bank CSV ----------

def read_bank_csv(text: str) -> tuple[list[dict], dict]:
    sample = text[:4000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.reader(io.StringIO(text), dialect))
    hi = next((i for i, r in enumerate(rows[:25]) if len([x for x in r if x.strip()]) >= 3
               and any(re.search(r"date|posted", x, re.I) for x in r)), 0)
    head = [h.strip().lower() for h in rows[hi]]
    def col(*pats):
        for p in pats:
            for i, h in enumerate(head):
                if re.search(p, h):
                    return i
        return None
    m = {"date": col(r"^date$", r"^(transaction|trans\.?|txn) date$", r"^post(ed|ing)? date$", r"posted", r"date"),
         "desc": col(r"^desc", r"desc", r"payee", r"narrative", r"memo", r"name", r"details"),
         "amount": col(r"^amount$", r"^amount", r"amount"), "debit": col(r"debit", r"withdrawal", r"^money out|paid out|^out$"),
         "credit": col(r"credit", r"deposit", r"^money in|paid in|^in$")}
    out = []
    for ln, r in enumerate(rows[hi + 1:], start=hi + 2):
        if not r or m["date"] is None or len(r) <= m["date"]:
            continue
        d = parse_date(r[m["date"]])
        if not d:
            continue
        if m["amount"] is not None and m["amount"] < len(r) and r[m["amount"]].strip():
            amt = money(r[m["amount"]])
        else:
            cr = money(r[m["credit"]]) if m["credit"] is not None and m["credit"] < len(r) else None
            db = money(r[m["debit"]]) if m["debit"] is not None and m["debit"] < len(r) else None
            amt = (cr or 0) - abs(db or 0)
        if amt is None or abs(amt) < 0.005:
            continue
        out.append({"date": d, "amount": amt, "description": (r[m["desc"]] if m["desc"] is not None and m["desc"] < len(r) else "").strip(), "line": ln})
    return out, m


def import_bank(c, doc_id: int, account: str = "") -> dict:
    doc = D.one(c, "select * from document where id=?", (doc_id,))
    text = Path(doc["path"]).read_text(encoding="utf-8-sig", errors="replace")
    txns, mapping = read_bank_csv(text)
    leases = D.rows(c, """select l.id, l.rent, t.name, u.property_id, u.name as unit from lease l join unit u on u.id=l.unit_id
        left join tenant t on t.id=l.tenant_id where l.status in ('active','notice')""")
    props = D.rows(c, "select id, address from property where owned=1")
    hist = D.rows(c, "select vendor, property_id, category from expense where vendor is not null and vendor != ''")
    new = dup = 0
    seen: dict[str, int] = {}
    for t in txns:
        base = f"{account}|{t['date']}|{t['amount']:.2f}|{t['description']}"
        seen[base] = seen.get(base, 0) + 1
        h = sha((base if seen[base] == 1 else f"{base}|{seen[base]}").encode())
        if D.one(c, "select 1 from bank_txn where hash=?", (h,)):
            dup += 1
            continue
        D.insert(c, "bank_txn", {"account": account or doc["name"], "date": t["date"], "amount": t["amount"],
                                 "description": t["description"], "hash": h, "document_id": doc_id, "line": t["line"],
                                 "matched": json.dumps(propose(t, leases, props, hist))})
        new += 1
    c.execute("update document set status='read', pages=?, text=? where id=?", (len(txns), text[:200000], doc_id))
    return {"rows": len(txns), "new": new, "dup": dup, "columns": mapping}


def _payee_key(s: str) -> str:
    """First two words of a payee, letters only: 'THE HOME DEPOT #3817 COLUMBUS' and 'The Home Depot' -> 'home depot'."""
    w = [x for x in re.sub(r"[^a-z ]", " ", (s or "").lower()).split() if x not in ("the", "des", "pos", "ach", "debit", "card", "purchase")]
    return " ".join(w[:2])


def _from_history(desc: str, hist: list[dict] | None, props: list[dict]) -> dict | None:
    """Earlier expenses from the same payee: if they all went to one property, propose it (and their usual category)."""
    k = _payee_key(desc)
    if not k or not hist:
        return None
    same = [h for h in hist if _payee_key(h.get("vendor")) == k]
    pids = {h["property_id"] for h in same}
    if len(pids) != 1:
        return None
    pid = pids.pop()
    if not any(p["id"] == pid for p in props):
        return None
    cats: dict[str, int] = {}
    for h in same:
        cats[h.get("category") or "Other"] = cats.get(h.get("category") or "Other", 0) + 1
    addr = next(p["address"] for p in props if p["id"] == pid).split(",")[0]
    return {"property_id": pid, "category": max(cats, key=cats.get), "n": len(same), "addr": addr}


def propose(t: dict, leases: list[dict], props: list[dict], hist: list[dict] | None = None) -> dict:
    desc = t["description"].lower()
    words = set(re.sub(r"[^a-z0-9 ]", " ", desc).split())
    if t["amount"] > 0:
        scored = []
        for L in leases:
            parts = [w for w in re.sub(r"[^a-z ]", " ", (L.get("name") or "").lower()).split() if len(w) > 1]
            full = len(parts) > 1 and all(w in words for w in parts)
            some = not full and any(w in words for w in parts if len(w) > 2)
            amt = abs(t["amount"] - (L["rent"] or 0)) < 1
            score = (3 if full else 1 if some else 0) + (2 if amt else 0)
            if score:
                scored.append((score, full, some, amt, L))
        if scored:
            top = max(s[0] for s in scored)
            best = [s for s in scored if s[0] == top]
            score, full, some, amt, L = best[0]
            tie = len(best) > 1
            conf = {5: 0.95, 3: 0.8, 2: 0.55, 1: 0.3}.get(score, 0.75 if (some and amt) else 0.5)
            why = ("full name" if full else "name" if some else "") + (" and " if (full or some) and amt else "") + ("rent amount" if amt else "")
            why = f"{why} match {L.get('name') or 'tenant'} ({L['unit']}, {f'{L["rent"]:,.0f}' if L.get('rent') else '?'}/mo)"
            if tie:
                conf = min(conf, 0.4)
                why += f"; {len(best)} leases match equally, check it"
            elif full and not amt:
                why += f"; amount differs from rent by {t['amount'] - (L['rent'] or 0):+,.2f}"
            return {"kind": "payment", "lease_id": L["id"], "why": why, "confidence": conf}
        return {"kind": "income", "why": "deposit with no tenant match", "confidence": 0.2}
    if re.search(LOAN_WORDS, desc):
        return {"kind": "debt", "why": "looks like a loan payment (principal is not an expense; interest is split at year end)", "confidence": 0.6}
    hp = _from_history(desc, hist, props)
    for pat, cat in PAYEE_CATEGORIES:
        if re.search(pat, desc):
            pid = next((p["id"] for p in props if p["address"] and p["address"].split(",")[0].lower()[:10] in desc), None)
            if pid is None and hp:
                return {"kind": "expense", "category": cat, "property_id": hp["property_id"], "confidence": 0.75,
                        "why": f"payee looks like {cat.lower()}; {hp['n']} earlier expense{'s' if hp['n'] > 1 else ''} from this payee went to {hp['addr']}"}
            if pid is None and len(props) == 1:
                pid = props[0]["id"]
            return {"kind": "expense", "category": cat, "property_id": pid, "why": f"payee looks like {cat.lower()}", "confidence": 0.6}
    if hp:
        return {"kind": "expense", "category": hp["category"], "property_id": hp["property_id"], "confidence": 0.6,
                "why": f"{hp['n']} earlier expense{'s' if hp['n'] > 1 else ''} from this payee: {hp['category']} at {hp['addr']}"}
    return {"kind": "expense", "category": "Other", "property_id": props[0]["id"] if len(props) == 1 else None,
            "why": "no rule matched", "confidence": 0.2}


def accept_txn(c, txn_id: int, override: dict | None = None) -> dict:
    t = D.one(c, "select * from bank_txn where id=?", (txn_id,))
    m = {**json.loads(t["matched"] or "{}"), **(override or {})}
    k = m.get("kind")
    if k == "payment" and m.get("lease_id"):
        D.insert(c, "ledger_entry", {"lease_id": int(m["lease_id"]), "date": t["date"], "type": "payment", "amount": abs(t["amount"]),
                                     "memo": t["description"][:80], "bank_txn_id": txn_id})
    elif k == "expense" and m.get("property_id"):
        D.insert(c, "expense", {"property_id": int(m["property_id"]), "date": t["date"], "category": m.get("category") or "Other",
                                "amount": abs(t["amount"]), "vendor": t["description"][:60], "bank_txn_id": txn_id,
                                "document_id": t["document_id"]})
    elif k not in ("ignore", "debt", "income"):
        return {"error": "pick a lease or a property first"}
    m["done"] = True
    c.execute("update bank_txn set matched=? where id=?", (json.dumps(m), txn_id))
    if t["document_id"] and not c.execute("""select 1 from bank_txn where document_id=? and matched not like '%"done": true%'""",
                                          (t["document_id"],)).fetchone():
        c.execute("update document set status='applied' where id=? and kind='bank_csv'", (t["document_id"],))
    return {"ok": True}


# ---------- lease / mortgage PDFs ----------

LEASE_RULES = [
    ("tenant", r"(?:tenant|lessee|resident)s?\s*(?:name)?s?\s*[:\-]\s*([A-Z][A-Za-z.'\- ]{2,60}?)(?:\s{2,}|,|\(|$)"),
    ("tenant", r"by and between\s+.+?\(\"?landlord\"?\)\s*,?\s*and\s+([A-Z][A-Za-z.'\- ]{2,60}?)\s*\(\"?tenant"),
    ("unit", r"\b(?:unit|apt\.?|apartment|suite)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Za-z0-9\-]{1,6})\b"),
    ("start", r"(?:commenc\w*|start\w*|beginning)\s*(?:date|on)?\s*[:\-]?\s*(?:on\s+)?([A-Z][a-z]+ \d{1,2},? \d{4}|\d{1,2}/\d{1,2}/\d{2,4})"),
    ("end", r"(?:end\w*|terminat\w*|expir\w*)\s*(?:date|on)?\s*[:\-]?\s*(?:on\s+)?([A-Z][a-z]+ \d{1,2},? \d{4}|\d{1,2}/\d{1,2}/\d{2,4})"),
    ("rent", r"(?:monthly rent|rent of|rent shall be|rent is|base rent|rent)\s*(?:amount)?\s*(?:of|is|:|\-)?\s*" + MONEY + r"\s*(?:per month|/\s*mo|monthly|each month)?"),
    ("deposit", r"security deposit\s*(?:of|in the amount of|:|\-)?\s*" + MONEY),
    ("due_day", r"(?:due|payable)\s+on\s+(?:or before\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+)?of\s+(?:each|every)\s+month"),
    ("late_fee", r"late (?:fee|charge)\s*(?:of|:|\-)?\s*" + MONEY),
    ("grace_days", r"(?:within|after)\s+(\d{1,2})\s+days?\s+(?:of|after)\s+(?:the\s+)?(?:due date|being due)"),
]
MORTGAGE_RULES = [
    ("lender", r"^([A-Z][A-Za-z&.,' ]{3,40}(?:mortgage|bank|home loans|lending|servicing|financial)[A-Za-z.,' ]{0,20})$"),
    ("principal", r"(?:unpaid |outstanding )?principal balance\s*[:\-]?\s*" + MONEY),
    ("rate", r"interest rate\s*[:\-]?\s*([0-9]{1,2}\.[0-9]{1,4})\s*%"),
    ("payment", r"(?:principal (?:and|&) interest|p\s*&\s*i)\s*[:\-]?\s*" + MONEY),
    ("escrow", r"escrow (?:payment|amount|deposit)?\s*[:\-]?\s*" + MONEY),
    ("total_due", r"(?:total )?amount due\s*[:\-]?\s*" + MONEY),
    ("statement_date", r"statement date\s*[:\-]?\s*([A-Z][a-z]+ \d{1,2},? \d{4}|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2})"),
    ("due_date", r"(?:payment )?due date\s*[:\-]?\s*([A-Z][a-z]+ \d{1,2},? \d{4}|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2})"),
    ("maturity", r"maturity date\s*[:\-]?\s*([A-Z][a-z]+ \d{1,2},? \d{4}|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2})"),
]


def _scan(pages: list[str], rules) -> list[dict]:
    """First match per field. A pattern is tried on the line alone, then on the line joined with the next one
    (labels and values that the PDF split across two lines); `raw` is the exact text the value was read from."""
    out, seen = [], set()
    for pi, txt in enumerate(pages, start=1):
        lines = txt.splitlines()
        for li, line in enumerate(lines, start=1):
            nxt = lines[li] if li < len(lines) else ""
            window = (line + " " + nxt) if nxt else line
            for field, pat in rules:
                if field in seen:
                    continue
                if field == "lender" and re.search(r"statement|summary|account|page", line, re.I):
                    continue
                raw, m = line.strip(), re.search(pat, line, re.I | re.M)
                if not m and field != "lender" and nxt:
                    m = re.search(pat, window, re.I)
                    if m and m.start() >= len(line):      # wholly on the next line: that line gets its own turn
                        m = None
                    raw = window.strip()
                if not m:
                    continue
                g = m.group(1).strip()
                val = g
                if field in ("rent", "deposit", "late_fee", "principal", "payment", "escrow", "total_due"):
                    val = money(g)
                elif field in ("start", "end", "statement_date", "due_date", "maturity"):
                    val = parse_date(g)
                elif field in ("due_day", "grace_days"):
                    val = int(g)
                elif field == "rate":
                    val = float(g) / 100
                if val in (None, ""):
                    continue
                out.append({"page": pi, "line": li, "field": field, "raw": raw[:200], "value": val,
                            "confidence": 0.8 if re.search(r":\s*\S", raw) else 0.6})
                seen.add(field)
    return out


def extract(c, doc_id: int) -> dict:
    doc = D.one(c, "select * from document where id=?", (doc_id,))
    data = Path(doc["path"]).read_bytes()
    if doc["kind"] == "bank_csv":
        return import_bank(c, doc_id)
    pages = pdf_pages(data)
    c.execute("update document set pages=?, text=? where id=?", (len(pages), "\n\f".join(pages)[:200000], doc_id))
    if not any(p.strip() for p in pages):
        c.execute("update document set status='no_text' where id=?", (doc_id,))
        return {"fields": 0, "no_text": True}
    rules = LEASE_RULES if doc["kind"] == "lease" else MORTGAGE_RULES if doc["kind"] == "mortgage" else []
    found = _scan(pages, rules)
    c.execute("delete from extraction where document_id=? and status='proposed'", (doc_id,))
    for x in found:
        D.insert(c, "extraction", {**x, "document_id": doc_id, "value": json.dumps(x["value"]), "target": doc["kind"]})
    c.execute("update document set status='read' where id=?", (doc_id,))
    return {"fields": len(found)}


def apply_doc(c, doc_id: int, values: dict, property_id: int | None, unit_id: int | None = None) -> dict:
    """Write an accepted lease or mortgage to the books, linking the extraction rows used."""
    doc = D.one(c, "select * from document where id=?", (doc_id,))
    ex = {e["field"]: e for e in D.rows(c, "select * from extraction where document_id=?", (doc_id,))}
    if doc["kind"] == "lease":
        if not unit_id:
            unit_id = D.insert(c, "unit", {"property_id": property_id, "name": values.get("unit") or "Unit 1", "status": "occupied"})
        tid = D.insert(c, "tenant", {"name": values.get("tenant") or "Tenant"})
        lid = D.insert(c, "lease", {"unit_id": unit_id, "tenant_id": tid, "start": values.get("start"), "end": values.get("end"),
                                    "rent": float(values.get("rent") or 0), "deposit": float(values.get("deposit") or 0),
                                    "due_day": int(values.get("due_day") or 1), "late_fee": float(values.get("late_fee") or 0),
                                    "grace_days": int(values.get("grace_days") or 5), "status": "active",
                                    "extraction_id": (ex.get("rent") or {}).get("id")})
        c.execute("update unit set status='occupied' where id=?", (unit_id,))
        out = {"lease_id": lid}
    elif doc["kind"] == "mortgage":
        pmt = float(values.get("payment") or 0) or None
        out = {"debt_id": D.insert(c, "debt", {"property_id": property_id, "lender": values.get("lender"),
                                               "principal": float(values.get("principal") or 0), "rate": float(values.get("rate") or 0),
                                               "years": float(values.get("years") or 30), "start": values.get("start") or values.get("statement_date") or datetime.now().date().isoformat(),
                                               "payment": pmt, "escrow": float(values.get("escrow") or 0),
                                               "extraction_id": (ex.get("principal") or {}).get("id")})}
    else:
        return {"error": "nothing to apply for this kind of document"}
    c.execute("update extraction set status='accepted' where document_id=?", (doc_id,))
    c.execute("update document set status='applied', property_id=coalesce(property_id, ?) where id=?", (property_id, doc_id))
    return out
