// Books — the owner's operating records: expenses by Schedule E line, the loans on each property with their
// amortisation, and maintenance tickets. Bank rows accepted on the Inbox land here with their source line.
import { S, f, get, post, select, esc, today } from "../core.js";
import { table, panel, kv, chips, btn, bind, toast, formModal, csv, src, pill, selectBox, useCss, empty, loading } from "../ui.js";
import * as C from "../charts.js";

let tab = "expenses";
let fProp = "", fYear = "", fCat = "", fStatus = "active";
let selLoan = null, selExp = null, selMaint = null;

const yr = d => String(d || "").slice(0, 4);
const thisYear = () => +today().slice(0, 4);
const short = (s, n = 34) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const sum = (a, k) => a.reduce((s, r) => s + (f.ok(k ? r[k] : r) ? +(k ? r[k] : r) : 0), 0);

/* ---------- amortisation (monthly), same convention as the engine: level payment, or interest-only ---------- */
export function amort(d) {
  const P = +d.principal || 0, r = (+d.rate || 0) / 12, n = Math.round((+d.years || 0) * 12), io = !!d.io;
  const pmt = f.ok(d.payment) && d.payment > 0 ? +d.payment : io ? P * r : r ? (P * r) / (1 - Math.pow(1 + r, -n)) : n ? P / n : 0;
  const st = String(d.start || today()).slice(0, 7).split("-").map(Number);
  const out = [];
  let bal = P;
  for (let k = 1; k <= n && bal > 0.005; k++) {
    const int = bal * r, prin = io ? (k === n ? bal : 0) : Math.min(bal, pmt - int);
    bal = Math.max(0, bal - prin);
    const m0 = st[1] - 1 + k, y = st[0] + Math.floor(m0 / 12), m = (m0 % 12) + 1;
    out.push({ k, ym: `${y}-${String(m).padStart(2, "0")}`, int, prin, bal });
  }
  return { pmt, months: out };
}
function byCalYear(months) {
  const m = new Map();
  for (const x of months) {
    const y = +x.ym.slice(0, 4), o = m.get(y) || { year: y, interest: 0, principal: 0, balance: 0, n: 0 };
    o.interest += x.int; o.principal += x.prin; o.balance = x.bal; o.n++;
    m.set(y, o);
  }
  return [...m.values()];
}

/* ---------- dialogs ---------- */
const propOpts = props => props.map(p => ({ v: p.id, label: f.street(p.address) }));

async function editExpense(row, props, cats) {
  if (!props.length) return toast("Add an owned property first (Portfolio → Add)", "bad");
  const v = await formModal(row ? "Edit expense" : "Add an expense", [
    { k: "property_id", label: "Property", type: "select", value: row?.property_id ?? (fProp || props[0].id), options: propOpts(props), full: true },
    { k: "date", label: "Date", type: "date", value: row?.date || today(), req: true },
    { k: "amount", label: "Amount ($)", type: "number", value: row?.amount ?? "", req: true },
    { k: "category", label: "Schedule E line", type: "select", value: row?.category || "Repairs", options: cats.filter(c => !["Depreciation", "Mortgage interest"].includes(c)) },
    { k: "vendor", label: "Vendor / payee", value: row?.vendor || "" },
    { k: "memo", label: "Memo", value: row?.memo || "", full: true },
  ], {
    ok: row ? "Save" : "Add expense", danger: row ? "Delete" : null,
    note: row ? (row.bank_txn_id ? "Recorded from a bank file on the Inbox. Editing here changes the books, not the bank row." : "") : "Faster from files: drop the bank export on <b>Inbox</b> and accept the proposed categories. Mortgage interest comes from the loan schedule and depreciation from the purchase price, so neither is entered here.",
  });
  if (!v) return;
  if (v.__danger) {
    const r = await post("/api/portfolio", { act: "delete", table: "expense", id: row.id });
    return toast(r.error || "Expense deleted", r.error ? "bad" : "");
  }
  if (!f.ok(v.amount) || v.amount <= 0) return toast("Amount must be a positive number", "bad");
  const data = { property_id: +v.property_id, date: v.date, amount: v.amount, category: v.category, vendor: v.vendor || null, memo: v.memo || null };
  const r = await post("/api/portfolio", row ? { act: "edit", table: "expense", id: row.id, data } : { act: "add", table: "expense", data });
  toast(r.error || (row ? "Expense saved" : `Expense of ${f.usd(v.amount, 2)} added`), r.error ? "bad" : "");
}

