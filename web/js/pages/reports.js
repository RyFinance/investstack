// Reports — the year-end and month-end paperwork: a Schedule-E style summary per property (not tax advice),
// an owner statement (month by month for one property) and a rent-roll export. Everything is computed from the
// ledger, the expenses and the loan schedules already in Books; nothing here is typed.
import { S, f, get, esc, today } from "../core.js";
import { panel, kv, chips, btn, bind, toast, csv, selectBox, useCss, empty, loading } from "../ui.js";
import { amort } from "./books.js";

let rep = "sched";
let year = "";
let prop = "";

// Schedule E (Form 1040) Part I line numbers
const LINE_NO = {
  "Rents received": 3, Advertising: 5, "Auto and travel": 6, "Cleaning and maintenance": 7, Commissions: 8, Insurance: 9,
  "Legal and other professional fees": 10, "Management fees": 11, "Mortgage interest": 12, "Other interest": 13, Repairs: 14,
  Supplies: 15, Taxes: 16, Utilities: 17, Depreciation: 18, Other: 19,
};
const LINE_SRC = {
  "Rents received": "payments in the ledger", "Mortgage interest": "loan schedules in Books",
  Depreciation: "27.5-yr SL · 80% of cost + rehab",
};
const money = v => (f.ok(v) && Math.abs(v) >= 0.005 ? f.usd(v, 0) : `<span class="faint">${f.DASH}</span>`);
const ym = (y, m) => `${y}-${String(m).padStart(2, "0")}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function printNow(title) {
  const h = document.documentElement;
  const old = document.title;
  document.title = title;
  h.classList.add("va-print");
  const done = () => { h.classList.remove("va-print"); document.title = old; window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  setTimeout(() => { try { window.print(); } catch (e) { /* no print dialog here */ } setTimeout(done, 400); }, 30);
}

/* ---------- Schedule E ---------- */

function schedE(root, ctx, se) {
  const ps = se.properties || [];
  const lines = (se.lines || []).filter(Boolean);
  const tot = { rents: 0, exp: 0, net: 0, lines: Object.fromEntries(lines.map(l => [l, 0])) };
  for (const p of ps) { tot.rents += p.rents || 0; tot.exp += p.expenses || 0; tot.net += p.net || 0; for (const l of lines) tot.lines[l] += p.lines?.[l] || 0; }
  ctx.csv = () => {
    const cols = [{ k: "line", csv: "line" }, { k: "item", csv: "item" }, ...ps.map((p, i) => ({ k: "p" + i, csv: f.street(p.address) })), { k: "total", csv: "total" }];
    const rows = [{ line: 3, item: "Rents received", ...Object.fromEntries(ps.map((p, i) => ["p" + i, r2(p.rents)])), total: r2(tot.rents) }];
    for (const l of lines) rows.push({ line: LINE_NO[l] ?? "", item: l, ...Object.fromEntries(ps.map((p, i) => ["p" + i, r2(p.lines?.[l])])), total: r2(tot.lines[l]) });
    rows.push({ line: 20, item: "Total expenses", ...Object.fromEntries(ps.map((p, i) => ["p" + i, r2(p.expenses)])), total: r2(tot.exp) });
    rows.push({ line: 21, item: "Income or (loss)", ...Object.fromEntries(ps.map((p, i) => ["p" + i, r2(p.net)])), total: r2(tot.net) });
    rows.push({ line: "", item: "Depreciation basis", ...Object.fromEntries(ps.map((p, i) => ["p" + i, r2(p.basis)])), total: r2(ps.reduce((a, p) => a + (p.basis || 0), 0)) });
    csv(`valora-schedule-e-${se.year}.csv`, cols, rows);
  };
  if (!ps.length) {
    ctx.csv = null;
    root.innerHTML = panel({ title: `Schedule E style summary · ${se.year}`, body: empty("No owned properties", "Reports are built from what you own. Add a property on <a class=\"link\" data-go=\"portfolio\">Portfolio</a>, then drop bank exports and leases on <a class=\"link\" data-go=\"inbox\">Inbox</a>.") });
    return;
  }
  const many = ps.length > 1;
  const head = `<tr><th class="l" style="width:26px">Line</th><th class="l">Item</th>${ps.map(p => `<th title="${esc(p.address)}">${esc(f.street(p.address))}</th>`).join("")}${many ? "<th>Total</th>" : ""}<th class="l">Source</th></tr>`;
  const row = (no, item, vals, total, cls = "", srcTxt = "") => `<tr class="${cls}"><td class="l ln">${no ?? ""}</td><td class="l">${esc(item)}</td>${vals.map(v => `<td>${money(v)}</td>`).join("")}${many ? `<td><b>${money(total)}</b></td>` : ""}<td class="l src">${esc(srcTxt)}</td></tr>`;
  let body = `<tr class="hd"><td class="l" colspan="${ps.length + (many ? 4 : 3)}">Income</td></tr>`
    + row(3, "Rents received", ps.map(p => p.rents), tot.rents, "", LINE_SRC["Rents received"])
    + `<tr class="hd"><td class="l" colspan="${ps.length + (many ? 4 : 3)}">Expenses</td></tr>`;
  for (const l of lines) body += row(LINE_NO[l], l === "Mortgage interest" ? "Mortgage interest paid to banks" : l === "Depreciation" ? "Depreciation expense" : l, ps.map(p => p.lines?.[l]), tot.lines[l], "", LINE_SRC[l] || (tot.lines[l] ? "expenses in Books" : ""));
  body += row(20, "Total expenses", ps.map(p => p.expenses), tot.exp, "tot")
    + `<tr class="net"><td class="l ln">21</td><td class="l">Income or (loss)</td>${ps.map(p => `<td class="${f.cls(p.net)}">${f.susd(p.net, 0)}</td>`).join("")}${many ? `<td class="${f.cls(tot.net)}"><b>${f.susd(tot.net, 0)}</b></td>` : ""}<td class="l src">before passive-loss limits</td></tr>`
    + `<tr class="dim"><td class="l ln"></td><td class="l">Depreciation basis</td>${ps.map(p => `<td>${money(p.basis)}</td>`).join("")}${many ? "<td></td>" : ""}<td class="l src">from purchase price on Portfolio</td></tr>`;
  const interest = tot.lines["Mortgage interest"] || 0, dep = tot.lines.Depreciation || 0;
  root.innerHTML = `<div class="print-only rp-ph"><b>Schedule E style summary · tax year ${se.year}</b><span>${esc(S.state?.demo ? "Demo workspace (sample data)" : "InvestStack")} · printed ${esc(today())} · not tax advice</span></div>
    <section class="pnl">${kv([
      { k: `Rents ${se.year}`, v: f.usd(tot.rents), sub: `${ps.length} propert${ps.length === 1 ? "y" : "ies"}` },
      { k: "Operating expenses", v: f.usd(tot.exp - interest - dep), sub: "lines 5–11, 13–17, 19" },
      { k: "Mortgage interest", v: f.usd(interest), sub: "line 12" },
      { k: "Depreciation", v: f.usd(dep), sub: "line 18" },
      { k: "Income or (loss)", v: f.susd(tot.net), cls: f.cls(tot.net), sub: `line 21 · total expenses ${f.usd(tot.exp)}` },
    ], { cls: "tight" })}</section>
    <div class="strip warn no-print"><b>Schedule-E style, not tax advice.</b> Rents are cash received in ${se.year} per the ledger. Depreciation uses an assumed 80% building share and a mid-month first year; your accountant's basis, land split and any prior-year carryovers will differ.${S.state?.demo ? " Demo data." : ""}</div>
    <section class="pnl"><div class="ph"><h3>Schedule E style summary · ${se.year}</h3><span class="s">Part I · one column per property · cash basis</span></div>
    <div class="tbl-wrap" style="max-height:none"><table class="t rp-t"><thead>${head}</thead><tbody>${body}</tbody></table></div></section>`;
}
const r2 = v => (f.ok(v) ? Math.round(v * 100) / 100 : "");

/* ---------- owner statement ---------- */

function ownerStatement(root, ctx, d) {
  const { props, ledger, expenses, debts } = d;
  if (!props.length) {
    root.innerHTML = panel({ title: "Owner statement", body: empty("No owned properties", "Add a property on <a class=\"link\" data-go=\"portfolio\">Portfolio</a> first.") });
    ctx.csv = null;
    return;
  }
  if (!prop || !props.some(p => p.id === +prop)) prop = String(props[0].id);
  const P = props.find(p => p.id === +prop), y = +year;
  const curM = String(y) === today().slice(0, 4) ? +today().slice(5, 7) : String(y) > today().slice(0, 4) ? 0 : 12;
  const led = ledger.filter(e => e.property_id === P.id && String(e.date).startsWith(String(y)));
  const exp = expenses.filter(e => e.property_id === P.id && String(e.date).startsWith(String(y)));
  const loans = debts.filter(x => x.property_id === P.id).map(x => ({ ...x, am: amort(x) }));
  const rows = [];
  for (let m = 1; m <= 12; m++) {
    const k = ym(y, m), inM = e => String(e.date).startsWith(k);
    const charged = led.filter(e => inM(e) && ["rent", "late_fee", "charge"].includes(e.type)).reduce((a, e) => a + e.amount, 0);
    const credits = led.filter(e => inM(e) && e.type === "credit").reduce((a, e) => a + Math.abs(e.amount), 0);
    const collected = led.filter(e => inM(e) && e.type === "payment").reduce((a, e) => a + Math.abs(e.amount), 0);
    const opex = exp.filter(inM).reduce((a, e) => a + e.amount, 0);
    let interest = 0, principal = 0, escrow = 0;
    for (const L of loans) {
      const mm = L.am.months.find(x => x.ym === k);
      if (mm) { interest += mm.int; principal += mm.prin; escrow += L.escrow || 0; }
    }
    const future = m > curM;
    rows.push({ k, m, charged: future ? null : charged, credits: future ? null : credits, collected: future ? null : collected, opex: future ? null : opex,
      noi: future ? null : collected - opex, interest: future ? null : interest, principal: future ? null : principal, escrow: future ? null : escrow,
      cash: future ? null : collected - opex - interest - principal - escrow, future });
  }
  const T = k => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const cats = new Map();
  for (const e of exp) cats.set(e.category || "Other", (cats.get(e.category || "Other") || 0) + e.amount);
  const catRows = [...cats.entries()].sort((a, b) => b[1] - a[1]);
  const COLS = [
    ["charged", "Billed", "Rent, late fees and charges posted to the leases"], ["credits", "Credits", "Credits given"],
    ["collected", "Collected", "Tenant payments received"], ["opex", "Expenses", "Operating expenses recorded in Books"],
    ["noi", "NOI", "Collected − expenses"], ["interest", "Interest", "From the loan schedule"], ["principal", "Principal", "From the loan schedule"],
    ["escrow", "Escrow", "Taxes / insurance escrow paid with the loan"], ["cash", "Cash to owner", "NOI − P&I − escrow"],
  ];
  const cell = (k, v) => (v == null ? `<span class="faint">${f.DASH}</span>` : k === "noi" || k === "cash" ? `<span class="${f.cls(v)}">${f.susd(v, 0)}</span>` : money(v));
  const body = rows.map(r => `<tr class="${r.future ? "dim" : ""}"><td class="l">${MONTHS[r.m - 1]} ${y}</td>${COLS.map(([k]) => `<td>${cell(k, r[k])}</td>`).join("")}</tr>`).join("")
    + `<tr class="tot"><td class="l">Year to date</td>${COLS.map(([k]) => `<td>${k === "noi" || k === "cash" ? `<span class="${f.cls(T(k))}">${f.susd(T(k), 0)}</span>` : money(T(k))}</td>`).join("")}</tr>`;
  const coll = T("charged") ? T("collected") / T("charged") : null;
  ctx.csv = () => csv(`valora-owner-statement-${f.street(P.address).replace(/\W+/g, "-").toLowerCase()}-${y}.csv`,
    [{ k: "k", csv: "month" }, ...COLS.map(([k]) => ({ k, val: r => r2(r[k]) }))], rows.filter(r => !r.future));
  root.innerHTML = `<div class="print-only rp-ph"><b>Owner statement · ${esc(P.address)} · ${y}</b><span>${esc(S.state?.demo ? "Demo workspace (sample data)" : "InvestStack")} · printed ${esc(today())}</span></div>
    <section class="pnl">${kv([
      { k: "Collected", v: f.usd(T("collected")), sub: `${f.pct(coll, 1)} of ${f.usd(T("charged"))} billed`, cls: coll != null && coll < 0.95 ? "amb" : "" },
      { k: "Expenses", v: f.usd(T("opex")), sub: `${exp.length} entries` },
      { k: "NOI", v: f.susd(T("noi")), cls: f.cls(T("noi")) },
      { k: "Debt service", v: f.usd(T("interest") + T("principal") + T("escrow")), sub: loans.length ? `P&I + escrow, ${loans.length} loan${loans.length > 1 ? "s" : ""}` : "no loan recorded" },
      { k: "Cash to owner", v: f.susd(T("cash")), cls: f.cls(T("cash")) },
    ], { cls: "tight" })}</section>
    <section class="pnl"><div class="ph"><h3>Owner statement · ${esc(f.street(P.address))}</h3><span class="s">${esc(f.city(P.address))} · ${y} · cash basis · months after ${curM ? MONTHS[curM - 1] : "the start of the year"} not yet reported</span></div>
    <div class="tbl-wrap" style="max-height:none"><table class="t rp-t"><thead><tr><th class="l">Month</th>${COLS.map(([, l, t]) => `<th title="${esc(t)}">${l}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="note">Billed comes from the lease charges in the ledger; collected from recorded payments (bank rows accepted on Inbox or payments recorded on Ledger). Interest and principal follow each loan's amortisation schedule; actual servicer splits can differ by a few dollars.</div></section>
    ${catRows.length ? panel({ title: "Expenses by Schedule E line", sub: String(y), flush: true, body: `<table class="t rp-t"><tbody>${catRows.map(([c, v]) => `<tr><td class="l ln">${LINE_NO[c] ?? ""}</td><td class="l">${esc(c)}</td><td>${f.usd(v, 2)}</td><td>${f.pct(T("opex") ? v / T("opex") : null, 1)}</td></tr>`).join("")}</tbody></table>` }) : ""}`;
}

/* ---------- rent roll ---------- */

function rentRoll(root, ctx, rr) {
  const rows = rr.filter(u => !prop || u.property_id === +prop);
  const COLS = [
    { k: "address", csv: "property", val: r => r.address }, { k: "name", csv: "unit" }, { k: "beds" }, { k: "baths" },
    { k: "status", csv: "unit_status" }, { k: "tenant" }, { k: "start", csv: "lease_start" }, { k: "end", csv: "lease_end" },
    { k: "rent", csv: "lease_rent" }, { k: "current_rent", csv: "current_rent" }, { k: "market_rent" }, { k: "loss_to_lease" },
    { k: "deposit" }, { k: "balance", csv: "balance_owed" }, { k: "days_left" },
  ];
  ctx.csv = () => csv(`valora-rent-roll-${today()}.csv`, COLS, rows);
  if (!rr.length) {
    ctx.csv = null;
    root.innerHTML = panel({ title: "Rent roll", body: empty("No units", "Add units and leases on <a class=\"link\" data-go=\"rentroll\">Rent roll</a>, or drop lease PDFs on <a class=\"link\" data-go=\"inbox\">Inbox</a>.") });
    return;
  }
  const occ = rows.filter(u => u.status === "occupied");
  const sumK = k => rows.reduce((a, u) => a + (f.ok(u[k]) ? +u[k] : 0), 0);
  const body = rows.map(u => `<tr class="${u.status !== "occupied" ? "dim" : ""}"><td class="l">${esc(f.street(u.address))}</td><td class="l">${esc(u.name)}</td>
    <td class="l">${esc(u.tenant || (u.status === "occupied" ? f.DASH : "Vacant"))}</td><td>${f.ok(u.beds) ? f.num(u.beds, 0) : f.DASH}/${f.ok(u.baths) ? f.num(u.baths, 1) : f.DASH}</td>
    <td>${u.start ? f.dateY(u.start) : f.DASH}</td><td${u.lease_id && u.end && u.end < today() ? ` class="down" title="Lease ended ${esc(u.end)}; tenant still in place (month-to-month or holdover)"` : ""}>${u.end ? f.dateY(u.end) + (u.lease_id && u.end < today() ? " ·&nbsp;ended" : "") : f.DASH}</td><td>${u.lease_id ? f.usd(u.current_rent ?? u.rent) : f.DASH}</td><td>${f.usd(u.market_rent)}</td>
    <td>${f.usd(u.deposit)}</td><td class="${u.balance > 0 ? "down" : ""}">${u.balance ? f.usd(u.balance, 2) : f.DASH}</td></tr>`).join("")
    + `<tr class="tot"><td class="l" colspan="6">${f.int(occ.length)} of ${f.int(rows.length)} units let</td><td>${f.usd(occ.reduce((a, u) => a + (u.current_rent ?? u.rent ?? 0), 0))}</td><td>${f.usd(sumK("market_rent"))}</td><td>${f.usd(sumK("deposit"))}</td><td>${f.usd(sumK("balance"), 2)}</td></tr>`;
  root.innerHTML = `<div class="print-only rp-ph"><b>Rent roll as of ${esc(today())}</b><span>${esc(S.state?.demo ? "Demo workspace (sample data)" : "InvestStack")}</span></div>
    <section class="pnl">${kv([
      { k: "Occupancy", v: f.pct(rows.length ? occ.length / rows.length : null, 0), sub: `${f.int(occ.length)} of ${f.int(rows.length)} units let` },
      { k: "Scheduled rent", v: f.usd(occ.reduce((a, u) => a + (u.current_rent ?? u.rent ?? 0), 0)), sub: "per month, current" },
      { k: "Market rent", v: f.usd(sumK("market_rent")), sub: "all units" },
      { k: "Deposits held", v: f.usd(sumK("deposit")) },
      { k: "Owed", v: f.usd(sumK("balance"), 0), cls: sumK("balance") > 0 ? "down" : "" },
    ], { cls: "tight" })}</section>
    <section class="pnl"><div class="ph"><h3>Rent roll · as of ${f.dateY(today())}</h3><span class="s">current rent includes escalations to date · CSV has every lease field</span></div>
    <div class="tbl-wrap" style="max-height:none"><table class="t rp-t"><thead><tr><th class="l">Property</th><th class="l">Unit</th><th class="l">Tenant</th><th>Bd/Ba</th><th>Start</th><th>End</th><th>Rent</th><th>Market</th><th>Deposit</th><th>Owed</th></tr></thead><tbody>${body}</tbody></table></div></section>`;
}

export default {
  id: "reports",
  deps: [],
  async render(root, ctx) {
    useCss("office");
    if (!root.firstChild) root.innerHTML = loading("Building the report");
    const cy = +today().slice(0, 4);
    if (!year) year = String(cy);
    let props = [];
    try { props = (await get("/api/owned_props")) || []; } catch (e) { props = []; }
    if (prop && !props.some(p => p.id === +prop)) prop = "";
    const years = Array.from({ length: 6 }, (_, i) => String(cy - i));
    const c = { ...ctx, csv: null };
    ctx.sub.innerHTML = chips("rp", [{ v: "sched", label: "Schedule E" }, { v: "owner", label: "Owner statement" }, { v: "rr", label: "Rent roll" }], rep)
      + `<span class="sep"></span>`
      + (rep !== "rr" ? selectBox("rp-year", years.map(y => ({ v: y, label: y })), year) : "")
      + (rep === "owner" ? selectBox("rp-prop", props.map(p => ({ v: p.id, label: f.street(p.address) })), prop || props[0]?.id || "")
        : rep === "rr" ? selectBox("rp-prop", [{ v: "", label: "All properties" }, ...props.map(p => ({ v: p.id, label: f.street(p.address) }))], prop) : "");
    ctx.bar.innerHTML = btn("rp-print", "Print") + btn("rp-csv", "CSV", { cls: "pri" });
    const titles = { sched: `Schedule E ${year}`, owner: `Owner statement ${year}`, rr: `Rent roll ${today()}` };
    const h = {
      "chip:rp": v => { rep = v; if (v === "owner" && !prop && props[0]) prop = String(props[0].id); this.render(root, ctx); },
      "change:rp-year": v => { year = v; this.render(root, ctx); },
      "change:rp-prop": v => { prop = v; this.render(root, ctx); },
      "act:rp-print": () => printNow(`InvestStack ${titles[rep]}`),
      "act:rp-csv": () => (c.csv ? c.csv() : toast("Nothing to export yet", "bad")),
    };
    bind(ctx.sub, h);
    bind(ctx.bar, h);
    try {
      if (rep === "owner") {
        const [ledger, ex, debts] = await Promise.all([get("/api/ledger"), get(`/api/expenses?year=${year}`), get("/api/debts")]);
        ownerStatement(root, c, { props, ledger: ledger || [], expenses: ex?.rows || [], debts: debts || [] });
      } else if (rep === "rr") rentRoll(root, c, (await get("/api/rentroll")) || []);
      else schedE(root, c, await get(`/api/schedule_e?year=${year}`));
    } catch (e) { root.innerHTML = empty("The report did not build", esc(e.message)); }
  },
};
