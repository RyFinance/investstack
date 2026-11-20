// Rent roll — units, tenants and leases: the scheduled rent of everything you own, what is vacant, what expires,
// and the lease actions (add unit, new lease, renew, end, edit). The lease dialogs are exported for Portfolio and Ledger.
import { S, f, get, post, select, esc, today, changed } from "../core.js";
import { table, panel, kv, chips, selectBox, btn, sep, bind, toast, formModal, confirmModal, csv, pill, useCss } from "../ui.js";
import * as C from "../charts.js";

useCss("portfolio");

/* ---------- shared helpers (also used by portfolio.js and ledger.js) ---------- */

const pad = n => String(n).padStart(2, "0");
const ymd = s => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return { y, m, d: d || 1 }; };
const iso = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
/** "2026-11-16" + n days */
export const addDays = (s, n) => { const p = ymd(s); return iso(p.y, p.m, p.d + n); };
/** The day before the same date `years` later: the last day of a lease that starts on `s`. */
export const leaseEnd = (s, years = 1) => { const p = ymd(s); return iso(p.y + years, p.m, p.d - 1); };
export const firstOfNextMonth = s => { const p = ymd(s); return iso(p.y, p.m + 1, 1); };
const round2 = v => Math.round(v * 100) / 100;

const isVacant = r => !r.lease_id && r.status !== "unverified";

/** Lease state for a rent-roll row → { label, cls, rank } */
export function leaseState(r) {
  if (!r || !r.lease_id) return r?.status === "unverified" ? { label: "Unconfirmed", cls: "", rank: 0 } : { label: "Vacant", cls: "amb", rank: 0 };
  if (r.lease_status === "notice") return { label: "Notice", cls: "amb", rank: 2 };
  if (f.ok(r.days_left) && r.days_left < 0) return { label: "Holdover", cls: "down", rank: 1 };
  if (f.ok(r.days_left) && r.days_left <= 90) return { label: "Expiring", cls: "amb", rank: 3 };
  return { label: "Occupied", cls: "", rank: 4 };
}
/** Colour class for days left on a lease */
export const daysCls = d => (!f.ok(d) ? "" : d < 0 ? "down" : d <= 90 ? "amb" : "");
export const daysTxt = d => (!f.ok(d) ? f.DASH : d < 0 ? `${Math.abs(d)}d over` : `${d}d`);

const unitLabel = u => `${f.street(u.address)} · ${u.name || "Unit " + u.id}`;

async function ownedProps() {
  try { return await get("/api/owned_props"); } catch (e) { return []; }
}

/** Add a unit to an owned property. */
export async function addUnit(pid) {
  const props = await ownedProps();
  if (!props.length) { toast("Add an owned property on Portfolio first", "bad"); return null; }
  const v = await formModal("Add unit", [
    { k: "property_id", label: "Property", type: "select", value: pid ?? props[0].id, options: props.map(p => ({ v: p.id, label: f.street(p.address) })), full: true },
    { k: "name", label: "Unit name", value: "", ph: "Unit A", req: true },
    { k: "market_rent", label: "Market rent / mo", type: "number", ph: "1,450" },
    { k: "beds", label: "Beds", type: "number" },
    { k: "baths", label: "Baths", type: "number" },
    { k: "sqft", label: "Sq ft", type: "number" },
  ], { ok: "Add unit" });
  if (!v) return null;
  const r = await post("/api/portfolio", { act: "add", table: "unit", data: { ...v, property_id: +v.property_id, status: "vacant" } });
  toast(r.error || `Added ${v.name}`, r.error ? "bad" : "");
  return r;
}