async function editLoan(row, props) {
  if (!props.length) return toast("Add an owned property first (Portfolio → Add)", "bad");
  const v = await formModal(row ? "Edit loan" : "Add a loan", [
    { k: "property_id", label: "Property", type: "select", value: row?.property_id ?? (fProp || props[0].id), options: propOpts(props), full: true },
    { k: "lender", label: "Lender", value: row?.lender || "" },
    { k: "principal", label: "Original principal ($)", type: "number", value: row?.principal ?? "", req: true },
    { k: "rate", label: "Rate (%)", type: "number", value: f.ok(row?.rate) ? +(row.rate * 100).toFixed(4) : "", req: true },
    { k: "years", label: "Term (years)", type: "number", value: row?.years ?? 30 },
    { k: "start", label: "Loan start (1st payment next month)", type: "date", value: row?.start || today() },
    { k: "payment", label: "P&I / month (blank = computed)", type: "number", value: f.ok(row?.payment) ? +(+row.payment).toFixed(2) : "" },
    { k: "escrow", label: "Escrow / month", type: "number", value: row?.escrow ?? 0 },
    { k: "io", label: "Interest only", type: "select", value: row?.io ? "1" : "0", options: [{ v: "0", label: "No, amortising" }, { v: "1", label: "Yes" }] },
  ], {
    ok: row ? "Save" : "Add loan", danger: row ? "Delete" : null,
    note: row ? "" : "Faster from files: drop a mortgage statement PDF on <b>Inbox</b>; it reads the lender, balance, rate, P&amp;I and escrow with the line each came from. For a loan taken over mid-term, enter the current balance as principal, the statement month as start and the remaining term.",
  });
  if (!v) return;
  if (v.__danger) {
    const r = await post("/api/portfolio", { act: "delete", table: "debt", id: row.id });
    if (!r.error) selLoan = null;
    return toast(r.error || "Loan deleted", r.error ? "bad" : "");
  }
  if (!f.ok(v.principal) || v.principal <= 0) return toast("Principal must be a positive number", "bad");
  if (!f.ok(v.rate) || v.rate < 0 || v.rate > 30) return toast("Rate is a percentage, e.g. 6.125", "bad");
  const data = {
    property_id: +v.property_id, lender: v.lender || null, principal: v.principal, rate: v.rate / 100, years: v.years || 30,
    start: v.start || today(), payment: f.ok(v.payment) && v.payment > 0 ? v.payment : null, escrow: v.escrow || 0, io: v.io === "1" ? 1 : 0,
  };
  const r = await post("/api/portfolio", row ? { act: "edit", table: "debt", id: row.id, data } : { act: "add", table: "debt", data });
  if (!r.error && r.id != null) selLoan = r.id;
  toast(r.error || (row ? "Loan saved" : "Loan added"), r.error ? "bad" : "");
}

