// Inbox — files in, proposals out. Bank CSV rows become proposed rent payments / expenses; lease and mortgage PDFs
// become field proposals, each with the line of the file it was read from. Nothing reaches the books until accepted.
import { S, f, get, post, upload, select, esc } from "../core.js";
import { table, panel, kv, chips, btn, bind, toast, pill, csv, pickFiles, selectBox, confirmModal, useCss, empty, loading } from "../ui.js";

const KINDS = [
  { v: "bank_csv", label: "Bank CSV" }, { v: "lease", label: "Lease" }, { v: "mortgage", label: "Mortgage stmt" },
  { v: "brochure", label: "Brochure" }, { v: "pdf", label: "PDF (other)" }, { v: "other", label: "Other" },
];
const KIND_LABEL = Object.fromEntries(KINDS.map(k => [k.v, k.label]));
const TX_KINDS = [
  { v: "payment", label: "Rent payment" }, { v: "expense", label: "Expense" }, { v: "debt", label: "Loan payment" },
  { v: "income", label: "Other income" }, { v: "ignore", label: "Ignore" },
];
const TX_LABEL = { payment: "Rent", expense: "Expense", debt: "Loan pmt", income: "Income", ignore: "Ignore" };

// field definitions: k, label, type (text|date|money|int|pct), required
const LEASE_F = [
  ["tenant", "Tenant", "text", 1], ["unit", "Unit", "text"], ["start", "Start", "date", 1], ["end", "End", "date"],
  ["rent", "Rent / month", "money", 1], ["deposit", "Deposit", "money"], ["due_day", "Due day", "int"],
  ["late_fee", "Late fee", "money"], ["grace_days", "Grace days", "int"],
];
const MORT_F = [
  ["lender", "Lender", "text"], ["principal", "Principal balance", "money", 1], ["rate", "Interest rate", "pct", 1],
  ["payment", "P&I / month", "money"], ["escrow", "Escrow / month", "money"], ["statement_date", "Statement date", "date"],
  ["years", "Remaining term, yr", "num"],
];
const FALLBACK_N = { lease: 8, mortgage: 6 };          // fields asked for when a PDF has no text layer
const fieldsFor = kind => (kind === "lease" ? LEASE_F : kind === "mortgage" ? MORT_F : []);

let txView = "todo";
let selTxn = null;           // bank_txn id
let curDoc = null;           // document id shown in the viewer
let curLine = null;          // { page, line } highlighted in the viewer
const ovr = {};              // txn id → { kind, lease_id, property_id, category } chosen here, not yet accepted
const drafts = {};           // doc id → { field: typed text }
const docProp = {}, docUnit = {};
let last = null;             // last inbox payload
let busy = false;

const short = (s, n = 26) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const confHtml = c => (f.ok(c) ? `<span class="conf ${c >= 0.75 ? "hi" : c >= 0.5 ? "md" : "lo"}"><i><b style="width:${Math.round(c * 100)}%"></b></i>${Math.round(c * 100)}%</span>` : f.DASH);

function effective(t) {
  return { ...(t.matched || {}), ...(ovr[t.id] || {}) };
}
function ready(m) {
  if (m.kind === "payment") return !!m.lease_id;
  if (m.kind === "expense") return !!m.property_id;
  return ["debt", "income", "ignore"].includes(m.kind);
}

function proposalHtml(t, d) {
  const m = effective(t);
  if (m.done) {
    const k = m.kind === "ignore" ? `<span class="tag mut">Ignored</span>` : `<span class="tag up">Recorded</span>`;
    return `${k} ${esc(TX_LABEL[m.kind] || "")}${targetText(m, d) ? ` · ${esc(targetText(m, d))}` : ""}`;
  }
  const edited = ovr[t.id] ? ` <span class="tag acc" title="Changed here; accept to record">edited</span>` : "";
  const tgt = targetText(m, d);
  const miss = m.kind === "payment" && !m.lease_id ? "pick a lease" : m.kind === "expense" && !m.property_id ? "pick a property" : "";
  return `<span class="tag ${m.kind === "payment" ? "up" : m.kind === "expense" ? "amb" : "mut"}">${esc(TX_LABEL[m.kind] || "?")}</span> `
    + `${esc(tgt)}${miss ? ` <span class="amb">${miss}</span>` : ""}${edited}`;
}
function targetText(m, d) {
  if (m.kind === "payment") {
    const L = (d.leases || []).find(x => x.id === +m.lease_id);
    return L ? `${L.tenant || "Tenant"} · ${L.unit} · ${f.street(L.address)}` : "";
  }
  if (m.kind === "expense") {
    const p = (d.properties || []).find(x => x.id === +m.property_id);
    return `${m.category || "Other"}${p ? " · " + f.street(p.address) : ""}`;
  }
  return "";
}

/* ---------- document text ---------- */

function docLines(doc) {
  const pages = String(doc?.text || "").split("\n\f");
  return pages.map(p => p.split(/\r\n|\r|\n/));
}

