// Ledger — rent collection: what each tenant owes and for how long (ageing), the selected lease's ledger with its
// running balance, payments / charges / credits, every entry with filters, and charged vs collected by month.
// Charges (rent, late fee, charge) raise a balance; payments and credits lower it. Rent and late fees are posted by
// the engine on the due day / after the grace days; everything else is entered here, on the ticket or from Inbox.
import { S, f, get, post, select, esc, today, go } from "../core.js";
import { table, panel, kv, chips, selectBox, btn, sep, bind, toast, formModal, confirmModal, csv, useCss } from "../ui.js";
import * as C from "../charts.js";
import { leaseState, daysTxt } from "./rentroll.js";

useCss("portfolio");

const TYPES = [
  { v: "rent", label: "Rent", sign: 1, cls: "" },
  { v: "late_fee", label: "Late fee", sign: 1, cls: "fee" },
  { v: "charge", label: "Charge", sign: 1, cls: "fee" },
  { v: "payment", label: "Payment", sign: -1, cls: "pay" },
  { v: "credit", label: "Credit", sign: -1, cls: "cr" },
];
const T = Object.fromEntries(TYPES.map(t => [t.v, t]));
const isCharge = t => (T[t]?.sign ?? 1) > 0;
const BUCKETS = ["0-30", "31-60", "61-90", "90+"];
const r2 = v => Math.round(v * 100) / 100;
const tp = t => `<span class="tp ${T[t]?.cls || ""}">${esc(T[t]?.label || t || f.DASH)}</span>`;
const owedTxt = v => (!f.ok(v) ? f.DASH : Math.abs(v) < 0.005 ? "0.00" : f.num(v, 2));

/* ---------- module state ---------- */
let lid = null;                     // the lease whose ledger is open
let fProp = "all", fType = "all", fMonth = "all", fScope = "owed";
let tAge = null, tLed = null, tAll = null;

/* ---------- data ---------- */

/** Every lease that has a ledger: active ones from the rent roll (with escalated rent, ageing, renewed-lease balances
 *  folded in) plus ended leases from the tenant records, each with its own balance from /api/ledger/<id>. */
async function leases() {
  let rr = [], tenants = [];
  try { rr = await get("/api/rentroll"); } catch (e) { rr = []; }
  try { tenants = await get("/api/tenants"); } catch (e) { tenants = []; }
  const out = rr.filter(r => r.lease_id).map(r => ({
    key: r.lease_id, lease_id: r.lease_id, property_id: r.property_id, address: r.address, unit: r.name, tenant: r.tenant,
    status: leaseState(r).label, days_left: r.days_left, end: r.end, rent: r.current_rent, deposit: r.deposit,
    balance: r.balance, aging: r.aging || {}, active: true,
  }));
  // a lease renewed early keeps charging until its own end; the rent roll folds its balance into the new lease, so
  // its entries are shown in the new lease's ledger too
  for (const r of out) r.prev = tenants.filter(t => t.status === "renewed" && t.lease_id !== r.lease_id && t.address === r.address && t.unit === r.unit).map(t => t.lease_id);
  const have = new Set(out.flatMap(r => [r.lease_id, ...r.prev]));
  const ended = tenants.filter(t => t.lease_id && t.status === "ended" && !have.has(t.lease_id));
  const led = await Promise.all(ended.map(t => get(`/api/ledger/${t.lease_id}`).catch(() => null)));
  ended.forEach((t, i) => {
    const d = led[i];
    out.push({
      key: t.lease_id, lease_id: t.lease_id, property_id: null, address: t.address, unit: t.unit, tenant: t.name,
      status: "Ended", days_left: null, end: t.end, rent: t.rent, deposit: null,
      balance: d?.balance ?? null, aging: d?.aging || {}, active: false, prev: [],
    });
  });
  return out;
}

/* ---------- writes ---------- */