/** Edit a unit (and delete it when it has no active lease). */
export async function editUnit(r) {
  const v = await formModal(`Edit ${r.name || "unit"} · ${f.street(r.address)}`, [
    { k: "name", label: "Unit name", value: r.name || "", req: true },
    { k: "market_rent", label: "Market rent / mo", type: "number", value: r.market_rent ?? "" },
    { k: "beds", label: "Beds", type: "number", value: r.beds ?? "" },
    { k: "baths", label: "Baths", type: "number", value: r.baths ?? "" },
    { k: "sqft", label: "Sq ft", type: "number", value: r.sqft ?? "" },
  ], { ok: "Save", danger: r.lease_id ? null : "Delete unit" });
  if (!v) return null;
  if (v.__danger) {
    if (!(await confirmModal("Delete unit", `Delete <b>${esc(r.name)}</b> at ${esc(f.street(r.address))} and every ended lease and ledger entry on it? This cannot be undone.`, "Delete"))) return null;
    const d = await post("/api/portfolio", { act: "delete", table: "unit", id: r.id });
    toast(d.error || "Unit deleted", d.error ? "bad" : "");
    return d;
  }
  const res = await post("/api/portfolio", { act: "edit", table: "unit", id: r.id, data: v });
  toast(res.error || "Unit saved", res.error ? "bad" : "");
  return res;
}

/** Sign a new lease on a vacant unit (creates the tenant). */
export async function newLease(unitId) {
  let units = [];
  try { units = await get("/api/rentroll"); } catch (e) { /* none */ }
  const vacant = units.filter(u => !u.lease_id);
  if (!units.length) { toast("Add a unit first", "bad"); return null; }
  if (!vacant.length) { toast("Every unit has an active lease. End a lease or add a unit first.", "bad"); return null; }
  const u0 = vacant.find(u => u.id === unitId) || vacant[0];
  const start = firstOfNextMonth(today());
  const v = await formModal("New lease", [
    { k: "unit_id", label: "Unit", type: "select", value: u0.id, options: vacant.map(u => ({ v: u.id, label: unitLabel(u) + (f.ok(u.market_rent) ? ` · mkt ${f.usd(u.market_rent)}` : "") })), full: true },
    { k: "tenant_name", label: "Tenant name", req: true, ph: "Full name" },
    { k: "email", label: "Email" },
    { k: "phone", label: "Phone" },
    { k: "start", label: "Start", type: "date", value: start, req: true },
    { k: "end", label: "End", type: "date", value: leaseEnd(start), req: true },
    { k: "rent", label: "Rent / mo", type: "number", value: u0.market_rent ?? "", req: true },
    { k: "deposit", label: "Deposit", type: "number", value: u0.market_rent ?? "" },
    { k: "due_day", label: "Due day", type: "number", value: 1 },
    { k: "grace_days", label: "Grace days", type: "number", value: 5 },
    { k: "late_fee", label: "Late fee", type: "number", value: 75 },
    { k: "escalation", label: "Escalation % / yr", type: "number", value: 3 },
  ], { ok: "Create lease", note: "Rent is charged on the due day each month from the start date; a late fee is charged when the month is still unpaid after the grace days. Escalation applies on each anniversary." });
  if (!v) return null;
  if (!f.ok(v.rent) || v.rent <= 0) { toast("Rent is required", "bad"); return null; }
  if (v.end && v.start && v.end <= v.start) { toast("End must be after start", "bad"); return null; }
  const { tenant_name, email, phone, ...d } = v;
  const data = { ...d, unit_id: +d.unit_id, deposit: d.deposit ?? null, due_day: Math.min(28, Math.max(1, Math.round(d.due_day || 1))),
    grace_days: d.grace_days ?? 5, late_fee: d.late_fee ?? 0, escalation: f.ok(d.escalation) ? d.escalation / 100 : 0, status: "active" };
  const r = await post("/api/portfolio", { act: "add", table: "lease", data, tenant_name, email, phone });
  toast(r.error || `Lease created for ${tenant_name}`, r.error ? "bad" : "");
  return r;
}