async function drawViewer(root, d) {
  const el = root.querySelector("#ib-view");
  if (!el) return;
  const meta = (d.docs || []).find(x => x.id === curDoc);
  if (!meta) { el.innerHTML = panel({ title: "Document text", body: `<div class="note">Select a document, or a source link in a review row, to read the file here with line numbers.</div>` }); return; }
  let doc = null;
  try { doc = await get(`/api/doc/${meta.id}`); } catch (e) { doc = null; }
  const pages = doc?.text ? docLines(doc) : [];
  const hits = new Set((d.extractions || []).filter(x => x.document_id === meta.id).map(x => `${x.page}:${x.line}`));
  let body;
  if (!pages.length || !pages.some(p => p.some(l => l.trim()))) {
    body = `<div class="note">${meta.status === "no_text" ? "This PDF has no text layer (a scan or photo). Enter its fields in the form below." : meta.kind === "bank_csv" ? "The text of this export was not kept. Re-read it to see its rows here." : "No text was extracted from this file."}</div>`;
  } else {
    body = `<div class="ib-doc" data-scroll>` + pages.map((lines, pi) =>
      (pages.length > 1 ? `<span class="pg">Page ${pi + 1}</span>` : "")
      + lines.map((ln, li) => {
        const k = `${pi + 1}:${li + 1}`, cur = curLine && curLine.page === pi + 1 && curLine.line === li + 1;
        return `<div class="${cur ? "cur" : hits.has(k) ? "hit" : ""}" data-k="${k}"><i>${li + 1}</i>${esc(ln) || " "}</div>`;
      }).join("")).join("") + `</div>`;
  }
  el.innerHTML = panel({
    title: short(meta.name, 24), sub: `${meta.kind === "bank_csv" ? f.int(meta.pages) + " rows" : f.int(meta.pages) + (meta.pages === 1 ? " p" : " pp")} · in ${f.dateY(meta.imported)}`,
    right: btn("doc-reread", "Re-read", { cls: "ghost", attrs: `data-id="${meta.id}"`, title: "Read the file again (rows already decided are kept)" })
      + btn("doc-del", "Remove", { cls: "ghost", attrs: `data-id="${meta.id}"`, title: "Remove the file (anything already recorded stays in the books)" }),
    flush: true, body,
  });
  const pre = el.querySelector(".ib-doc"), at = pre && (pre.querySelector("div.cur") || pre.querySelector("div.hit"));
  if (pre && at) pre.scrollTop = Math.max(0, at.offsetTop - pre.clientHeight / 3);
}

function showSource(root, d, docId, page, line) {
  curDoc = +docId;
  curLine = page != null && line != null ? { page: +page, line: +line } : null;
  drawViewer(root, d);
  root.querySelector("#ib-view")?.scrollIntoView({ block: "nearest" });
}

/* ---------- bank rows ---------- */

function txnRows(d) {
  const docs = new Map((d.docs || []).map(x => [x.id, x]));
  return (d.txns || []).map(t => {
    const m = effective(t);
    return { ...t, key: t.id, kind: m.kind, conf: m.confidence, done: !!m.done, why: m.why || "", file: docs.get(t.document_id)?.name || t.account || "" };
  }).filter(t => (txView === "todo" ? !t.done : txView === "done" ? t.done : true));
}

function decisionStrip(d) {
  const t = (d.txns || []).find(x => x.id === selTxn);
  if (!t) return `<div class="ib-dec"><div class="d"><span>Select a row to change its match. <b>Enter</b> accepts the selected row, <b>X</b> ignores it, <b>↑ ↓</b> move.</span></div></div>`;
  const m = effective(t), done = !!t.matched?.done;
  const leaseOpts = [{ v: "", label: "Lease…" }, ...(d.leases || []).map(L => ({ v: L.id, label: `${L.tenant || "Tenant"} · ${L.unit} · ${f.street(L.address)} · ${f.usd(L.rent)}` }))];
  const propOpts = [{ v: "", label: "Property…" }, ...(d.properties || []).map(p => ({ v: p.id, label: f.street(p.address) }))];
  const catOpts = (d.categories || []).filter(c => !["Depreciation", "Mortgage interest"].includes(c));
  const ctl = done ? `<span class="mut">Already ${m.kind === "ignore" ? "ignored" : "recorded"}. Edit it on the ${m.kind === "payment" ? "Ledger" : "Books"} page.</span>`
    : chips("txkind", TX_KINDS, m.kind)
      + (m.kind === "payment" ? `<span class="sep"></span>${selectBox("txlease", leaseOpts, m.lease_id ?? "")}` : "")
      + (m.kind === "expense" ? `<span class="sep"></span>${selectBox("txprop", propOpts, m.property_id ?? "")}${selectBox("txcat", catOpts, m.category || "Other")}` : "")
      + (m.kind === "debt" ? `<span class="mut" style="margin-left:6px">Marked as seen. Principal is not an expense; interest comes from the loan schedule in Books.</span>` : "")
      + (m.kind === "income" ? `<span class="mut" style="margin-left:6px">Marked as seen; not posted to a lease.</span>` : "");
  return `<div class="ib-dec"><div class="d"><b>${f.dateY(t.date)}</b> · <b class="${f.cls(t.amount)}">${f.susd(t.amount, 2)}</b> · ${esc(t.description)}`
    + `<span>${esc(t.matched?.why || "no proposal")} · confidence ${f.ok(t.matched?.confidence) ? Math.round(t.matched.confidence * 100) + "%" : f.DASH} · line ${f.int(t.line)}</span></div>`
    + `<div class="acts">${done ? "" : btn("tx-accept", "Accept  ⏎", { cls: "pri", dis: !ready(m), title: ready(m) ? "Record it" : "Pick a lease or a property first" }) + btn("tx-ignore", "Ignore  X")}${btn("tx-next", "Next ↓", { cls: "ghost" })}</div>`
    + `<div class="ctl">${ctl}</div></div>`;
}