async function editMaint(row, props, units) {
  if (!props.length) return toast("Add an owned property first (Portfolio → Add)", "bad");
  const uo = [{ v: "", label: "Whole property" }, ...units.map(u => ({ v: u.id, label: `${f.street(u.address)} · ${u.name}` }))];
  const v = await formModal(row ? "Edit ticket" : "New maintenance ticket", [
    { k: "title", label: "What needs doing", value: row?.title || "", full: true, req: true },
    { k: "property_id", label: "Property", type: "select", value: row?.property_id ?? (fProp || props[0].id), options: propOpts(props) },
    { k: "unit_id", label: "Unit", type: "select", value: row?.unit_id ?? "", options: uo },
    { k: "priority", label: "Priority", type: "select", value: row?.priority || "normal", options: ["urgent", "high", "normal", "low"] },
    { k: "status", label: "Status", type: "select", value: row?.status || "open", options: ["open", "scheduled", "closed"] },
    { k: "vendor", label: "Vendor", value: row?.vendor || "" },
    { k: "cost", label: "Cost ($)", type: "number", value: row?.cost ?? "" },
    { k: "opened", label: "Opened", type: "date", value: row?.opened || today() },
    { k: "closed", label: "Closed", type: "date", value: row?.closed || "" },
  ], { ok: row ? "Save" : "Open ticket", danger: row ? "Delete" : null });
  if (!v) return;
  if (v.__danger) {
    const r = await post("/api/portfolio", { act: "delete", table: "maint", id: row.id });
    return toast(r.error || "Ticket deleted", r.error ? "bad" : "");
  }
  const unit = units.find(u => u.id === +v.unit_id);
  const data = {
    title: v.title, property_id: unit ? unit.property_id : +v.property_id, unit_id: unit ? unit.id : null, priority: v.priority,
    status: v.status, vendor: v.vendor || null, cost: v.cost, opened: v.opened || today(),
    closed: v.status === "closed" ? v.closed || today() : null,
  };
  if (!data.title) return toast("Say what needs doing", "bad");
  const r = await post("/api/portfolio", row ? { act: "edit", table: "maint", id: row.id, data } : { act: "add", table: "maint", data });
  toast(r.error || (row ? "Ticket saved" : "Ticket opened"), r.error ? "bad" : "");
}

async function closeMaint(row) {
  const v = await formModal(`Close: ${row.title}`, [
    { k: "cost", label: "Final cost ($)", type: "number", value: row.cost ?? "" },
    { k: "closed", label: "Closed on", type: "date", value: today() },
    { k: "book", label: "Also record as an expense", type: "select", value: f.ok(row.cost) && row.cost > 0 ? "Repairs" : "", options: [{ v: "", label: "No" }, { v: "Repairs", label: "Yes, Repairs" }, { v: "Cleaning and maintenance", label: "Yes, Cleaning and maintenance" }] },
  ], { ok: "Close ticket", note: "Record the cost as an expense here only if it will not come in through a bank file, or it is counted twice." });
  if (!v) return;
  const r = await post("/api/portfolio", { act: "edit", table: "maint", id: row.id, data: { status: "closed", closed: v.closed || today(), cost: v.cost } }, { quiet: !!v.book });
  if (r.error) return toast(r.error, "bad");
  if (v.book && f.ok(v.cost) && v.cost > 0) {
    const e = await post("/api/portfolio", { act: "add", table: "expense", data: { property_id: row.property_id, date: v.closed || today(), amount: v.cost, category: v.book, vendor: row.vendor || null, memo: `Maintenance: ${row.title}` } });
    if (e.error) return toast(e.error, "bad");
  }
  toast(v.book ? "Closed and recorded as an expense" : "Ticket closed");
}

/* ---------- tabs ---------- */