/** Renew: ends the lease and starts a new one the day after it ends. */
export async function renewLease(r) {
  const esc0 = f.ok(r.escalation) ? r.escalation : 0;
  const cur = f.ok(r.current_rent) && r.current_rent > 0 ? r.current_rent : r.rent;
  const sug = f.ok(cur) ? Math.round(cur * (1 + esc0)) : "";
  const st = r.end ? addDays(r.end, 1) : null;
  const v = await formModal(`Renew · ${r.tenant || "tenant"} · ${r.name || r.unit || ""}`, [
    { k: "rent", label: "New rent / mo", type: "number", value: sug, req: true },
    { k: "years", label: "Term", type: "select", value: 1, options: [{ v: 1, label: "1 year" }, { v: 2, label: "2 years" }, { v: 3, label: "3 years" }] },
  ], {
    ok: "Renew",
    note: `Current rent <b>${f.usd(cur, 2)}</b> · market <b>${f.usd(r.market_rent)}</b> · escalation ${f.pct(esc0, 1)} (suggested = current × (1 + escalation)). `
      + `The new term starts <b>${st ? f.dateY(st) : f.DASH}</b>, the day after the current end${st && st < today() ? "; rent for the months already passed is charged at the new rate" : ""}. Deposit, due day, fees and escalation carry over.`,
  });
  if (!v) return null;
  const res = await post("/api/portfolio", { act: "renew", id: r.lease_id, rent: v.rent, years: +v.years });
  toast(res.error || `Renewed through ${st ? f.dateY(leaseEnd(st, +v.years)) : ""}`, res.error ? "bad" : "");
  return res;
}

/** End a lease (the unit becomes vacant; the ledger balance stays). */
export async function endLease(r) {
  const t = today(), def = r.end && r.end < t ? t : (r.end || t);
  const bal = r.balance;
  const v = await formModal(`End lease · ${r.tenant || "tenant"} · ${r.name || r.unit || ""}`, [
    { k: "end", label: "Move-out date", type: "date", value: def, req: true },
  ], {
    ok: "End lease",
    note: `Balance ${f.ok(bal) && bal > 0.005 ? `owed <b class="down">${f.usd(bal, 2)}</b>` : f.ok(bal) && bal < -0.005 ? `in credit <b>${f.usd(-bal, 2)}</b>` : "<b>settled</b>"} · deposit held <b>${f.usd(r.deposit, 2)}</b>. `
      + `The balance stays on the Ledger; no further rent is charged. Record the deposit return or deduction there as a credit or charge.`,
  });
  if (!v) return null;
  const res = await post("/api/portfolio", { act: "end_lease", id: r.lease_id, end: v.end });
  toast(res.error || "Lease ended; unit is vacant", res.error ? "bad" : "");
  return res;
}

/** Edit the lease terms and the tenant's contact details. */
export async function editLease(r) {
  let L = {};
  try { L = (await get(`/api/ledger/${r.lease_id}`)).lease || {}; } catch (e) { /* use the row */ }
  const v = await formModal(`Edit lease · ${r.name || r.unit || ""} · ${f.street(r.address)}`, [
    { k: "tenant", label: "Tenant name", value: r.tenant || L.tenant || "", req: true },
    { k: "email", label: "Email", value: r.email || "" },
    { k: "phone", label: "Phone", value: r.phone || "" },
    { k: "start", label: "Start", type: "date", value: L.start || r.start || "" },
    { k: "end", label: "End", type: "date", value: L.end || r.end || "" },
    { k: "rent", label: "Base rent / mo", type: "number", value: L.rent ?? r.rent ?? "" },
    { k: "deposit", label: "Deposit", type: "number", value: L.deposit ?? r.deposit ?? "" },
    { k: "due_day", label: "Due day", type: "number", value: L.due_day ?? r.due_day ?? 1 },
    { k: "grace_days", label: "Grace days", type: "number", value: L.grace_days ?? 5 },
    { k: "late_fee", label: "Late fee", type: "number", value: L.late_fee ?? r.late_fee ?? 0 },
    { k: "escalation", label: "Escalation % / yr", type: "number", value: f.ok(L.escalation ?? r.escalation) ? round2((L.escalation ?? r.escalation) * 100) : 0 },
  ], { ok: "Save", note: "Base rent is the rent in the first lease year; the rent in effect now adds the escalation for each anniversary passed. Rent already charged is not changed." });
  if (!v) return null;
  const { tenant, email, phone, ...d } = v;
  d.escalation = f.ok(d.escalation) ? d.escalation / 100 : 0;
  d.due_day = Math.min(28, Math.max(1, Math.round(d.due_day || 1)));
  const a = await post("/api/portfolio", { act: "edit", table: "lease", id: r.lease_id, data: d }, { quiet: true });
  const tid = r.tenant_id ?? L.tenant_id;
  const b = tid != null ? await post("/api/portfolio", { act: "edit", table: "tenant", id: tid, data: { name: tenant, email, phone } }) : (await changed(), {});
  const err = a.error || b.error;
  toast(err || "Lease saved", err ? "bad" : "");
  return { error: err };
}