async function acceptTxn(id, kind) {
  if (busy) return;
  const t = (last?.txns || []).find(x => x.id === id);
  if (!t) return;
  const m = kind === "ignore" ? { kind: "ignore" } : effective(t);
  if (!ready(m)) { selTxn = id; toast(m.kind === "payment" ? "Pick the lease this payment belongs to" : "Pick the property this expense belongs to", "bad"); return; }
  const override = { kind: m.kind };
  if (m.kind === "payment") override.lease_id = +m.lease_id;
  if (m.kind === "expense") { override.property_id = +m.property_id; override.category = m.category || "Other"; }
  const rows = txnRows(last), i = rows.findIndex(r => r.id === id);
  busy = true;
  const r = await post("/api/inbox", { act: "accept_txn", id, override });
  busy = false;
  if (r.error) return toast(r.error, "bad");
  delete ovr[id];
  const next = rows[i + 1] || rows[i - 1];
  selTxn = txView === "todo" ? (next && next.id !== id ? next.id : null) : id;
  toast(kind === "ignore" ? "Ignored" : m.kind === "payment" ? `Payment of ${f.usd(Math.abs(t.amount), 2)} posted to the ledger` : m.kind === "expense" ? `Expense of ${f.usd(Math.abs(t.amount), 2)} recorded` : "Marked as seen");
}

/* ---------- lease / mortgage review ---------- */

function fmtVal(type, v) {
  if (v == null || v === "") return "";
  if (type === "money") return f.num(+v, 2).replace("−", "-");
  if (type === "pct") return (+v * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "") + "%";
  if (type === "num") return String(Math.round(+v * 100) / 100);
  return String(v);
}
function parseVal(type, s) {
  s = String(s ?? "").trim();
  if (!s) return null;
  if (type === "money" || type === "int" || type === "num") {
    const n = +s.replace(/[$,\s]/g, "");
    return Number.isFinite(n) ? (type === "int" ? Math.round(n) : n) : undefined;
  }
  if (type === "pct") {
    const n = +s.replace(/[%\s]/g, "");
    return Number.isFinite(n) ? (n > 1 ? n / 100 : n) : undefined;
  }
  if (type === "date") {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/) || null;
    if (m) return s;
    const u = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (u) return `${u[3].length === 2 ? "20" + u[3] : u[3]}-${u[1].padStart(2, "0")}-${u[2].padStart(2, "0")}`;
    return undefined;
  }
  return s;
}

/** Remaining term in years: from the maturity date when the statement has one, else from balance, rate and P&I. */
function remainingYears(ex) {
  const g = k => ex[k]?.value;
  const from = g("statement_date") || g("due_date");
  if (g("maturity") && from) {
    const a = new Date(from), b = new Date(g("maturity"));
    const yrs = (b - a) / (365.25 * 86400000);
    if (yrs > 0) return { v: yrs, src: `maturity ${g("maturity")} − statement date ${from}` };
  }
  const B = +g("principal"), r = +g("rate") / 12, P = +g("payment");
  if (B > 0 && r > 0 && P > B * r) return { v: -Math.log(1 - (r * B) / P) / Math.log(1 + r) / 12, src: "computed from balance, rate and P&I" };
  return null;
}

function guessProperty(d, text) {
  const t = String(text || "").toLowerCase();
  const hit = (d.properties || []).find(p => t.includes(f.street(p.address).toLowerCase()));
  if (hit) return hit.id;
  const num = (d.properties || []).find(p => { const n = f.street(p.address).split(" ")[0]; return n && new RegExp(`\\b${n}\\b`).test(t) && t.includes(f.street(p.address).split(" ")[1]?.toLowerCase() || "\u0000"); });
  return num ? num.id : (d.properties || []).length === 1 ? d.properties[0].id : "";
}
function guessUnit(units, pid, name) {
  const list = units.filter(u => u.property_id === +pid);
  if (!name) return list.find(u => u.status === "vacant")?.id ?? "new";
  const n = String(name).toLowerCase().trim();
  const u = list.find(x => { const a = String(x.name || "").toLowerCase(); return a === n || a.endsWith(" " + n) || a.replace(/^(unit|apt\.?|apartment|suite)\s*/, "") === n; });
  return u ? u.id : "new";
}