/** Record a payment, a charge or a credit. type: "payment" | "charge" | "credit". */
async function addEntry(type, all) {
  const open = all.filter(l => l.active || (f.ok(l.balance) && Math.abs(l.balance) > 0.005));
  if (!open.length) { toast("No lease to post to. Create a lease on Rent roll first.", "bad"); return; }
  const cur = open.find(l => l.lease_id === lid) || open[0];
  const word = { payment: "Record payment", charge: "Add a charge", credit: "Add a credit" }[type];
  const defAmt = type === "payment" ? (f.ok(cur.balance) && cur.balance > 0.005 ? r2(cur.balance) : cur.rent ?? "") : "";
  const v = await formModal(word, [
    { k: "lease_id", label: "Lease", type: "select", value: cur.lease_id, full: true,
      options: open.map(l => ({ v: l.lease_id, label: `${l.tenant || "Tenant"} · ${f.street(l.address)} · ${l.unit || ""} · ${l.balance > 0.005 ? "owes " + f.usd(l.balance, 2) : l.balance < -0.005 ? "credit " + f.usd(-l.balance, 2) : "settled"}` })) },
    { k: "date", label: "Date", type: "date", value: today(), req: true },
    { k: "amount", label: "Amount", type: "number", value: defAmt, req: true },
    { k: "memo", label: "Memo", full: true, req: type !== "payment",
      ph: type === "payment" ? "ACH, check #1042, cash" : type === "charge" ? "Water bill Oct, repair (tenant damage), deposit deduction" : "Concession, deposit applied, fee waived" },
  ], {
    ok: word,
    note: type === "payment" ? "A payment is applied to the oldest unpaid charges first; anything above the balance is held as a credit."
      : type === "charge" ? "A charge raises what the tenant owes, like rent. Rent and late fees are posted automatically on the due day and after the grace days; use this for anything else."
        : "A credit lowers what the tenant owes without money changing hands: a concession, a waived fee, a deposit applied to the balance.",
  });
  if (!v) return;
  if (!f.ok(v.amount) || v.amount === 0) { toast("Enter an amount", "bad"); return; }
  if (type !== "payment" && !v.memo) { toast("Say what the " + type + " is for in the memo", "bad"); return; }
  lid = +v.lease_id;
  const r = await post("/api/portfolio", { act: "add", table: "entry", data: { lease_id: +v.lease_id, date: v.date, type, amount: Math.abs(v.amount), memo: v.memo || (type === "payment" ? "Payment" : "") } });
  toast(r.error || `${T[type].label} of ${f.usd(Math.abs(v.amount), 2)} recorded`, r.error ? "bad" : "");
}

/** Edit or delete one ledger entry. */
async function editEntry(e) {
  const v = await formModal(`${T[e.type]?.label || "Entry"} · ${f.dateY(e.date)}`, [
    { k: "date", label: "Date", type: "date", value: e.date || "", req: true },
    { k: "type", label: "Type", type: "select", value: e.type, options: TYPES.map(t => ({ v: t.v, label: t.label })) },
    { k: "amount", label: "Amount", type: "number", value: e.amount ?? "", req: true },
    { k: "memo", label: "Memo", full: true, value: e.memo || "" },
  ], {
    ok: "Save", danger: "Delete entry",
    note: e.bank_txn_id ? "Matched to a bank transaction from Inbox. Deleting it leaves the bank line unmatched." : (e.type === "rent" || e.type === "late_fee") && /^(Rent|Late fee) /.test(e.memo || "")
      ? "Posted automatically. If you delete it, the engine posts it again for that month; to waive it, add a credit instead." : "",
  });
  if (!v) return;
  if (v.__danger) {
    if (!(await confirmModal("Delete entry", `Delete the ${esc((T[e.type]?.label || e.type).toLowerCase())} of <b>${f.usd(e.amount, 2)}</b> on ${f.dateY(e.date)}${e.memo ? ` (${esc(e.memo)})` : ""}? This cannot be undone.`, "Delete"))) return;
    const r = await post("/api/portfolio", { act: "delete", table: "entry", id: e.id });
    toast(r.error || "Entry deleted", r.error ? "bad" : "");
    return;
  }
  if (!f.ok(v.amount)) { toast("Enter an amount", "bad"); return; }
  const r = await post("/api/portfolio", { act: "edit", table: "entry", id: e.id, data: { date: v.date, type: v.type, amount: Math.abs(v.amount), memo: v.memo } });
  toast(r.error || "Entry saved", r.error ? "bad" : "");
}

/* ---------- pieces ---------- */