/* ---------- the page ---------- */

let fProp = "all", fStat = "all", tbl = null, last = [];
/** Open the rent roll filtered to one property (used by Portfolio). */
export const showPropertyUnits = pid => { fProp = pid == null ? "all" : String(pid); fStat = "all"; };

const cols = () => [
  { k: "address", label: "Property", l: true, fmt: (v, r) => `<a class="sym" data-prop="${r.property_id}" data-go="property" title="${esc(v)}">${esc(f.street(v))}</a>` },
  { k: "name", label: "Unit", l: true, fmt: (v, r) => `<span title="${f.ok(r.beds) ? +r.beds : f.DASH} bd · ${f.ok(r.baths) ? +r.baths : f.DASH} ba${f.ok(r.sqft) ? " · " + f.sqft(r.sqft) : ""}">${esc(v || f.DASH)}</span>` },
  { k: "tenant", label: "Tenant", l: true, fmt: v => (v ? esc(v) : `<span class="faint">${f.DASH}</span>`) },
  { k: "end", label: "Term", title: "Lease start – end (hover a cell for the exact dates)", fmt: (v, r) => (r.lease_id ? `<span title="${f.dateY(r.start)} – ${f.dateY(v)}"><span class="mut">${f.mo(r.start)} –</span> ${f.mo(v)}</span>` : f.DASH) },
  { k: "days_left", label: "Days", title: "Calendar days to the lease end; negative = past the end and still occupied (holdover)", fmt: v => (f.ok(v) ? f.int(v) : f.DASH), cls: v => daysCls(v) },
  { k: "current_rent", label: "Rent now", title: "Rent in effect this month: base rent with the annual escalation applied on each anniversary (hover a cell for the base rent)", val: r => (r.lease_id ? r.current_rent : null), fmt: (v, r) => (f.ok(v) ? `<b title="${f.usd(v, 2)} · base ${f.usd(r.rent, 2)} · escalation ${f.pct(r.escalation || 0, 1)} / yr">${f.num(v, 0)}</b>` : f.DASH) },
  { k: "market_rent", label: "Market", title: "Market rent for the unit, as you entered it", fmt: v => f.num(v, 0) },
  { k: "loss_to_lease", label: "LTL", title: "Loss to lease: market rent − rent now, per month. Positive = below market. Vacant units show their full market rent (vacancy loss).", fmt: v => (f.ok(v) ? f.num(v, 0) : f.DASH), cls: (v, r) => (!r.lease_id ? "amb" : f.ok(v) && v > 0.5 ? "amb" : "mut") },
  { k: "deposit", label: "Deposit", fmt: v => f.num(v, 0) },
  { k: "balance", label: "Balance", title: "Owed by the tenant (positive) or in credit (negative), from the ledger", val: r => (r.lease_id ? r.balance : null), fmt: v => (f.ok(v) ? (Math.abs(v) < 0.005 ? "0.00" : f.num(v, 2)) : f.DASH), cls: v => (f.ok(v) && v > 0.005 ? "down" : "") },
  { k: "state", label: "Status", l: true, val: r => leaseState(r).rank, fmt: (v, r) => { const s = leaseState(r); return `<span class="${s.cls || "mut"}">${s.label}</span>`; } },
];