async function reviewPanel(doc, d, units) {
  const kind = doc.kind, defs = fieldsFor(kind);
  const exl = (d.extractions || []).filter(x => x.document_id === doc.id);
  const ex = Object.fromEntries(exl.map(x => [x.field, x]));
  const yrs = kind === "mortgage" ? remainingYears(ex) : null;
  if (yrs && !ex.years) ex.years = { value: yrs.v, raw: null, computed: yrs.src };
  let text = "";
  try { text = (await get(`/api/doc/${doc.id}`))?.text || ""; } catch (e) { /* no text */ }
  if (docProp[doc.id] == null) docProp[doc.id] = guessProperty(d, text);
  if (kind === "lease" && docUnit[doc.id] == null && docProp[doc.id]) docUnit[doc.id] = guessUnit(units, docProp[doc.id], ex.unit?.value);
  const dr = drafts[doc.id] || (drafts[doc.id] = {});
  const scanned = doc.status === "no_text";
  const asked = scanned ? defs.slice(0, FALLBACK_N[kind]) : defs;
  const found = asked.filter(([k]) => ex[k]).length;
  const rows = asked.map(([k, label, type, req]) => {
    const x = ex[k], val = dr[k] ?? fmtVal(type, x?.value);
    const srcCell = x?.raw ? `<a data-act="ex-src" data-doc="${doc.id}" data-page="${x.page}" data-line="${x.line}" title="${esc(x.raw)}">${esc(x.raw)}</a>`
      : x?.computed ? `<span class="faint">${esc(x.computed)}</span>` : `<span class="faint">${scanned ? "enter from the paper copy" : "not found in the text"}</span>`;
    return `<tr><td class="f">${esc(label)}${req ? ' <span class="amb">*</span>' : ""}</td>`
      + `<td class="v"><input data-input="exv" data-doc="${doc.id}" data-k="${k}" class="${dr[k] != null ? "edited" : x ? "got" : ""}" value="${esc(val)}"${type === "date" ? ' placeholder="YYYY-MM-DD"' : ""} autocomplete="off" spellcheck="false"></td>`
      + `<td class="raw">${srcCell}</td><td class="pl"${x?.confidence ? ` title="confidence ${Math.round(x.confidence * 100)}%"` : ""}>${x?.page ? `p${x.page} L${x.line}` : ""}</td></tr>`;
  }).join("");
  const propOpts = [{ v: "", label: "Property…" }, ...(d.properties || []).map(p => ({ v: p.id, label: f.street(p.address) }))];
  const unitOpts = [{ v: "new", label: "New unit" }, ...units.filter(u => u.property_id === +docProp[doc.id]).map(u => ({ v: u.id, label: `${u.name} · ${u.status}` }))];
  const extra = kind === "mortgage" ? ["total_due", "due_date", "maturity"].filter(k => ex[k]).map(k => `${k === "total_due" ? "Amount due" : k === "due_date" ? "Due" : "Maturity"} ${k === "total_due" ? f.usd(ex[k].value, 2) : f.dateY(ex[k].value)}`).join(" · ") : "";
  const title = scanned ? `${kind === "lease" ? "Lease" : "Mortgage statement"}: no text layer` : kind === "lease" ? "Lease: fields read" : "Mortgage statement: fields read";
  const sub = scanned ? `${esc(doc.name)} is a scan · enter these ${asked.length} fields` : `${esc(doc.name)} · ${found} of ${asked.length} found${extra ? " · " + esc(extra) : ""}`;
  const applyNote = kind === "lease" ? "Adds the tenant and an active lease (rent charges post from the start date)." : "Adds the loan to Books → Debt, balance as of the statement date.";
  return panel({
    title, sub, flush: true, attrs: `data-doc="${doc.id}"`,
    right: btn("ex-view", "Text", { cls: "ghost", attrs: `data-doc="${doc.id}"`, dis: scanned }),
    body: `<table class="ex"><thead><tr><th>Field</th><th>Value</th><th>Source line</th><th style="text-align:right">Where</th></tr></thead><tbody>${rows}</tbody></table>`
      + `<div class="ex-foot">${selectBox("exprop", propOpts, docProp[doc.id] ?? "").replace("<select", `<select data-doc="${doc.id}"`)}`
      + (kind === "lease" ? selectBox("exunit", unitOpts, docUnit[doc.id] ?? "new").replace("<select", `<select data-doc="${doc.id}"`) : "")
      + `<span class="grow"></span>` + btn("ex-apply", "Apply", { cls: "pri", attrs: `data-doc="${doc.id}"`, title: applyNote }) + `</div>`
      + `<div class="note">${applyNote} Gold outline: read from the file; blue: changed by you.</div>`,
  });
}