function expensesTab(root, ctx, d) {
  const { exp, cats, props, inbox } = d;
  const years = [...new Set([String(thisYear()), ...exp.rows.map(r => yr(r.date))])].filter(Boolean).sort().reverse();
  if (!fYear || !years.includes(fYear)) fYear = years[0];
  const docs = new Map((inbox?.docs || []).map(x => [x.id, x])), txns = new Map((inbox?.txns || []).map(t => [t.id, t]));
  const all = exp.rows.filter(r => (!fProp || r.property_id === +fProp) && (fYear === "all" || yr(r.date) === fYear));
  const rows = all.filter(r => !fCat || r.category === fCat).map(r => ({ ...r, key: r.id }));

  ctx.sub.innerHTML = tabsHtml()
    + selectBox("bk-prop", [{ v: "", label: "All properties" }, ...propOpts(props)], fProp)
    + selectBox("bk-year", [...years.map(y => ({ v: y, label: y })), { v: "all", label: "All years" }], fYear);
  ctx.bar.innerHTML = btn("exp-add", "+ Expense", { cls: "pri" }) + btn("exp-csv", "CSV");

  const tot = sum(rows, "amount"), byCat = new Map();
  for (const r of all) byCat.set(r.category || "Other", (byCat.get(r.category || "Other") || 0) + r.amount);
  const catRows = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const fromBank = rows.filter(r => r.bank_txn_id).length;
  const months = fYear === "all" ? null : Array.from({ length: 12 }, (_, i) => `${fYear}-${String(i + 1).padStart(2, "0")}`);
  const nMonths = fYear === "all" ? null : fYear === String(thisYear()) ? +today().slice(5, 7) : 12;

  if (!exp.rows.length) {
    ctx.sub.innerHTML = tabsHtml();
    root.innerHTML = panel({
      title: "Expenses", body: empty("No expenses recorded",
        props.length ? "Drop a bank export on <a class=\"link\" data-go=\"inbox\">Inbox</a> and accept the proposed Schedule E categories, or add one with + Expense."
          : "Add an owned property on <a class=\"link\" data-go=\"portfolio\">Portfolio</a> first, then drop a bank export on <a class=\"link\" data-go=\"inbox\">Inbox</a>."),
    });
    return;
  }
  root.innerHTML = `<section class="pnl">${kv([
    { k: fCat ? `${short(fCat, 18)} ${fYear === "all" ? "" : fYear}` : `Expenses ${fYear === "all" ? "all years" : fYear}`, v: f.usd(tot, 0), sub: `${f.int(rows.length)} entries` },
    nMonths ? { k: "Per month", v: f.usd(tot / nMonths, 0), sub: `${nMonths} month${nMonths === 1 ? "" : "s"}` } : null,
    { k: "Largest line", v: catRows[0] ? esc(short(catRows[0][0], 16)) : f.DASH, sub: catRows[0] ? f.usd(catRows[0][1]) : "" },
    { k: "From bank files", v: f.int(fromBank), sub: `${f.int(rows.length - fromBank)} ${S.state?.demo ? "demo entries" : "entered by hand"}` },
  ], { cls: "tight" })}</section>
    <div class="cols2">${panel({ title: "By Schedule E line", sub: `${fYear === "all" ? "all years" : fYear} · click a bar to filter`, body: `<div id="bk-cat-ch"></div>` })}
    ${months ? panel({ title: "By month", sub: `${fYear} · stacked by line`, body: `<div id="bk-mo-ch"></div>` }) : ""}</div>
    <section class="pnl"><div class="ph"><h3>Entries</h3><span class="s">double-click to edit · mortgage interest and depreciation are computed on Reports</span><div class="r">${selectBox("bk-cat", [{ v: "", label: "All Schedule E lines" }, ...cats.filter(c => !["Depreciation", "Mortgage interest"].includes(c)).map(c => ({ v: c, label: c }))], fCat)}</div></div><div id="bk-exp"></div></section>`;

  table(root.querySelector("#bk-exp"), {
    id: "bk-exp", rows, key: r => r.id, sel: selExp, sort: { k: "date", dir: -1 }, maxH: 520,
    empty: "No expenses match the filters",
    cols: [
      { k: "date", label: "Date", l: true, fmt: v => f.dateY(v) },
      { k: "address", label: "Property", l: true, fmt: (v, r) => `<a class="sym" data-prop="${r.property_id}" data-go="property" title="${esc(v)}">${esc(f.street(v))}</a>` },
      { k: "category", label: "Line", l: true },
      { k: "vendor", label: "Vendor", l: true, cls: "trunc", fmt: v => (v ? `<span title="${esc(v)}">${esc(short(v, 28))}</span>` : f.DASH) },
      { k: "memo", label: "Memo", l: true, cls: "trunc", fmt: v => (v ? `<span class="mut" title="${esc(v)}">${esc(short(v, 34))}</span>` : "") },
      { k: "amount", label: "Amount", fmt: v => f.usd(v, 2) },
      { k: "src", label: "Source", l: true, val: r => (r.bank_txn_id ? "bank" : "hand"), fmt: (v, r) => {
        if (!r.bank_txn_id) return r.memo && /^Maintenance:/.test(r.memo) ? src("maintenance ticket", "m") : S.state?.demo ? src("demo data", "x") : src("entered", "m");
        const t = txns.get(r.bank_txn_id), doc = docs.get(t?.document_id ?? r.document_id);
        return src(doc ? `${short(doc.name, 22)} L${t?.line ?? "?"}` : "bank file", "v");
      } },
    ],
    onRow: r => { selExp = r.id; root.querySelector("#bk-exp").__tbl.handle.setSel(r.id); },
    onDbl: r => editExpense(r, props, cats),
  });
  if (catRows.length) C.bars(root.querySelector("#bk-cat-ch"), {
    horizontal: true, cats: catRows.map(c => c[0]), series: [{ name: "Amount", vals: catRows.map(c => c[1]), color: "acc" }],
    y: { fmt: v => f.cusd(v) }, onClick: c => { fCat = fCat === c ? "" : c; ctx.rerender(); },
  });
  else root.querySelector("#bk-cat-ch").innerHTML = `<div class="note">No expenses in this period.</div>`;
  if (months) {
    const top = catRows.slice(0, 5).map(c => c[0]), colors = ["acc", "amber", "violet", "cyan", "up"];
    const ser = top.map((c, i) => ({ name: c, color: colors[i], vals: months.map(m => sum(all.filter(r => r.category === c && r.date.startsWith(m)), "amount") || null) }));
    if (catRows.length > 5) ser.push({ name: "Other lines", color: "mut", vals: months.map(m => sum(all.filter(r => !top.includes(r.category) && r.date.startsWith(m)), "amount") || null) });
    C.bars(root.querySelector("#bk-mo-ch"), { h: 200, stacked: true, legend: true, cats: months.map(m => f.mo(m)), series: ser, y: { fmt: v => f.cusd(v) } });
  }
  ctx.csv = () => csv(`valora-expenses-${fYear}.csv`, [{ k: "date" }, { k: "address" }, { k: "category" }, { k: "vendor" }, { k: "memo" }, { k: "amount" }, { k: "source", val: r => (r.bank_txn_id ? "bank file" : "entered") }], rows);
}