const csvCols = ["property_id", "address", "name", "beds", "baths", "sqft", "tenant", "email", "phone", "start", "end", "days_left", "rent", "current_rent", "escalation", "market_rent", "loss_to_lease", "deposit", "balance", "due_day", "late_fee", "lease_id"].map(k => ({ k }))
  .concat([{ k: "status", val: r => leaseState(r).label }]);

function selectRow(r) {
  if (!r) return;
  if (r.lease_id) select({ kind: "lease", id: r.lease_id, row: r });
  else select({ kind: "unit", id: r.id, row: r });
}
const selKey = () => (S.sel?.kind === "lease" ? "l" + S.sel.id : S.sel?.kind === "unit" ? "u" + S.sel.id : null);
const rowKey = r => (r.lease_id ? "l" + r.lease_id : "u" + r.id);

/** The selected rent-roll row (a lease or a vacant unit), if it is on this page. */
const selRow = () => last.find(r => rowKey(r) === selKey()) || null;

/** Actions on the selected row, in the rent-roll panel header. */
function drawActs(root) {
  const el = root.querySelector("#rr-acts");
  if (!el) return;
  const r = selRow();
  if (!r) { el.innerHTML = `<span class="ow-hint">Select a row for lease actions</span>`; return; }
  const who = `<span class="ow-hint">${esc(f.street(r.address))} · ${esc(r.name || "")}${r.tenant ? " · " + esc(r.tenant) : ""}</span>`;
  el.innerHTML = who + (r.lease_id
    ? btn("renew", "Renew") + " " + btn("end", "End lease") + " " + btn("edit", "Edit lease") + " " + btn("edit-unit", "Edit unit", { cls: "ghost" })
      + ` <a class="btn ghost" data-go="ledger" title="Open this lease's ledger">Ledger</a>`
    : btn("lease", "New lease", { cls: "pri", attrs: `data-id="${r.id}"` }) + " " + btn("edit-unit", "Edit unit"));
}