const ageCols = [
  { k: "address", label: "Unit", l: true, val: r => `${r.address}|${r.unit || ""}`, fmt: (v, r) => `<span class="lg-memo u" title="${esc(r.address)} · ${esc(r.unit || "")}">${r.property_id ? `<a class="sym" data-prop="${r.property_id}" data-go="property">${esc(f.street(r.address))}</a>` : esc(f.street(r.address))} <span class="mut">· ${esc(r.unit || f.DASH)}</span></span>` },
  { k: "tenant", label: "Tenant", l: true, fmt: v => `<span class="lg-memo n" title="${esc(v || "")}">${esc(v || f.DASH)}</span>` },
  { k: "status", label: "Lease", l: true, title: "Holdover = past the lease end and still in the unit; rent is charged month to month", fmt: (v, r) => `<span class="${v === "Holdover" ? "down" : v === "Ended" ? "mut" : v === "Occupied" ? "mut" : "amb"}" title="${r.end ? "ends " + f.dateY(r.end) : ""}">${esc(v)}</span>` },
  ...BUCKETS.map(b => ({ k: "a" + b, label: b === "90+" ? "90+" : b.replace("-", "–"), title: `Unpaid charges ${b} days old (payments are applied to the oldest charges first)`, val: r => r.aging?.[b] ?? null, fmt: v => (f.ok(v) && v > 0.005 ? f.num(v, 2) : `<span class="faint">0</span>`), cls: v => (f.ok(v) && v > 0.005 ? "down" : "") })),
  { k: "balance", label: "Balance", title: "Charges − payments and credits. Negative = paid ahead (credit)", fmt: v => `<b>${owedTxt(v)}</b>`, cls: v => (f.ok(v) && v > 0.005 ? "down" : "") },
  { k: "months", label: "Months", title: "Balance ÷ rent: how many months of rent are owed", val: r => (f.ok(r.balance) && r.balance > 0.005 && f.ok(r.rent) && r.rent > 0 ? r.balance / r.rent : null), fmt: v => (f.ok(v) ? f.num(v, 1) : f.DASH), cls: v => (f.ok(v) && v >= 1 ? "down" : "") },
  { k: "last_pay", label: "Last paid", title: "Date of the most recent payment", fmt: (v, r) => (v ? `<span title="${f.dateY(v)} · ${f.usd(r.last_amt, 2)}">${f.date(v)}</span>` : f.DASH), cls: v => (v && (Date.parse(today()) - Date.parse(v)) / 864e5 > 35 ? "amb" : "") },
];

const ledCols = [
  { k: "date", label: "Date", l: true, title: "Posting order: the running balance follows it", val: r => r.seq, fmt: (v, r) => f.dateY(r.date) },
  { k: "type", label: "Type", l: true, fmt: v => tp(v) },
  { k: "memo", label: "Memo", l: true, sort: false, fmt: (v, r) => `<span class="lg-memo m2" title="${esc(v || "")}">${esc(v || "")}</span>${r.bank_txn_id ? ` <span class="tag mut" title="Matched to bank transaction #${r.bank_txn_id}">bank</span>` : ""}` },
  { k: "chg", label: "Charge", val: r => (isCharge(r.type) ? r.amount : null), fmt: v => (f.ok(v) ? f.num(v, 2) : "") },
  { k: "pay", label: "Paid", title: "Payments and credits", val: r => (!isCharge(r.type) ? r.amount : null), fmt: v => (f.ok(v) ? f.num(v, 2) : ""), cls: "up" },
  { k: "running", label: "Balance", title: "Running balance after the entry", fmt: v => owedTxt(v), cls: v => (f.ok(v) && v > 0.005 ? "down" : "") },
];

const allCols = [
  { k: "date", label: "Date", l: true, fmt: v => f.dateY(v) },
  { k: "address", label: "Property", l: true, fmt: (v, r) => `<a class="sym" data-prop="${r.property_id}" data-go="property" title="${esc(v)}">${esc(f.street(v))}</a>` },
  { k: "unit", label: "Unit", l: true, fmt: v => esc(v || f.DASH) },
  { k: "tenant", label: "Tenant", l: true, fmt: v => esc(v || f.DASH) },
  { k: "type", label: "Type", l: true, fmt: v => tp(v) },
  { k: "memo", label: "Memo", l: true, sort: false, fmt: (v, r) => `<span class="lg-memo w" title="${esc(v || "")}">${esc(v || "")}</span>${r.bank_txn_id ? ` <span class="tag mut">bank</span>` : ""}` },
  { k: "signed", label: "Amount", title: "Charges positive, payments and credits negative (the tenant's balance moves by this much)", val: r => (r.amount ?? 0) * (T[r.type]?.sign ?? 1), fmt: v => f.num(v, 2), cls: v => (v < 0 ? "up" : "") },
];