function kindPicker(doc) {
  return panel({
    title: "No text layer", sub: `${esc(doc.name)} · scanned or photographed PDF`, flush: true,
    body: `<div class="strip">InvestStack cannot read this file. Say what it is and it asks for the ${FALLBACK_N.lease} lease fields or the ${FALLBACK_N.mortgage} loan fields instead.</div>`
      + `<div class="ex-foot">${btn("ex-kind", "It is a lease", { attrs: `data-doc="${doc.id}" data-kind="lease"` })}${btn("ex-kind", "It is a mortgage statement", { attrs: `data-doc="${doc.id}" data-kind="mortgage"` })}`
      + `<span class="grow"></span>${btn("doc-del", "Remove file", { cls: "warn", attrs: `data-id="${doc.id}"` })}</div>`,
  });
}

async function applyDoc(root, d, units, id) {
  const doc = (d.docs || []).find(x => x.id === id);
  if (!doc) return;
  const defs = fieldsFor(doc.kind), ex = Object.fromEntries((d.extractions || []).filter(x => x.document_id === id).map(x => [x.field, x]));
  const yrs = doc.kind === "mortgage" ? remainingYears(ex) : null;
  const values = {}, bad = [];
  for (const [k, label, type, req] of defs) {
    const input = root.querySelector(`input[data-input="exv"][data-doc="${id}"][data-k="${k}"]`);
    const raw = input ? input.value : drafts[id]?.[k] ?? fmtVal(type, k === "years" ? yrs?.v : ex[k]?.value);
    const v = parseVal(type, raw);
    if (v === undefined) bad.push(`${label}: "${raw}" is not a ${type === "date" ? "date (YYYY-MM-DD)" : "number"}`);
    else if (v == null && req) bad.push(`${label} is needed`);
    else if (v != null) values[k] = v;
  }
  const pid = +docProp[id] || null;
  if (!pid) bad.push("Pick the property");
  if (bad.length) return toast(bad[0], "bad");
  let unit_id = null;
  if (doc.kind === "lease") {
    const u = docUnit[id] ?? "new";
    if (u !== "new") unit_id = +u;
    else if (values.unit && !/^(unit|apt|apartment|suite|house)\b/i.test(values.unit)) values.unit = `Unit ${values.unit}`;
    const occupied = units.find(x => x.id === unit_id && x.status === "occupied");
    if (occupied && !(await confirmModal("Unit already let", `${esc(occupied.name)} at ${esc(f.street(occupied.address))} has an active lease. Add this lease to it as well?`, "Add lease"))) return;
  }
  if (doc.kind === "mortgage") {
    let debts = [];
    try { debts = (await get("/api/debts")) || []; } catch (e) { debts = []; }
    const have = debts.filter(x => x.property_id === pid);
    if (have.length && !(await confirmModal("Property already has a loan", `${esc(f.street(have[0].address))} already has ${have.map(x => `${esc(x.lender || "a loan")} (balance ${f.usd(x.balance)})`).join(", ")} in Books. Add this statement as another loan? If it is the same loan, delete the old one on Books → Debt afterwards so interest is not counted twice.`, "Add as another loan"))) return;
  }
  const r = await post("/api/inbox", { act: "apply_doc", id, values, property_id: pid, unit_id });
  if (r.error) return toast(r.error, "bad");
  delete drafts[id];
  toast(doc.kind === "lease" ? `Lease added: ${values.tenant}, ${f.usd(values.rent, 0)}/mo from ${f.dateY(values.start)}` : `Loan added: ${values.lender || "lender"}, balance ${f.usd(values.principal, 0)} at ${f.pct(values.rate, 3)}`);
}

/* ---------- page ---------- */

async function chooseFiles() {
  const files = await pickFiles(".csv,.tsv,.txt,.pdf");
  if (!files.length) return;
  toast(`Reading ${files.length} file${files.length > 1 ? "s" : ""}…`);
  const res = await upload(files);
  const bad = res.filter(r => r.error), dup = res.filter(r => r.dup);
  const rows = res.reduce((a, r) => a + (r.extract?.new || 0), 0), fields = res.reduce((a, r) => a + (r.extract?.fields || 0), 0);
  toast(bad.length ? `${bad[0].name}: ${bad[0].error}` : dup.length === res.length ? "Already imported (same file)"
    : `${res.length - dup.length} file${res.length - dup.length > 1 ? "s" : ""} read: ${rows} bank row${rows === 1 ? "" : "s"}, ${fields} field${fields === 1 ? "" : "s"} to check`, bad.length ? "bad" : "");
}

const dropZone = big => `<div class="dz ib-dz${big ? " lg" : ""}" data-act="pick"><span class="k">↓</span><div><b>Drop files anywhere in the window, or click to choose</b>`
  + `<span>Bank exports (CSV from any bank), leases and mortgage statements (PDF). Nothing is written to your books until you accept it here.</span></div></div>`;