function debtTab(root, ctx, d) {
  const { debts, props } = d;
  const loans = debts.filter(x => !fProp || x.property_id === +fProp).map(x => {
    const a = amort(x), cy = byCalYear(a.months), y = thisYear();
    const last = a.months[a.months.length - 1];
    return { ...x, key: x.id, am: a, cy, int_y: cy.find(c => c.year === y)?.interest ?? 0, prin_y: cy.find(c => c.year === y)?.principal ?? 0, payoff: last ? last.ym : null, total: (x.payment || 0) + (x.escrow || 0) };
  });
  if (selLoan == null || !loans.some(l => l.id === selLoan)) selLoan = loans[0]?.id ?? null;
  ctx.sub.innerHTML = tabsHtml() + selectBox("bk-prop", [{ v: "", label: "All properties" }, ...propOpts(props)], fProp);
  ctx.bar.innerHTML = btn("loan-add", "+ Loan", { cls: "pri" }) + btn("loan-csv", "CSV");
  if (!loans.length) {
    if (!debts.length) ctx.sub.innerHTML = tabsHtml();
    root.innerHTML = panel({ title: "Debt", body: empty("No loans recorded", props.length ? "Drop a mortgage statement PDF on <a class=\"link\" data-go=\"inbox\">Inbox</a> (it reads balance, rate, P&amp;I and escrow), or add one with + Loan." : "Add an owned property on <a class=\"link\" data-go=\"portfolio\">Portfolio</a> first.") });
    return;
  }
  const bal = sum(loans, "balance"), orig = sum(loans, "principal");
  const wrate = bal ? loans.reduce((s, l) => s + (l.rate || 0) * (l.balance || 0), 0) / bal : null;
  root.innerHTML = `<section class="pnl">${kv([
    { k: "Balance today", v: f.usd(bal), sub: `of ${f.usd(orig)} original` },
    { k: "Wtd. rate", v: f.pct(wrate, 3), sub: "by balance" },
    { k: "P&I / month", v: f.usd(sum(loans, "payment"), 0), sub: `${f.usd(sum(loans, "pi_year"))} / yr · escrow ${f.usd(sum(loans, "escrow"), 0)} / mo` },
    { k: `Interest ${thisYear()}`, v: f.usd(sum(loans, "int_y")), sub: "calendar year, from schedule" },
    { k: `Principal ${thisYear()}`, v: f.usd(sum(loans, "prin_y")), cls: "up" },
  ], { cls: "tight" })}</section>
    <section class="pnl"><div class="ph"><h3>Loans</h3><span class="s">balance from the amortisation schedule as of ${f.dateY(today())} · double-click to edit</span></div><div id="bk-loans"></div></section>
    <div class="cols2 w32"><div id="bk-loan-ch"></div><div id="bk-loan-sch"></div></div>`;
  table(root.querySelector("#bk-loans"), {
    id: "bk-loans", rows: loans, key: r => r.id, sel: selLoan, maxH: 300, sort: { k: "balance", dir: -1 },
    cols: [
      { k: "address", label: "Property", l: true, fmt: (v, r) => `<a class="sym" data-prop="${r.property_id}" data-go="property" title="${esc(v)}">${esc(f.street(v))}</a>` },
      { k: "lender", label: "Lender", l: true, title: "Green dot: read from a mortgage statement; blue: entered; grey: demo data", fmt: (v, r) => `<i class="src-dot ${r.extraction_id ? "v" : S.state?.demo ? "x" : "m"}"></i>${esc(v || f.DASH)}` },
      { k: "principal", label: "Original", fmt: v => f.usd(v) },
      { k: "rate", label: "Rate", fmt: v => f.pct(v, 3) },
      { k: "years", label: "Term", title: "Term and loan start month (first payment is the month after)", fmt: (v, r) => (f.ok(v) ? `${f.num(v, 0)} yr${r.io ? " IO" : ""} <span class="mut">${f.mo(r.start)}</span>` : f.DASH) },
      { k: "payment", label: "P&I", title: "Principal and interest per month", fmt: v => f.usd(v, 2) },
      { k: "escrow", label: "Escrow", hide: !loans.some(l => l.escrow), fmt: v => (v ? f.usd(v, 2) : f.DASH) },
      { k: "balance", label: "Balance", title: "After the payments made to date", fmt: (v, r) => `<b title="${f.int(r.months_paid)} of ${f.int(Math.round((r.years || 0) * 12))} payments made">${f.usd(v)}</b>` },
      { k: "int_y", label: `Int ${thisYear()}`, fmt: v => f.usd(v) },
      { k: "payoff", label: "Payoff", fmt: v => f.mo(v) },
    ],
    onRow: r => { selLoan = r.id; select({ kind: "debt", id: r.id, row: r }); drawLoan(root, loans); root.querySelector("#bk-loans").__tbl.handle.setSel(r.id); },
    onDbl: r => editLoan(r, props),
  });
  drawLoan(root, loans);
  ctx.csv = () => csv("valora-loans.csv", [{ k: "address" }, { k: "lender" }, { k: "principal" }, { k: "rate" }, { k: "years" }, { k: "start" }, { k: "payment" }, { k: "escrow" }, { k: "months_paid" }, { k: "balance" }, { k: "int_y", csv: `interest_${thisYear()}` }, { k: "payoff" }], loans);
}