export default {
  id: "rentroll",
  deps: ["sel"],
  async render(root, ctx) {
    root.classList.add("ow");
    if (ctx.reason === "sel" && tbl && root.querySelector("#rr-acts")) { tbl.setSel(selKey()); drawActs(root); return; }
    let all = [], props = [], tenants = [];
    try { [all, props] = await Promise.all([get("/api/rentroll"), ownedProps()]); } catch (e) { root.innerHTML = panel({ title: "Rent roll", body: `<div class="note">The rent roll did not load: ${esc(e.message)}</div>` }); return; }
    try { tenants = await get("/api/tenants"); } catch (e) { tenants = []; }
    if (fProp !== "all" && !props.some(p => String(p.id) === String(fProp))) fProp = "all";

    const inProp = all.filter(r => fProp === "all" || String(r.property_id) === String(fProp));
    const rows = inProp.filter(r => {
      const s = leaseState(r).label;
      return fStat === "all" || (fStat === "occupied" && r.lease_id) || (fStat === "vacant" && isVacant(r))
        || (fStat === "expiring" && (s === "Expiring" || s === "Holdover" || s === "Notice"));
    }).map(r => ({ ...r, key: rowKey(r) }));

    // ---- command bar
    const nExp = inProp.filter(r => r.lease_id && f.ok(r.days_left) && r.days_left <= 90).length;
    ctx.sub.innerHTML = (props.length > 1 ? selectBox("prop", [{ v: "all", label: "All properties" }, ...props.map(p => ({ v: p.id, label: f.street(p.address) }))], fProp) + sep() : "")
      + chips("stat", [{ v: "all", label: "All", sub: inProp.length }, { v: "occupied", label: "Leased", sub: inProp.filter(r => r.lease_id).length },
        { v: "vacant", label: "Vacant", sub: inProp.filter(isVacant).length }, { v: "expiring", label: "Expiring", title: "Lease ends within 90 days, or already past its end", sub: nExp }], fStat);
    ctx.bar.innerHTML = btn("add-unit", "+ Unit", { title: "Add a unit to an owned property" }) + btn("new-lease", "New lease", { cls: "pri", title: "Lease a vacant unit" }) + btn("csv", "CSV", { title: "Export the rows shown" });
    bind(ctx.sub, { "change:prop": v => { fProp = v; this.render(root, { ...ctx, reason: "prefs" }); }, "chip:stat": v => { fStat = v; this.render(root, { ...ctx, reason: "prefs" }); } });
    bind(ctx.bar, {
      "act:add-unit": () => addUnit(fProp !== "all" ? +fProp : undefined),
      "act:new-lease": () => newLease(),
      "act:csv": () => csv(`valora-rent-roll-${today()}.csv`, csvCols, tbl ? tbl.view() : rows),
    });

    // ---- empty workspace
    if (!all.length) {
      tbl = null;
      ctx.sub.innerHTML = "";
      ctx.bar.innerHTML = props.length ? btn("add-unit", "+ Unit", { title: "Add a unit to an owned property" }) : "";
      root.innerHTML = panel({
        title: "Rent roll", sub: props.length ? `${props.length} owned propert${props.length === 1 ? "y" : "ies"} · no units yet` : "nothing owned yet",
        body: props.length
          ? `<div class="empty"><b>No units yet</b><span>Add each rentable unit (a single-family house is one unit), then lease it.<br>Leases can also be read from PDFs dropped on <a class="link" data-go="inbox">Inbox</a>.</span><span>${btn("add-unit", "+ Unit", { cls: "pri" })}</span></div>`
          : `<div class="empty"><b>No owned properties</b><span>Add one on <a class="link" data-go="portfolio">Portfolio</a>, mark a deal acquired on <a class="link" data-go="pipeline">Pipeline</a>, or drop a lease or mortgage statement on <a class="link" data-go="inbox">Inbox</a>.</span></div>`,
      });
      bind(root, { "act:add-unit": () => addUnit() });
      return;
    }

    // ---- headline figures (for the property filter, all statuses)
    const leased = inProp.filter(r => r.lease_id);
    const knownOccupancy = leased.length + inProp.filter(isVacant).length;
    const sum = (a, fn) => a.reduce((s, r) => s + (f.ok(fn(r)) ? +fn(r) : 0), 0);
    const sched = sum(leased, r => r.current_rent), mkt = sum(inProp, r => r.market_rent), mktLeased = sum(leased, r => r.market_rent);
    const ltl = sum(leased.filter(r => f.ok(r.market_rent)), r => r.market_rent - r.current_rent);
    const vac = sum(inProp.filter(isVacant), r => r.market_rent);
    const owed = sum(leased, r => Math.max(0, r.balance || 0)), credit = sum(leased, r => Math.min(0, r.balance || 0));
    const deps = sum(leased, r => r.deposit);
    const wl = leased.filter(r => f.ok(r.days_left) && f.ok(r.current_rent));
    const walt = wl.length ? sum(wl, r => Math.max(0, r.days_left) * r.current_rent) / sum(wl, r => r.current_rent) / 30.44 : null;
    const hold = leased.filter(r => f.ok(r.days_left) && r.days_left < 0).length;

    const head = kv([
      { k: "Occupancy", v: f.pct(knownOccupancy ? leased.length / knownOccupancy : null, 0), sub: knownOccupancy ? `${leased.length} of ${knownOccupancy} confirmed units` : "Occupancy unconfirmed" },
      { k: "Rent / mo", v: f.usd(sched), title: "Scheduled rent: rent in effect this month on every active lease" },
      { k: "Market / mo", v: f.usd(mkt), title: "Sum of the market rent you entered for every unit, leased or vacant" },
      { k: "Loss to lease", v: f.usd(ltl), sub: mktLeased ? f.pct(ltl / mktLeased, 1) : "", cls: ltl > 0.5 ? "amb" : "", title: "Market − rent now on leased units, per month" },
      { k: "Vacancy / mo", v: f.usd(vac), cls: vac > 0 ? "amb" : "", title: "Market rent of vacant units, per month" },
      { k: "Deposits", v: f.usd(deps), title: "Security deposits held on active leases" },
      { k: "Owed", v: f.usd(owed), cls: owed > 0.005 ? "down" : "", title: `Positive tenant balances from the ledger${credit < -0.005 ? `; tenants in credit: ${f.usd(-credit, 2)}` : ""}` },
    ], { cls: "tight" });

    if (!root.querySelector("#rr-tbl")) {
      root.innerHTML = `<section class="pnl"><div class="ph"><h3>Units and leases</h3><span class="s" id="rr-sub"></span><div class="r" id="rr-acts"></div></div><div id="rr-kv"></div><div id="rr-tbl"></div></section>
        <div class="cols2">
          ${panel({ title: "Expiry schedule", sub: "rent now ending per month · next 12", flush: true, body: `<div id="rr-exp" class="ow-chart"></div>` })}
          ${panel({ title: "Vacant units", flush: true, body: `<div id="rr-vac"></div>` })}
        </div>
        ${panel({ title: "Past leases", sub: "ended or renewed · from the tenant records", flush: true, body: `<div id="rr-past"></div>` })}`;
    }
    const nm = fProp === "all" ? `${props.length} propert${props.length === 1 ? "y" : "ies"}` : esc(props.find(p => String(p.id) === String(fProp))?.address || "");
    root.querySelector("#rr-sub").innerHTML = `${nm} · as of ${f.dateY(today())} · balances from the ledger${S.state?.demo ? ` · <span class="tag amb">Demo data</span>` : ""}`;
    root.querySelector("#rr-kv").innerHTML = head;

    tbl = table(root.querySelector("#rr-tbl"), {
      id: "rentroll", rows, cols: cols(), key: r => r.key, sel: selKey(), sort: { k: "address", dir: 1 },
      empty: fStat === "vacant" ? "No vacant units" : fStat === "expiring" ? "No lease ends within 90 days" : "No units match",
      onRow: r => selectRow(r),
      foot: `${rows.length} unit${rows.length === 1 ? "" : "s"} · WALT ${walt == null ? f.DASH : f.num(walt, 1) + " mo"}${hold ? ` (${hold} holdover${hold === 1 ? "" : "s"} at 0)` : ""} · rent now ${f.usd(sum(rows.filter(r => r.lease_id), r => r.current_rent), 2)} / mo · deposits ${f.usd(sum(rows.filter(r => r.lease_id), r => r.deposit))} · balances ${f.usd(sum(rows.filter(r => r.lease_id), r => r.balance), 2)}`,
    });
    last = all;
    drawActs(root);
    bind(root, {
      "act:renew": () => { const r = selRow(); if (r?.lease_id) renewLease(r); },
      "act:end": () => { const r = selRow(); if (r?.lease_id) endLease(r); },
      "act:edit": () => { const r = selRow(); if (r) (r.lease_id ? editLease(r) : editUnit(r)); },
      "act:edit-unit": () => { const r = selRow(); if (r) editUnit(r); },
      "act:lease": el => newLease(el.dataset.id ? +el.dataset.id : selRow()?.id),
      "act:add-unit": () => addUnit(fProp !== "all" ? +fProp : undefined),
    });

    // ---- expiry schedule: rent now on leases ending each month (holdovers in the first bar)
    const t0 = ymd(today()), months = [];
    for (let i = 0; i < 12; i++) months.push(iso(t0.y, t0.m + i, 1).slice(0, 7));
    const holdRent = sum(leased.filter(r => f.ok(r.days_left) && r.days_left < 0), r => r.current_rent);
    const cats = ["Over", ...months.map(m => f.mo(m))];
    const vals = [holdRent, ...months.map(m => sum(leased.filter(r => r.end && r.end.slice(0, 7) === m && r.days_left >= 0), r => r.current_rent))];
    const expEl = root.querySelector("#rr-exp");
    if (vals.some(v => v > 0)) {
      C.bars(expEl, { h: 190, cats, series: [{ name: "Rent now / mo", vals: vals.map(v => v || null), color: "acc" }], y: { fmt: v => f.cusd(v) } });
    } else expEl.innerHTML = `<div class="empty"><span>No lease ends in the next 12 months</span></div>`;

    // ---- vacant units with days since the last lease ended
    const lastEnd = new Map();
    for (const t of tenants) {
      if (t.status !== "ended" || !t.end) continue;
      const k = `${t.address}|${t.unit}`;
      if (!lastEnd.has(k) || lastEnd.get(k) < t.end) lastEnd.set(k, t.end);
    }
    const vacRows = inProp.filter(isVacant).map(r => {
      const le = lastEnd.get(`${r.address}|${r.name}`) || null;
      return { ...r, key: "v" + r.id, last_end: le, days_vacant: le ? Math.max(0, Math.round((Date.parse(today()) - Date.parse(le)) / 864e5)) : null };
    });
    table(root.querySelector("#rr-vac"), {
      id: "rr-vac", rows: vacRows, key: r => r.key, nav: false, maxH: 210, sort: { k: "days_vacant", dir: -1 },
      cols: [
        { k: "address", label: "Property", l: true, fmt: v => esc(f.street(v)) },
        { k: "name", label: "Unit", l: true },
        { k: "market_rent", label: "Market / mo", fmt: v => f.usd(v) },
        { k: "days_vacant", label: "Vacant", title: "Days since the last recorded lease ended; — when no earlier lease is on file", fmt: (v, r) => (f.ok(v) ? `<span title="last lease ended ${f.dateY(r.last_end)}">${v}d</span>` : f.DASH), cls: v => (f.ok(v) && v > 30 ? "amb" : "") },
        { k: "act", label: "", sort: false, fmt: (v, r) => btn("lease", "Lease", { attrs: `data-id="${r.id}"` }) },
      ],
      empty: "No confirmed vacancies", onRow: r => selectRow(r),
    });

    // ---- past leases
    const inPropAddr = new Set(inProp.map(r => r.address));
    const past = tenants.filter(t => t.lease_id && t.status === "ended" && inPropAddr.has(t.address)).map(t => ({ ...t, key: "p" + t.lease_id }));
    table(root.querySelector("#rr-past"), {
      id: "rr-past", rows: past, key: r => r.key, nav: false, maxH: 220, sort: { k: "end", dir: -1 },
      cols: [
        { k: "address", label: "Property", l: true, fmt: v => esc(f.street(v)) },
        { k: "unit", label: "Unit", l: true },
        { k: "name", label: "Tenant", l: true },
        { k: "start", label: "Start", fmt: v => f.dateY(v) },
        { k: "end", label: "End", fmt: v => f.dateY(v) },
        { k: "rent", label: "Base rent", fmt: v => f.usd(v) },
        { k: "lease_id", label: "Lease", fmt: v => `<span class="faint">#${v}</span>` },
      ],
      empty: "No ended leases on file", onRow: r => select({ kind: "lease", id: r.lease_id, row: { ...r, tenant: r.name } }),
    });
  },
  key(e) {
    if (e.key === "n" && !e.metaKey && !e.ctrlKey) { newLease(); return true; }
    return false;
  },
};