const csvCols = [{ k: "id" }, { k: "date" }, { k: "lease_id" }, { k: "property_id" }, { k: "address" }, { k: "unit" }, { k: "tenant" }, { k: "type" },
  { k: "amount" }, { k: "signed", val: r => r2((r.amount ?? 0) * (T[r.type]?.sign ?? 1)) }, { k: "memo" }, { k: "bank_txn_id" }];

/** Sum entries by month: { "2026-11": { charged, rent, fees, collected, credits } } */
function byMonth(ents) {
  const m = {};
  for (const e of ents) {
    const k = String(e.date || "").slice(0, 7);
    if (!k) continue;
    const o = m[k] || (m[k] = { charged: 0, rent: 0, fees: 0, collected: 0, credits: 0 });
    const a = e.amount || 0;
    if (e.type === "payment") o.collected += a;
    else if (e.type === "credit") o.credits += a;
    else { o.charged += a; if (e.type === "rent") o.rent += a; else o.fees += a; }
  }
  return m;
}
const lastMonths = (n) => {
  const [y, m] = today().split("-").map(Number), out = [];
  for (let i = n - 1; i >= 0; i--) { const d = new Date(Date.UTC(y, m - 1 - i, 1)); out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`); }
  return out;
};

/* ---------- the selected lease ---------- */

async function drawLease(root, all) {
  const host = root.querySelector("#lg-lease");
  if (!host) return;
  const L = all.find(l => l.lease_id === lid);
  if (!L) {
    tLed = null;
    host.innerHTML = panel({ title: "Lease ledger", body: `<div class="empty"><b>No lease selected</b><span>Click a row in the ageing table, or a lease on Rent roll.</span></div>` });
    return;
  }
  let d = null, prev = [];
  try { [d, ...prev] = await Promise.all([lid, ...(L.prev || [])].map(id => get(`/api/ledger/${id}`).catch(() => null))); } catch (e) { d = null; }
  if (lid !== L.lease_id) return;                    // another lease was picked while this one loaded
  let ents = (d?.entries || []).map((e, i) => ({ ...e, key: e.id, seq: i }));
  if (prev.some(Boolean)) {                          // merge the renewed lease's entries and recompute the running balance
    ents = ents.concat(...prev.filter(Boolean).map(p => p.entries || [])).map(e => ({ ...e, key: e.id }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
    let run = 0;
    ents.forEach((e, i) => { run += (isCharge(e.type) ? 1 : -1) * (e.amount || 0); e.running = r2(run); e.seq = i; });
  }
  const aging = L.active ? L.aging || {} : d?.aging || L.aging || {}, bal = L.active ? L.balance : d?.balance ?? L.balance;
  const ls = d?.lease || {};
  const hold = L.status === "Holdover";
  const paid12 = ents.filter(e => e.type === "payment" && e.date >= lastMonths(12)[0]).reduce((s, e) => s + (e.amount || 0), 0);
  const chg12 = ents.filter(e => isCharge(e.type) && e.date >= lastMonths(12)[0]).reduce((s, e) => s + (e.amount || 0), 0);
  const fees = ents.filter(e => e.type === "late_fee").length;

  host.innerHTML = `<section class="pnl"><div class="ph"><h3>${esc(L.tenant || "Lease")}</h3><span class="s lg-ls" title="${esc(L.address)} · lease #${L.lease_id}${L.prev?.length ? ` (+ renewed #${L.prev.join(", #")})` : ""}">${esc(f.street(L.address))} · ${esc(L.unit || "")}</span>
      <div class="r">${btn("l-pay", "Record payment", { cls: "pri" })} ${btn("l-charge", "Charge")} ${btn("l-credit", "Credit")}</div></div>
    ${hold ? `<div class="strip warn">Past the lease end (${f.dateY(L.end)}, ${daysTxt(L.days_left)}) and still in the unit: <b>rent is charged month to month</b> at the current rent (memo "holdover"). Renew or end the lease on <a class="link" data-go="rentroll">Rent roll</a>; renewing re-charges those months at the new rent, ending removes holdover rent after the move-out date.</div>` : ""}
    ${kv([
      { k: "Balance", v: owedTxt(bal), cls: bal > 0.005 ? "down" : "", sub: bal < -0.005 ? `paid ahead ${f.usd(-bal, 2)}` : bal > 0.005 && L.rent ? `${f.num(bal / L.rent, 1)} mo of rent` : "settled" },
      { k: "Rent / mo", v: f.usd(L.rent, 2), sub: `due day ${ls.due_day ?? f.DASH} · ${ls.grace_days ?? f.DASH}d grace`, title: `${fees} late fee${fees === 1 ? "" : "s"} charged over the lease; late fee ${f.usd(ls.late_fee, 0)} after the grace days` },
      { k: "Term", v: ls.start ? `${f.mo(ls.start)} – ${f.mo(ls.end)}` : f.DASH, sub: `lease #${L.lease_id}${L.prev?.length ? ` + #${L.prev.join(", #")}` : ""} · deposit ${f.usd(ls.deposit ?? L.deposit, 0)}`, title: ls.start ? `${f.dateY(ls.start)} – ${f.dateY(ls.end)}` : "" },
      { k: "Paid 12m", v: f.usd(paid12, 0), sub: chg12 ? `of ${f.usd(chg12, 0)} charged · ${f.pct(paid12 / chg12, 0)}` : "nothing charged", title: "Payments vs rent, fees and charges dated in the last 12 months" },
    ], { cls: "tight" })}
    <div class="aging">${BUCKETS.map(b => `<div><span>${b} DAYS</span><b class="${aging[b] > 0.005 ? "down" : "faint"}">${f.num(aging[b] ?? 0, 2)}</b></div>`).join("")}</div>
    <div id="lg-led"></div></section>`;
  tLed = table(host.querySelector("#lg-led"), {
    id: "lg-led", rows: ents, cols: ledCols, key: r => r.id, sort: { k: "date", dir: -1 }, maxH: 360, nav: false,
    empty: "No entries yet. Rent is posted on the due day from the lease start; record a payment above or import a bank CSV on Inbox.",
    onDbl: r => editEntry(r),
    foot: ents.length ? `${ents.length} entries · double-click an entry to edit or delete it · running balance is in date order` : "",
  });
  bind(host, {
    "act:l-pay": () => addEntry("payment", all), "act:l-charge": () => addEntry("charge", all), "act:l-credit": () => addEntry("credit", all),
  });
}

/* ---------- page ---------- */

export default {
  id: "ledger",
  deps: ["sel"],
  async render(root, ctx) {
    root.classList.add("ow");
    if (ctx.reason === "sel") {
      if (S.sel?.kind === "lease" && S.sel.id != null && +S.sel.id !== lid && this._all?.some(l => l.lease_id === +S.sel.id)) {
        lid = +S.sel.id; tAge?.setSel(lid); await drawLease(root, this._all);
      }
      return;
    }
    let all = [], ents = [], props = [];
    try { [all, ents, props] = await Promise.all([leases(), get("/api/ledger"), get("/api/owned_props").catch(() => [])]); }
    catch (e) { root.innerHTML = panel({ title: "Ledger", body: `<div class="note">The ledger did not load: ${esc(e.message)}</div>` }); return; }
    this._all = all;

    // last payment per lease (entries come newest first)
    const lastPay = new Map();
    for (const e of ents) if (e.type === "payment" && !lastPay.has(e.lease_id)) lastPay.set(e.lease_id, e);
    for (const l of all) { const p = lastPay.get(l.lease_id); l.last_pay = p?.date || null; l.last_amt = p?.amount ?? null; }
    const propOf = new Map(ents.map(e => [e.lease_id, e.property_id]));
    for (const l of all) if (l.property_id == null) l.property_id = propOf.get(l.lease_id) ?? null;

    if (S.sel?.kind === "lease" && all.some(l => l.lease_id === +S.sel.id)) lid = +S.sel.id;
    if (!all.some(l => l.lease_id === lid)) lid = (all.slice().sort((a, b) => (b.balance || 0) - (a.balance || 0))[0] || {}).lease_id ?? null;

    const propList = props.length ? props.map(p => ({ v: String(p.id), label: f.street(p.address) }))
      : [...new Map(ents.map(e => [String(e.property_id), f.street(e.address)])).entries()].map(([v, label]) => ({ v, label }));
    if (fProp !== "all" && !propList.some(p => p.v === fProp)) fProp = "all";
    const months = [...new Set(ents.map(e => String(e.date || "").slice(0, 7)).filter(Boolean))].sort().reverse();
    if (fMonth !== "all" && !months.includes(fMonth)) fMonth = "all";

    // ---- toolbar
    ctx.sub.innerHTML = propList.length > 1 ? selectBox("prop", [{ v: "all", label: "All properties" }, ...propList], fProp, { title: "Every figure and table on the page follows this filter" }) : "";
    const entFilters = selectBox("month", [{ v: "all", label: "All months" }, ...months.map(m => ({ v: m, label: f.mo(m) }))], fMonth, { title: "Filter the entries by month" })
      + sep() + chips("type", [{ v: "all", label: "All" }, { v: "charges", label: "Charges", title: "Rent, late fees and other charges" }, { v: "payment", label: "Payments" }, { v: "credit", label: "Credits" }, { v: "late_fee", label: "Late fees" }], fType);
    ctx.bar.innerHTML = btn("pay", "Record payment", { cls: "pri", title: "Record a payment from a tenant" }) + btn("charge", "Charge", { title: "Add a charge to a lease" }) + btn("credit", "Credit", { title: "Add a credit to a lease" })
      + (ents.length ? btn("csv", "CSV", { title: "Export the entries shown in the table" }) : "");
    const rerender = () => this.render(root, { ...ctx, reason: "prefs" });
    bind(ctx.sub, { "change:prop": v => { fProp = v; rerender(); } });
    const shownEntries = () => (tAll ? tAll.view() : []);
    bind(ctx.bar, {
      "act:pay": () => addEntry("payment", all), "act:charge": () => addEntry("charge", all), "act:credit": () => addEntry("credit", all),
      "act:csv": () => csv(`valora-ledger-${today()}.csv`, csvCols, shownEntries()),
    });

    // ---- empty workspace
    if (!all.length && !ents.length) {
      tAge = tLed = tAll = null;
      ctx.bar.innerHTML = "";
      root.innerHTML = panel({
        title: "Ledger", sub: "rent charged and collected, per lease",
        body: `<div class="empty"><b>No leases yet</b><span>The ledger fills itself once a lease exists: rent is charged on the due day and late fees after the grace days.<br>
          Create a lease on <a class="link" data-go="rentroll">Rent roll</a> (or drop a lease PDF on <a class="link" data-go="inbox">Inbox</a>), then record payments here or import a bank CSV on Inbox to match them for you.</span></div>`,
      });
      return;
    }

    const inP = l => fProp === "all" || String(l.property_id) === fProp;
    const L = all.filter(inP);
    const E = ents.filter(e => fProp === "all" || String(e.property_id) === fProp);
    if (L.length && !L.some(l => l.lease_id === lid)) lid = L.slice().sort((a, b) => (b.balance || 0) - (a.balance || 0))[0].lease_id;

    // ---- headline: receivables now, and this month's collection
    const pos = L.filter(l => f.ok(l.balance) && l.balance > 0.005), neg = L.filter(l => f.ok(l.balance) && l.balance < -0.005);
    const owed = pos.reduce((s, l) => s + l.balance, 0), prepaid = -neg.reduce((s, l) => s + l.balance, 0);
    const over30 = L.reduce((s, l) => s + (l.aging?.["31-60"] || 0) + (l.aging?.["61-90"] || 0) + (l.aging?.["90+"] || 0), 0);
    const bm = byMonth(E), cur = today().slice(0, 7), mm = bm[cur] || { charged: 0, collected: 0, credits: 0, rent: 0, fees: 0 };
    const prevK = lastMonths(2)[0], pm = bm[prevK] || null;
    const sched = L.filter(l => l.active).reduce((s, l) => s + (l.rent || 0), 0);
    const demo = !!S.state?.demo;

    if (!root.querySelector("#lg-age")) {
      root.innerHTML = `<section class="pnl"><div class="ph"><h3>Receivables</h3><span class="s" id="lg-sub"></span></div><div id="lg-kv"></div></section>
        <section class="pnl"><div class="ph"><h3>Arrears ageing</h3><span class="s" id="lg-asub"></span><div class="r" id="lg-scope"></div></div><div id="lg-age"></div></section>
        <div class="cols2 w21">
          <div id="lg-lease"></div>
          ${panel({ title: "Charged vs collected", sub: "12 months · * to date", flush: true, body: `<div id="lg-chart" class="ow-chart"></div><div id="lg-mtab"></div>` })}
        </div>
        <section class="pnl"><div class="ph"><h3>All entries</h3><span class="s" id="lg-esub"></span><div class="r" id="lg-ef"></div></div><div id="lg-all"></div></section>`;
    }
    root.querySelector("#lg-sub").innerHTML = `as of ${f.dateY(today())} · from the ledger: rent and late fees posted by InvestStack, payments from you, the ticket and Inbox${demo ? ` · <span class="tag amb">Demo data</span>` : ""}`;
    root.querySelector("#lg-kv").innerHTML = kv([
      { k: "Owed", v: f.usd(owed, 0), cls: owed > 0.005 ? "down" : "", sub: `${pos.length} lease${pos.length === 1 ? "" : "s"} in arrears`, title: "Sum of positive balances" },
      { k: "Over 30 days", v: f.usd(over30, 0), cls: over30 > 0.005 ? "down" : "", sub: owed > 0.005 ? `${f.pct(over30 / owed, 0)} of owed` : "", title: "Unpaid charges older than 30 days" },
      { k: "Paid ahead", v: f.usd(prepaid, 0), sub: `${neg.length} lease${neg.length === 1 ? "" : "s"} in credit`, title: "Negative balances: tenants who paid more than was charged" },
      { k: "Charged MTD", v: f.usd(mm.charged, 0), sub: `rent ${f.num(mm.rent, 0)} + fees ${f.num(mm.fees, 0)}`, title: `Rent, late fees and charges dated ${f.mo(cur)}` },
      { k: "Collected MTD", v: f.usd(mm.collected, 0), sub: mm.charged ? `${f.pct(mm.collected / mm.charged, 0)} of charged` : "nothing charged yet", title: `Payments dated ${f.mo(cur)}, month to date` },
      { k: "Last month", v: pm ? f.usd(pm.collected, 0) : f.DASH, sub: `collected ${f.mo(prevK)}${pm && pm.charged ? ` · ${f.pct(pm.collected / pm.charged, 0)}` : ""}`, title: `Payments dated ${f.mo(prevK)} vs ${f.usd(pm?.charged, 0)} of charges dated ${f.mo(prevK)}; scheduled rent now ${f.usd(sched, 0)} / mo` },
    ]);

    // ---- ageing table
    const scoped = fScope === "owed" ? L.filter(l => (f.ok(l.balance) && Math.abs(l.balance) > 0.005) || l.status === "Holdover") : L;
    root.querySelector("#lg-scope").innerHTML = chips("scope", [{ v: "owed", label: "Open balances", sub: L.filter(l => (f.ok(l.balance) && Math.abs(l.balance) > 0.005) || l.status === "Holdover").length }, { v: "all", label: "All leases", sub: L.length }], fScope);
    bind(root.querySelector("#lg-scope"), { "chip:scope": v => { fScope = v; rerender(); } });
    root.querySelector("#lg-asub").innerHTML = `oldest charges are paid first · click a row to open its ledger`;
    const tot = b => scoped.reduce((s, l) => s + (l.aging?.[b] || 0), 0);
    tAge = table(root.querySelector("#lg-age"), {
      id: "lg-age", rows: scoped, cols: ageCols, key: r => r.lease_id, sel: lid, sort: { k: "balance", dir: -1 },
      empty: fScope === "owed" ? "Every balance is settled. Switch to All leases to see each one." : "No leases",
      onRow: r => { lid = r.lease_id; tAge.setSel(lid); select({ kind: "lease", id: r.lease_id, row: r }); drawLease(root, all); },
      foot: `${scoped.length} lease${scoped.length === 1 ? "" : "s"} · ${BUCKETS.map(b => `${b}: ${f.usd(tot(b), 2)}`).join(" · ")} · net ${f.usd(scoped.reduce((s, l) => s + (l.balance || 0), 0), 2)}`,
    });

    // ---- selected lease
    await drawLease(root, all);

    // ---- charged vs collected, 12 months
    const ms = lastMonths(12);
    const chartEl = root.querySelector("#lg-chart");
    if (ms.some(m => bm[m])) {
      C.bars(chartEl, {
        h: 200, cats: ms.map(m => f.mo(m)), legend: true,
        series: [{ name: "Charged", vals: ms.map(m => bm[m]?.charged ?? null), color: "mut" }, { name: "Collected", vals: ms.map(m => bm[m]?.collected ?? null), color: "acc" }],
        y: { fmt: v => f.cusd(v) },
        onClick: (c, j) => { fMonth = ms[j]; rerender(); },
      });
    } else chartEl.innerHTML = `<div class="empty"><span>No charges or payments in the last 12 months</span></div>`;
    const mrows = ms.slice().reverse().map(m => ({ key: m, month: m, ...(bm[m] || { charged: 0, collected: 0, credits: 0 }) }));
    table(root.querySelector("#lg-mtab"), {
      id: "lg-mtab", rows: mrows, key: r => r.key, nav: false, maxH: 200, sort: { k: "month", dir: -1 }, sel: fMonth,
      cols: [
        { k: "month", label: "Month", l: true, fmt: v => (v === cur ? `<span title="month to date">${f.mo(v)}*</span>` : f.mo(v)) },
        { k: "charged", label: "Charged", fmt: v => f.num(v, 0) },
        { k: "collected", label: "Paid", title: "Payments dated in the month", fmt: v => f.num(v, 0) },
        { k: "rate", label: "Rate", title: "Collected ÷ charged in the month (payments can be for earlier months)", val: r => (r.charged ? r.collected / r.charged : null), fmt: v => f.pct(v, 0), cls: v => (f.ok(v) && v < 0.95 ? "amb" : "") },
      ],
      onRow: r => { fMonth = fMonth === r.month ? "all" : r.month; rerender(); },
    });

    // ---- all entries
    const ef = root.querySelector("#lg-ef");
    ef.innerHTML = entFilters;
    bind(ef, { "change:month": v => { fMonth = v; rerender(); }, "chip:type": v => { fType = v; rerender(); } });
    const rows = E.filter(e => (fMonth === "all" || String(e.date).startsWith(fMonth))
      && (fType === "all" || (fType === "charges" ? isCharge(e.type) : e.type === fType))).map(e => ({ ...e, key: e.id }));
    const sumT = t => rows.filter(e => (t === "c" ? isCharge(e.type) : !isCharge(e.type))).reduce((s, e) => s + (e.amount || 0), 0);
    root.querySelector("#lg-esub").innerHTML = `${f.int(rows.length)} of ${f.int(E.length)}${fMonth !== "all" ? ` · ${f.mo(fMonth)}` : ""}${fType !== "all" ? ` · ${fType === "charges" ? "charges" : (T[fType]?.label || fType).toLowerCase() + "s"}` : ""} · <span title="Charges − payments and credits for the entries shown">charged ${f.usd(sumT("c"), 0)} · paid ${f.usd(sumT("p"), 0)} · net ${f.susd(r2(sumT("c") - sumT("p")), 0)}</span>${ents.length >= 3000 ? " · newest 3,000 entries only" : ""}`;
    tAll = table(root.querySelector("#lg-all"), {
      id: "lg-all", rows, cols: allCols, key: r => r.id, sort: { k: "date", dir: -1 }, limit: 100, maxH: 420,
      empty: "No entries match the filters", onRow: r => { if (r.lease_id !== lid && all.some(l => l.lease_id === r.lease_id)) { lid = r.lease_id; tAge?.setSel(lid); select({ kind: "lease", id: r.lease_id, row: all.find(l => l.lease_id === r.lease_id) }); drawLease(root, all); } },
      onDbl: r => editEntry(r),
      foot: "double-click an entry to edit or delete it",
    });
  },
  key(e) {
    if (e.key === "p" && !e.metaKey && !e.ctrlKey && this._all) { addEntry("payment", this._all); return true; }
    return false;
  },
};