function drawLoan(root, loans) {
  const L = loans.find(l => l.id === selLoan);
  const ch = root.querySelector("#bk-loan-ch"), sc = root.querySelector("#bk-loan-sch");
  if (!L) { ch.innerHTML = ""; sc.innerHTML = ""; return; }
  const cy = L.cy, now = today().slice(0, 7);
  ch.innerHTML = panel({ title: "Amortisation", sub: `${esc(f.street(L.address))} · ${esc(L.lender || "loan")} · ${f.usd(L.principal)} at ${f.pct(L.rate, 3)}`, body: `<div id="bk-am-bal"></div><div id="bk-am-ip"></div>` });
  C.line(ch.querySelector("#bk-am-bal"), {
    h: 170, legend: true, x: { type: "num", fmt: v => String(Math.round(v)) }, y: { fmt: v => f.cusd(v) },
    series: [{ name: "Balance (year end)", pts: cy.map(c => [c.year, c.balance]), color: "acc", width: 1.8 }],
    hmarks: [],
  });
  C.bars(ch.querySelector("#bk-am-ip"), {
    h: 160, stacked: true, legend: true, cats: cy.map(c => String(c.year)),
    series: [{ name: "Interest", vals: cy.map(c => c.interest), color: "amber" }, { name: "Principal", vals: cy.map(c => c.principal), color: "acc" }],
    y: { fmt: v => f.cusd(v) },
  });
  const rows = cy.map(c => ({ ...c, key: c.year }));
  sc.innerHTML = panel({ title: "Schedule by calendar year", sub: `payoff ${f.mo(L.payoff)} · ${f.usd(sum(cy, "interest"))} total interest`, flush: true, body: `<div id="bk-sch"></div>` });
  table(sc.querySelector("#bk-sch"), {
    id: "bk-sch", rows, key: r => r.key, sel: +now.slice(0, 4), maxH: 330, nav: false, sort: { k: "year", dir: 1 },
    cols: [
      { k: "year", label: "Year", l: true, fmt: (v, r) => `${v}${r.n < 12 ? ` <span class="faint">${r.n} mo</span>` : ""}` },
      { k: "interest", label: "Interest", fmt: v => f.usd(v) },
      { k: "principal", label: "Principal", fmt: v => f.usd(v) },
      { k: "balance", label: "Balance", fmt: v => f.usd(v) },
    ],
  });
}