const WHAT = `<div class="ib-what">
  <div><b>Bank CSV</b>Columns are detected (date, description, amount or debit / credit). Deposits that match a tenant's name or rent become proposed rent payments; withdrawals get a Schedule E category from the payee.</div>
  <div><b>Lease PDF</b>Tenant, unit, start and end, rent, deposit, due day, late fee and grace days, each shown with the line it was read from. Apply adds the tenant and the lease.</div>
  <div><b>Mortgage statement</b>Lender, principal balance, rate, P&amp;I, escrow and statement date. Apply adds the loan to Books, so interest and the amortisation schedule follow.</div></div>`;

export default {
  id: "inbox",
  deps: [],
  async render(root, ctx) {
    useCss("office");
    if (!root.firstChild) root.innerHTML = loading("Reading the inbox");
    let d, units;
    try { [d, units] = await Promise.all([get("/api/inbox"), get("/api/units").catch(() => [])]); }
    catch (e) { root.innerHTML = empty("The inbox did not load", esc(e.message)); return; }
    last = d;
    const docs = d.docs || [], txns = d.txns || [];
    const open = txns.filter(t => !t.matched?.done);
    const eligible = open.filter(t => (t.matched?.confidence ?? 0) >= 0.6 && ready(t.matched || {}));
    if (selTxn != null && !txns.some(t => t.id === selTxn)) selTxn = null;
    if (curDoc != null && !docs.some(x => x.id === curDoc)) { curDoc = null; curLine = null; }

    ctx.sub.innerHTML = chips("txv", [{ v: "todo", label: "To review", sub: open.length }, { v: "done", label: "Decided", sub: txns.length - open.length }, { v: "all", label: "All rows", sub: txns.length }], txView, { label: "Bank rows" });
    ctx.bar.innerHTML = btn("accept-all", `Accept all ≥ 60%${eligible.length ? ` (${eligible.length})` : ""}`, { cls: eligible.length ? "pri" : "", dis: !eligible.length, title: "Record every undecided row whose proposal has a lease or property and at least 60% confidence" })
      + btn("csv", "CSV", { title: "Export the bank rows with their proposals" });

    const handlers = {
      "act:pick": chooseFiles,
      "chip:txv": v => { txView = v; this.render(root, ctx); },
      "act:accept-all": async () => {
        const r = await post("/api/inbox", { act: "accept_all", min: 0.6 });
        toast(r.error || `${r.accepted} row${r.accepted === 1 ? "" : "s"} recorded`, r.error ? "bad" : "");
      },
      "act:csv": () => csv("valora-bank-rows.csv", [
        { k: "date" }, { k: "account" }, { k: "description" }, { k: "amount" },
        { k: "proposal", val: r => r.matched?.kind }, { k: "category", val: r => r.matched?.category },
        { k: "lease_id", val: r => r.matched?.lease_id }, { k: "property_id", val: r => r.matched?.property_id },
        { k: "confidence", val: r => r.matched?.confidence }, { k: "reason", val: r => r.matched?.why },
        { k: "decided", val: r => (r.matched?.done ? "yes" : "no") }, { k: "file", val: r => docs.find(x => x.id === r.document_id)?.name }, { k: "line" },
      ], txns),
    };
    bind(ctx.sub, handlers);
    bind(ctx.bar, handlers);

    if (!docs.length) {
      root.dataset.mode = "empty";
      root.innerHTML = panel({ title: "Inbox", sub: "files in, proposals out", flush: true, body: dropZone(true) + WHAT })
        + `<div class="note">Export a statement from your bank's website (Activity → Download → CSV), or save a lease or a loan statement as PDF, then drop it here. Scanned PDFs work too: InvestStack asks for the handful of fields it cannot read.</div>`;
      bind(root, { "act:pick": chooseFiles });
      return;
    }

    if (root.dataset.mode !== "full") {
      root.dataset.mode = "full";
      root.innerHTML = `<section class="pnl" id="ib-top"></section>
        <div class="cols2 w32"><div class="stack">${panel({ title: "Documents", id: "ib-docs-p", flush: true, body: dropZone(false) + `<div id="ib-docs"></div>` })}</div><div id="ib-view"></div></div>
        <section class="pnl" id="ib-bank"><div class="ph"><h3>Bank rows</h3><span class="s" id="ib-bank-s"></span></div><div id="ib-txns"></div><div id="ib-dec"></div></section>
        <div id="ib-rev" class="cols2"></div>`;
    }

    // headline figures
    const dep = open.filter(t => t.amount > 0 && t.matched?.kind === "payment"), wd = open.filter(t => t.amount < 0 && t.matched?.kind === "expense");
    const pending = docs.filter(x => ["lease", "mortgage"].includes(x.kind) && ["read", "no_text", "new"].includes(x.status));
    const scans = docs.filter(x => x.status === "no_text");
    root.querySelector("#ib-top").innerHTML = kv([
      { k: "Documents", v: f.int(docs.length), sub: [pending.length ? `${pending.length} to apply` : "", scans.length ? `${scans.length} scanned` : "", docs.some(x => x.status === "applied") ? `${docs.filter(x => x.status === "applied").length} applied` : ""].filter(Boolean).join(" · ") || "all filed", cls: pending.length ? "amb" : "" },
      { k: "To review", v: f.int(open.length), sub: `of ${f.int(txns.length)}` },
      { k: "Ready ≥ 60%", v: f.int(eligible.length), cls: eligible.length ? "up" : "" },
      { k: "Rent matched", v: f.usd(dep.reduce((a, t) => a + t.amount, 0)), sub: `${dep.length} deposits` },
      { k: "Expenses", v: f.usd(wd.reduce((a, t) => a - t.amount, 0)), sub: `${wd.length} rows` },
    ], { cls: "tight" });

    // documents
    const nTx = new Map();
    for (const t of txns) { const o = nTx.get(t.document_id) || [0, 0]; o[0]++; if (!t.matched?.done) o[1]++; nTx.set(t.document_id, o); }
    const props = new Map((d.properties || []).map(p => [p.id, p]));
    const statusPill = r => {
      if (r.status === "applied") return pill("Applied", "up");
      if (r.status === "no_text") return pill("No text layer", "amb");
      if (r.kind === "bank_csv") { const o = nTx.get(r.id) || [0, 0]; return o[1] ? pill(`${o[1]} to review`, "amb") : o[0] ? pill("Decided", "up") : pill("No new rows"); }
      if (["lease", "mortgage"].includes(r.kind)) return pill("Check fields", "amb");
      return pill(r.status === "new" ? "New" : "Filed");
    };
    if (curDoc == null) curDoc = (pending[0] || docs.find(x => x.kind === "bank_csv") || docs[0])?.id ?? null;
    table(root.querySelector("#ib-docs"), {
      id: "ib-docs", key: r => r.id, sel: curDoc, maxH: 300, nav: false, sort: { k: "imported", dir: -1 },
      rows: docs.map(x => ({ ...x, prop: props.get(x.property_id)?.address || null })),
      cols: [
        { k: "name", label: "File", l: true, cls: "trunc", fmt: (v, r) => `<span title="${esc(v)}${r.prop ? " · " + esc(r.prop) : ""} · imported ${esc(r.imported || "")}">${esc(short(v, 24))}</span>` },
        { k: "kind", label: "Kind", l: true, sort: false, fmt: (v, r) => selectBox("kind", KINDS, v).replace("<select", `<select data-id="${r.id}" title="Change the kind and read the file again"`) },
        { k: "status", label: "Status", l: true, val: r => r.status, fmt: (v, r) => statusPill(r) },
        { k: "pages", label: "Size", title: "Bank rows read, or PDF pages", fmt: (v, r) => (r.kind === "bank_csv" ? `${f.int(v)} rows` : f.ok(v) ? `${f.int(v)} pp` : f.DASH) },
      ],
      onRow: r => { curDoc = r.id; curLine = null; root.querySelector("#ib-docs").__tbl.handle.setSel(r.id); drawViewer(root, d); },
      empty: "No documents",
    });
    drawViewer(root, d);

    // bank rows
    const bank = root.querySelector("#ib-bank");
    bank.hidden = !txns.length;
    if (txns.length) {
      root.querySelector("#ib-bank-s").textContent = `${open.length} to review · each proposal shows why and how sure · Enter accepts, X ignores`;
      const rows = txnRows(d);
      table(root.querySelector("#ib-txns"), {
        id: "ib-txns", key: r => r.id, sel: selTxn, maxH: 420, sort: { k: "date", dir: -1 },
        rows, rowCls: r => (r.done ? "dim" : ""),
        cols: [
          { k: "date", label: "Date", l: true, fmt: v => f.dateY(v) },
          { k: "description", label: "Description", l: true, cls: "trunc", fmt: v => `<span title="${esc(v)}">${esc(v)}</span>` },
          { k: "amount", label: "Amount", fmt: v => f.susd(v, 2), cls: v => f.cls(v) },
          { k: "kind", label: "Proposed match · reason", l: true, cls: "prop2", val: r => r.kind, fmt: (v, r) => `<div title="${esc(r.why)}">${proposalHtml(r, d)}</div><small title="${esc(r.why)}">${esc(r.why) || "no rule matched"}</small>` },
          { k: "conf", label: "Conf", title: "How sure the match is: full name + rent amount 95%, name only 80%, amount only 55%; ties are capped at 40%", fmt: v => confHtml(v) },
          { k: "line", label: "Src", title: "Line of the bank file; click to see it", l: true, cls: "srcl", fmt: (v, r) => `<a data-act="tx-src" data-doc="${r.document_id}" data-line="${r.line}" title="${esc(v)}, line ${r.line}: show it in the viewer">L${r.line}</a>` },
          { k: "act", label: "", sort: false, fmt: (v, r) => (r.done ? "" : btn("row-accept", "Accept", { attrs: `data-id="${r.id}"`, dis: !ready(effective(r)), title: ready(effective(r)) ? "Record it as proposed" : "Select the row and pick a lease or property" }) + btn("row-ignore", "×", { cls: "ghost", attrs: `data-id="${r.id}"`, title: "Ignore (X)" })) },
        ],
        onRow: r => { selTxn = r.id; select({ kind: "txn", id: r.id, row: r }); root.querySelector("#ib-txns").__tbl.handle.setSel(r.id); root.querySelector("#ib-dec").innerHTML = decisionStrip(d); },
        empty: txView === "todo" ? "Every bank row is decided. Drop next month's export when it is ready." : "No rows",
      });
      root.querySelector("#ib-dec").innerHTML = decisionStrip(d);
    }

    // lease / mortgage review and scanned fallback
    const rev = root.querySelector("#ib-rev");
    const parts = [];
    for (const doc of docs.filter(x => x.status !== "applied")) {
      if (["lease", "mortgage"].includes(doc.kind)) parts.push(await reviewPanel(doc, d, units));
      else if (doc.status === "no_text") parts.push(kindPicker(doc));
    }
    rev.innerHTML = parts.join("");
    rev.hidden = !parts.length;

    const redrawDec = () => { root.querySelector("#ib-dec").innerHTML = decisionStrip(d); table(root.querySelector("#ib-txns"), { ...root.querySelector("#ib-txns").__tbl.cfg, rows: txnRows(d) }); };
    const setOvr = (patch) => { const t = txns.find(x => x.id === selTxn); if (!t) return; ovr[selTxn] = { ...effective(t), ...patch }; delete ovr[selTxn].done; redrawDec(); };
    bind(root, {
      "act:pick": chooseFiles,
      "act:tx-src": el => showSource(root, d, el.dataset.doc, 1, el.dataset.line),
      "act:ex-src": el => showSource(root, d, el.dataset.doc, el.dataset.page, el.dataset.line),
      "act:ex-view": el => showSource(root, d, el.dataset.doc, null, null),
      "act:row-accept": el => acceptTxn(+el.dataset.id),
      "act:row-ignore": el => acceptTxn(+el.dataset.id, "ignore"),
      "act:tx-accept": () => selTxn != null && acceptTxn(selTxn),
      "act:tx-ignore": () => selTxn != null && acceptTxn(selTxn, "ignore"),
      "act:tx-next": () => root.querySelector("#ib-txns")?.__tbl?.handle.move(1),
      "chip:txkind": v => setOvr({ kind: v }),
      "change:txlease": v => setOvr({ lease_id: v ? +v : null }),
      "change:txprop": v => setOvr({ property_id: v ? +v : null }),
      "change:txcat": v => setOvr({ category: v }),
      "change:kind": async (v, el) => {
        const r = await post("/api/inbox", { act: "kind", id: +el.dataset.id, kind: v });
        toast(r.error || `Read again as ${KIND_LABEL[v]}`, r.error ? "bad" : "");
      },
      "act:doc-reread": async el => {
        const r = await post("/api/inbox", { act: "extract", id: +el.dataset.id });
        toast(r.error || (r.no_text ? "No text layer in this file" : r.rows != null ? `${r.new} new row${r.new === 1 ? "" : "s"}, ${r.dup} already imported` : `${r.fields} field${r.fields === 1 ? "" : "s"} found`), r.error ? "bad" : "");
      },
      "act:doc-del": async el => {
        const doc = docs.find(x => x.id === +el.dataset.id);
        if (!(await confirmModal("Remove file", `Remove <b>${esc(doc?.name)}</b> from the inbox? Undecided bank rows from it are dropped; anything already recorded stays in the books.`, "Remove"))) return;
        const r = await post("/api/inbox", { act: "delete_doc", id: +el.dataset.id });
        toast(r.error || "Removed", r.error ? "bad" : "");
      },
      "act:ex-kind": async el => {
        const r = await post("/api/inbox", { act: "kind", id: +el.dataset.doc, kind: el.dataset.kind });
        if (r.error) toast(r.error, "bad");
      },
      "input:exv": (v, el) => { (drafts[el.dataset.doc] ||= {})[el.dataset.k] = v; el.classList.add("edited"); el.classList.remove("got"); },
      "change:exprop": (v, el) => { docProp[el.dataset.doc] = v ? +v : ""; delete docUnit[el.dataset.doc]; this.render(root, ctx); },
      "change:exunit": (v, el) => { docUnit[el.dataset.doc] = v === "new" ? "new" : +v; },
      "act:ex-apply": el => applyDoc(root, d, units, +el.dataset.doc),
    });
  },
  key(e) {
    if (selTxn == null || !last) return false;
    if (e.key === "Enter") { acceptTxn(selTxn); return true; }
    if (e.key === "x" || e.key === "X") { acceptTxn(selTxn, "ignore"); return true; }
    return false;
  },
};