function maintTab(root, ctx, d) {
  const { maint, props, units } = d;
  const all = maint.filter(m => !fProp || m.property_id === +fProp);
  const rows = all.filter(m => fStatus === "all" || (fStatus === "active" ? m.status !== "closed" : m.status === fStatus))
    .map(m => ({ ...m, key: m.id, age: m.status === "closed" && m.closed ? ageDays(m.opened, m.closed) : ageDays(m.opened, today()) }));
  const cnt = s => all.filter(m => m.status === s).length;
  ctx.sub.innerHTML = tabsHtml() + selectBox("bk-prop", [{ v: "", label: "All properties" }, ...propOpts(props)], fProp)
    + selectBox("bk-st", [{ v: "active", label: `Active (${cnt("open") + cnt("scheduled")})` }, { v: "closed", label: `Closed (${cnt("closed")})` }, { v: "all", label: `All (${all.length})` }], fStatus);
  ctx.bar.innerHTML = btn("mt-add", "+ Ticket", { cls: "pri" }) + btn("mt-csv", "CSV");
  if (!maint.length) {
    ctx.sub.innerHTML = tabsHtml();
    root.innerHTML = panel({ title: "Maintenance", body: empty("No maintenance tickets", props.length ? "Open one with + Ticket when a tenant reports something or a job is booked." : "Add an owned property on <a class=\"link\" data-go=\"portfolio\">Portfolio</a> first.") });
    return;
  }
  const y = String(thisYear()), closedY = all.filter(m => m.status === "closed" && yr(m.closed) === y);
  const openRows = all.filter(m => m.status !== "closed");
  root.innerHTML = `<section class="pnl">${kv([
    { k: "Open", v: f.int(cnt("open")), cls: cnt("open") ? "amb" : "", sub: `${f.int(cnt("scheduled"))} scheduled` },
    { k: "Urgent / high", v: f.int(openRows.filter(m => ["urgent", "high"].includes(m.priority)).length), cls: openRows.some(m => m.priority === "urgent") ? "down" : "" },
    { k: "Committed cost", v: f.usd(sum(openRows, "cost")), sub: "open + scheduled" },
    { k: `Closed ${y}`, v: f.int(closedY.length), sub: f.usd(sum(closedY, "cost")) },
    { k: "Oldest open", v: openRows.length ? f.days(Math.max(...openRows.map(m => ageDays(m.opened, today()) || 0))) : f.DASH },
  ], { cls: "tight" })}</section>
    <section class="pnl"><div class="ph"><h3>Tickets</h3><span class="s">double-click to edit</span></div><div id="bk-mt"></div></section>`;
  const PRI = { urgent: 0, high: 1, normal: 2, low: 3 };
  table(root.querySelector("#bk-mt"), {
    id: "bk-mt", rows, key: r => r.id, sel: selMaint, maxH: 600, sort: { k: "opened", dir: -1 },
    empty: fStatus === "active" ? "Nothing open. Closed tickets are under Closed." : "No tickets",
    rowCls: r => (r.status === "closed" ? "dim" : ""),
    cols: [
      { k: "opened", label: "Opened", l: true, fmt: v => f.dateY(v) },
      { k: "address", label: "Property · unit", l: true, fmt: (v, r) => `<a class="sym" data-prop="${r.property_id}" data-go="property" title="${esc(v)}">${esc(f.street(v))}</a>${r.unit ? ` <span class="mut">${esc(r.unit)}</span>` : ""}` },
      { k: "title", label: "Ticket", l: true, cls: "trunc", fmt: v => `<span title="${esc(v)}">${esc(short(v, 30))}</span>` },
      { k: "priority", label: "Priority · status", l: true, val: r => (r.status === "closed" ? 10 : 0) + (PRI[r.priority] ?? 9), fmt: (v, r) => `<span class="${r.priority === "urgent" ? "down" : r.priority === "high" ? "amb" : "mut"}" style="display:inline-block;width:52px">${esc(r.priority || "normal")}</span>${pill(r.status, r.status === "closed" ? "up" : r.status === "open" ? "amb" : "")}` },
      { k: "vendor", label: "Vendor", l: true, fmt: v => (v ? `<span title="${esc(v)}">${esc(short(v, 16))}</span>` : f.DASH) },
      { k: "cost", label: "Cost", fmt: v => f.usd(v, 0) },
      { k: "age", label: "Days", title: "Days open (or days it took, once closed)", fmt: (v, r) => `<span class="${r.status !== "closed" && v > 30 ? "down" : ""}">${f.int(v)}</span>` },
      { k: "closed", label: "Closed", hide: fStatus === "active", fmt: v => (v ? f.dateY(v) : f.DASH) },
      { k: "act", label: "", sort: false, fmt: (v, r) => (r.status === "closed" ? "" : btn("mt-close", "Close", { attrs: `data-id="${r.id}"` })) },
    ],
    onRow: r => { selMaint = r.id; root.querySelector("#bk-mt").__tbl.handle.setSel(r.id); },
    onDbl: r => editMaint(r, props, units),
  });
  ctx.csv = () => csv("valora-maintenance.csv", [{ k: "opened" }, { k: "address" }, { k: "unit" }, { k: "title" }, { k: "priority" }, { k: "status" }, { k: "vendor" }, { k: "cost" }, { k: "closed" }], rows);
}
function ageDays(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.parse(String(b).slice(0, 10)) - Date.parse(String(a).slice(0, 10))) / 86400000);
}

const tabsHtml = () => chips("bk-tab", [{ v: "expenses", label: "Expenses" }, { v: "debt", label: "Debt" }, { v: "maint", label: "Maintenance" }], tab);

export default {
  id: "books",
  deps: [],
  async render(root, ctx) {
    useCss("office");
    if (!root.firstChild) root.innerHTML = loading("Reading the books");
    let d;
    try {
      const [exp, debts, maint, props, units, inbox] = await Promise.all([
        get("/api/expenses"), get("/api/debts"), get("/api/maintenance"), get("/api/owned_props"),
        get("/api/units").catch(() => []), get("/api/inbox").catch(() => null),
      ]);
      d = { exp: exp || { rows: [] }, cats: exp?.categories || [], debts: debts || [], maint: maint || [], props: props || [], units: units || [], inbox };
    } catch (e) { root.innerHTML = empty("The books did not load", esc(e.message)); return; }
    if (fProp && !d.props.some(p => p.id === +fProp)) fProp = "";
    const c = { ...ctx, rerender: () => this.render(root, ctx), csv: null };
    if (tab === "debt") debtTab(root, c, d);
    else if (tab === "maint") maintTab(root, c, d);
    else expensesTab(root, c, d);
    const h = {
      "chip:bk-tab": v => { tab = v; this.render(root, ctx); },
      "change:bk-prop": v => { fProp = v; this.render(root, ctx); },
      "change:bk-year": v => { fYear = v; this.render(root, ctx); },
      "change:bk-cat": v => { fCat = v; this.render(root, ctx); },
      "change:bk-st": v => { fStatus = v; this.render(root, ctx); },
      "act:exp-add": () => editExpense(null, d.props, d.cats),
      "act:loan-add": () => editLoan(null, d.props),
      "act:mt-add": () => editMaint(null, d.props, d.units),
      "act:exp-csv": () => c.csv?.(), "act:loan-csv": () => c.csv?.(), "act:mt-csv": () => c.csv?.(),
    };
    bind(ctx.sub, h);
    bind(ctx.bar, h);
    bind(root, { ...h, "act:mt-close": el => { const r = d.maint.find(m => m.id === +el.dataset.id); if (r) closeMaint(r); } });
  },
};
