// Portfolio — the owner's dashboard: what the properties are worth, what they owe, what they earned over the
// trailing twelve months, the monthly operating history, lease expiries and the equity in each property.
import { S, f, get, post, select, esc, today, go } from "../core.js";
import { table, panel, kv, btn, bind, toast, formModal, confirmModal, csv, src, useCss } from "../ui.js";
import * as C from "../charts.js";
import { renewLease, endLease, daysCls, showPropertyUnits } from "./rentroll.js";

useCss("portfolio");

const TYPES = ["Single Family", "Multi-Family", "Condo", "Townhouse", "Manufactured", "Land", "Other"];

/** Provenance kind for a value source string: entered by you, assumed, or an estimate. */
const srcKind = s => (/your|manual|entered/i.test(s || "") ? "m" : /^purchase price$/i.test(s || "") ? "x" : "e");

export async function addOwnedFromAddress(property = null) {
  const currency = S.state?.config?.currency || "USD";
  while (true) {
    const v = await formModal(property ? "Mark as owned" : "Add an owned property", [
      ...(property ? [] : [{ k: "address", label: "Property address", ph: "Street, unit, city, region, country", req: true, full: true }]),
      { k: "monthly_mortgage", label: `Monthly mortgage payment (${currency})`, type: "number", req: true, full: true },
    ], { ok: "Add to portfolio", note: `${property ? esc(property.address) + " · " : ""}Enter 0 if there’s no mortgage. InvestStack pulls available municipal facts automatically.` });
    if (!v) return null;
    if (!Number.isFinite(v.monthly_mortgage) || v.monthly_mortgage < 0) {
      toast("Enter a valid non-negative monthly mortgage payment", "bad");
      continue;
    }
    const r = await post("/api/portfolio", { act: "add_owned_address", property_id: property?.id,
      address: v.address, monthly_mortgage: v.monthly_mortgage });
    toast(r.error || ["Added to the portfolio", ...(r.notes || [])].join(" · "), r.error ? "bad" : "");
    return r;
  }
}

/** Add an owned property: a new address, or the selected property when it is not owned yet. */
export async function addOwned() {
  if (!S.state?.demo) return addOwnedFromAddress();
  const cand = S.prop?.property && !S.prop.property.owned ? S.prop.property : null;
  const fields = [
    ...(cand ? [{ k: "which", label: "Property", type: "select", value: "sel", full: true, options: [{ v: "sel", label: `Selected: ${cand.address}` }, { v: "new", label: "A new address (enter it below)" }] }] : []),
    { k: "street", label: "Street address", full: true, ph: "123 Main St" },
    { k: "city", label: "City" }, { k: "state", label: "State", value: "OH" }, { k: "zip", label: "ZIP" },
    { k: "type", label: "Type", type: "select", value: "Single Family", options: TYPES },
    { k: "units", label: "Units", type: "number", value: 1 },
    { k: "beds", label: "Beds (total)", type: "number" }, { k: "baths", label: "Baths (total)", type: "number" },
    { k: "sqft", label: "Sq ft", type: "number" }, { k: "year_built", label: "Year built", type: "number" },
    { k: "purchase_price", label: "Purchase price", type: "number", req: true },
    { k: "purchase_date", label: "Purchase date", type: "date", req: true },
    { k: "closing_costs", label: "Closing costs", type: "number" }, { k: "rehab", label: "Rehab", type: "number" },
    { k: "value_est", label: "Current value (optional)", type: "number", ph: "your estimate" },
    { k: "mk_units", label: "Create units", type: "select", value: "yes", options: [{ v: "yes", label: "Yes, one per unit (vacant)" }, { v: "no", label: "No, I will add them" }] },
  ];
  const v = await formModal("Add an owned property", fields, {
    ok: "Add to portfolio",
    note: "Faster from files: drop a closing statement, mortgage statement or lease on <b>Inbox</b> and confirm what it read. Without a current value the portfolio uses the latest estimate on file, then purchase price × the ZIP home value index since purchase.",
  });
  if (!v) return null;
  let pid = v.which === "sel" && cand ? cand.id : null, units = cand && v.which === "sel" ? cand.units : v.units;
  if (pid == null) {
    if (!v.street || !v.city || !v.zip) { toast("Street, city and ZIP are needed for a new property", "bad"); return null; }
    const a = await post("/api/property/add", {
      address: `${v.street}, ${v.city}, ${v.state || ""} ${v.zip}`.replace(/\s+/g, " ").trim(), city: v.city, state: v.state, zip: v.zip,
      type: v.type, units: v.units || 1, beds: v.beds, baths: v.baths, sqft: v.sqft, year_built: v.year_built,
    }, { quiet: true });
    if (a.error || a.id == null) { toast(a.error || "The property could not be added", "bad"); return null; }
    pid = a.id;
  }
  const data = { property_id: pid, purchase_price: v.purchase_price, purchase_date: v.purchase_date, closing_costs: v.closing_costs || 0, rehab: v.rehab || 0 };
  if (f.ok(v.value_est)) Object.assign(data, { value_est: v.value_est, value_src: `your estimate ${today()}` });
  const r = await post("/api/portfolio", { act: "add", table: "owned", data }, { quiet: v.mk_units === "yes" });
  if (r.error) { toast(r.error, "bad"); return r; }
  if (v.mk_units === "yes") {
    const n = Math.max(1, Math.min(50, Math.round(units || 1)));
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      await post("/api/portfolio", { act: "add", table: "unit", data: { property_id: pid, name: n === 1 ? "Unit 1" : `Unit ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ""}`, status: "vacant" } }, { quiet: !last });
    }
  }
  toast(`Added to the portfolio${v.mk_units === "yes" ? "; set market rents and leases on Rent roll" : ""}`);
  return r;
}

/** Edit purchase facts and your own value for an owned property; or take it out of the portfolio. */
async function editOwned(p) {
  const mine = /^your/i.test(p.value_src || "");
  const v = await formModal(`Ownership · ${f.street(p.address)}`, [
    { k: "purchase_price", label: "Purchase price", type: "number", value: p.purchase_price ?? "" },
    { k: "purchase_date", label: "Purchase date", type: "date", value: p.purchase_date || "" },
    { k: "closing_costs", label: "Closing costs", type: "number", value: p.closing_costs ?? "" },
    { k: "rehab", label: "Rehab", type: "number", value: p.rehab ?? "" },
    { k: "value_est", label: "Your value (blank = use estimates)", type: "number", value: mine ? p.value : "", full: true },
  ], { ok: "Save", danger: "Remove from portfolio", note: `Value now: <b>${f.usd(p.value)}</b> · ${esc(p.value_src || "no source")}` });
  if (!v) return;
  if (v.__danger) {
    if (!(await confirmModal("Remove from portfolio", `Take <b>${esc(p.address)}</b> out of the portfolio? Its units, leases, ledger, loans and expenses stay in the database and come back if you add it again.`, "Remove"))) return;
    const r = await post("/api/portfolio", { act: "delete", table: "owned", id: p.id });
    toast(r.error || "Removed from the portfolio", r.error ? "bad" : "");
    return;
  }
  const data = { purchase_price: v.purchase_price, purchase_date: v.purchase_date || null, closing_costs: v.closing_costs || 0, rehab: v.rehab || 0,
    value_est: f.ok(v.value_est) ? v.value_est : null, value_src: f.ok(v.value_est) ? (mine && v.value_est === p.value ? p.value_src : `your estimate ${today()}`) : null };
  const r = await post("/api/portfolio", { act: "edit", table: "owned", id: p.id, data });
  toast(r.error || "Saved", r.error ? "bad" : "");
}

const propCols = [
  { k: "address", label: "Property", l: true, fmt: (v, r) => `<a class="sym" data-prop="${r.id}" data-go="property" title="${esc(v)}">${esc(f.street(v))}</a>` },
  { k: "units_n", label: "Units", title: "Occupied / total units", fmt: (v, r) => (f.ok(v) && v ? `${f.int(r.occupied)}/${f.int(v)}` : f.DASH), cls: (v, r) => (v && r.occupied < v ? "amb" : "") },
  { k: "value", label: "Value", title: "Current value; the source is in the next column", fmt: v => f.cusd(v) },
  { k: "value_src", label: "Source", l: true, sort: false, fmt: v => (v ? `<span title="${esc(v)}">${src(v.replace(/\s*\d{4}-\d\d-\d\d$/, "").replace(/^DEMO estimate$/, "DEMO est."), srcKind(v))}</span>` : `<span class="faint">${f.DASH}</span>`) },
  { k: "budget_net_month", label: "Net / mo", title: "Budgeted rent minus listed expenses and mortgage",
    fmt: v => f.susd(v, v % 1 ? 2 : 0), cls: f.cls },
  { k: "gain", label: "Gain", title: "Value − (purchase price + closing + rehab)", fmt: v => f.susd(v), cls: v => f.cls(v) },
  { k: "equity", label: "Equity", title: "Value − loan balances", fmt: v => f.cusd(v) },
  { k: "ltv", label: "LTV", fmt: v => f.pct(v, 0) },
  { k: "noi", label: "NOI ttm", title: "Rent collected − operating expenses, trailing 12 months, from the ledger and expenses", fmt: v => f.usd(v) },
  { k: "cf", label: "Cash flow", title: "NOI ttm − scheduled debt service (P&I)", fmt: v => f.susd(v), cls: v => f.cls(v) },
  { k: "cap_on_value", label: "Cap", title: "NOI ttm / current value", fmt: v => f.pct(v, 1) },
  { k: "dscr", label: "DSCR", title: "NOI ttm / annual P&I", fmt: v => f.x(v), cls: v => (f.ok(v) && v < 1 ? "down" : f.ok(v) && v < 1.25 ? "amb" : "") },
  { k: "arrears", label: "Owed", title: "Rent owed by current tenants", fmt: v => (f.ok(v) && v > 0.005 ? f.usd(v) : "0"), cls: v => (f.ok(v) && v > 0.005 ? "down" : "mut") },
];

const csvCols = ["id", "address", "type", "units_n", "occupied", "purchase_date", "purchase_price", "cost", "value", "value_src", "gain", "debt", "equity", "ltv", "income", "opex", "noi", "ds", "cf", "budget_net_month", "cap_on_value", "dscr", "rent_roll", "arrears"].map(k => ({ k }));

let ptbl = null;

function emptyState(root) {
  root.innerHTML = `<section class="pnl"><div class="ph"><h3>Nothing owned yet</h3><span class="s">value, debt, equity, rent and cash flow appear here once you own something</span></div>
    <div class="ow-ways">
      <div><b>1 · Drop files</b><span>Drop a closing statement, mortgage statement, lease or bank CSV on the window. InvestStack reads them and proposes the property, the loan, the tenants and the rent payments for you to confirm.</span>${btn("inbox", "Open Inbox")}</div>
      <div><b>2 · Mark a deal acquired</b><span>Move a deal to <i>Acquired</i> on the pipeline. The property, its purchase price and the underwriting come with it.</span>${btn("pipeline", "Open Pipeline")}</div>
      <div><b>3 · Add by hand</b><span>Enter the address, purchase price and date. Units are created for you; loans go on Books, leases on Rent roll.</span>${btn("add", "Add a property", { cls: "pri" })}</div>
    </div></section>`;
  bind(root, { "act:add": () => addOwned(), "act:inbox": () => go("inbox"), "act:pipeline": () => go("pipeline") });
}

export default {
  id: "portfolio",
  deps: ["sel"],
  async render(root, ctx) {
    root.classList.add("ow");
    if (ctx.reason === "sel" && ptbl) { ptbl.setSel(S.sel?.kind === "property" ? S.sel.id : null); return; }
    let d;
    try { d = await get("/api/portfolio"); } catch (e) { root.innerHTML = panel({ title: "Portfolio", body: `<div class="note">The portfolio did not load: ${esc(e.message)}</div>` }); return; }
    const props = d.properties || [], t = d.total || {};

    ctx.bar.innerHTML = btn("add", "+ Property", { title: "Add a property you own" }) + (props.length ? btn("csv", "CSV", { title: "Export the properties table" }) : "");
    bind(ctx.bar, { "act:add": () => addOwned(), "act:csv": () => csv(`valora-portfolio-${today()}.csv`, csvCols, props) });
    ctx.sub.innerHTML = props.length ? `<span class="ow-hint">${props.length} propert${props.length === 1 ? "y" : "ies"} · ${f.int(t.units)} units · trailing 12 months to ${f.dateY(today())}</span>` : "";

    if (!props.length) { ptbl = null; emptyState(root); return; }

    if (!root.querySelector("#pf-props")) {
      root.innerHTML = `<section class="pnl"><div class="ph"><h3>Position</h3><span class="s" id="pf-sub"></span></div><div id="pf-kv"></div></section>
        <section class="pnl"><div class="ph"><h3>Monthly operations</h3><span class="s" id="pf-msub"></span></div><div id="pf-chart" class="ow-chart"></div><div id="pf-cmp"></div></section>
        ${panel({ title: "Properties", sub: "double-click a row to open the property", right: `<span id="pf-acts"></span>`, flush: true, body: `<div id="pf-props"></div>` })}
        <div class="cols2 w32">
          ${panel({ title: "Lease expiries", sub: "next 90 days and holdovers", flush: true, body: `<div id="pf-exp"></div>` })}
          ${panel({ title: "Equity and debt", sub: "by property", flush: true, body: `<div id="pf-eq" class="ow-chart"></div>` })}
        </div>`;
    }

    // ---- headline position
    const vsrc = [...new Set(props.map(p => (p.value_src || "").replace(/\s*\d{4}-\d\d-\d\d$/, "")).filter(Boolean))];
    const demo = props.some(p => p.source === "DEMO" || /DEMO/.test(p.value_src || ""));
    root.querySelector("#pf-sub").innerHTML = `values: ${esc(vsrc.join(" · ") || "none on file")} · NOI and cash flow from collected rent and recorded expenses${demo ? ` · <span class="tag amb">Demo data</span>` : ""}`;
    root.querySelector("#pf-kv").innerHTML = kv([
      { k: "Value", v: f.cusd(t.value), sub: `cost ${f.cusd(t.cost)}`, title: "Sum of current values (sources in the properties table)" },
      { k: "Debt", v: f.cusd(t.debt), sub: `LTV ${f.pct(t.ltv, 0)}`, title: "Loan balances from the amortisation schedules on Books; DSCR = NOI ttm / annual P&I" },
      { k: "Equity", v: f.cusd(t.equity), sub: f.ok(t.cost) && t.cost ? `gain ${f.susd(t.value - t.cost)}` : "" },
      { k: "NOI ttm", v: f.usd(t.noi), sub: `cap ${f.pct(t.cap, 1)}`, title: "Rent collected − operating expenses, trailing 12 months; cap = NOI / value" },
      { k: "Cash flow", v: f.susd(t.cf), cls: f.cls(t.cf), sub: `ttm · DSCR ${f.x(t.dscr)}`, title: `NOI − scheduled P&I (${f.usd(t.ds)} / yr) over the trailing 12 months = ${f.susd(f.ok(t.cf) ? t.cf / 12 : null)} / mo. DSCR = NOI / P&I.` },
      { k: "Occupancy", v: f.pct(t.occupancy, 0), sub: `${f.int(t.occupied)} / ${f.int(t.units)} units`, title: `Units with an active lease; rent in effect this month ${f.usd(t.rent_roll)}` },
      { k: "Rent owed", v: f.usd(t.arrears), cls: t.arrears > 0.005 ? "down" : "", sub: t.arrears > 0.005 ? `<a class="link" data-go="ledger">ledger</a>` : "all paid", title: "Positive balances on current leases" },
    ]);

    // ---- monthly chart: income, opex, debt service, cash flow (24 complete months + the current month to date)
    const mo = d.monthly || [];
    const cats = mo.map(m => m.month), cur = today().slice(0, 7);
    const ser = (k, name, color, extra = {}) => ({ name, color, pts: mo.map(m => [m.month, f.ok(m[k]) ? m[k] : null]), ...extra });
    root.querySelector("#pf-msub").innerHTML = `collected rent, operating expenses and scheduled P&I by month${cats.includes(cur) ? ` · ${f.mo(cur)} is month to date` : ""}`;
    if (mo.length > 1 && mo.some(m => m.income || m.opex || m.debt)) {
      C.line(root.querySelector("#pf-chart"), {
        h: 230, legend: true, x: { type: "cat", cats, fmt: m => f.mo(m) }, y: { fmt: v => f.cusd(v) },
        series: [ser("income", "Rent collected", "acc"), ser("opex", "Operating expenses", "amber"), ser("debt", "Debt service (P&I)", "violet", { dash: true }),
          ser("cf", "Cash flow", "tx", { width: 1.9 })],
      });
    } else root.querySelector("#pf-chart").innerHTML = `<div class="empty"><span>No rent or expenses recorded yet. Record payments on Ledger or import a bank CSV on Inbox.</span></div>`;

    // the latest 12 months (the current one to date) vs the 12 before: the 24 months the chart shows
    const L12 = mo.slice(-12), P12 = mo.slice(-24, -12);
    const S_ = (a, k) => a.reduce((s, m) => s + (m[k] || 0), 0);
    const cmpEl = root.querySelector("#pf-cmp");
    if (L12.length === 12 && P12.length === 12) {
      const row = (lab, k, good = 1) => {
        const a = S_(L12, k), b = S_(P12, k), ch = b ? (a - b) / Math.abs(b) : null;
        return `<span class="l">${lab}</span><span>${f.usd(a)}</span><span class="mut">${f.usd(b)}</span><span class="${f.ok(ch) && Math.abs(ch) >= 0.0005 ? (ch * good > 0 ? "up" : "down") : "mut"}">${f.spct(ch, 1)}</span>`;
      };
      cmpEl.innerHTML = `<div class="ow-cmp"><span class="h l">12 months vs the 12 before</span><span class="h">${f.mo(L12[0].month)} – ${f.mo(L12[11].month)}${L12[11].month === cur ? "*" : ""}</span><span class="h">${f.mo(P12[0].month)} – ${f.mo(P12[11].month)}</span><span class="h">Change</span>`
        + row("Rent collected", "income") + row("Operating expenses", "opex", -1) + row("NOI", "noi") + row("Debt service (P&I)", "debt", -1) + row("Cash flow", "cf") + `</div>`
        + (L12[11].month === cur ? `<div class="ow-fn">* ${f.mo(cur)} is month to date. Monthly sums by calendar month; the NOI ttm figure above uses the 365 days to today, so the two differ slightly.</div>` : "");
    } else cmpEl.innerHTML = "";

    // ---- properties
    ptbl = table(root.querySelector("#pf-props"), {
      id: "pf-props", rows: props.map(p => ({ ...p, key: p.id })), cols: propCols, key: r => r.id, sel: S.sel?.kind === "property" ? S.sel.id : null, sort: { k: "value", dir: -1 },
      onRow: r => { select({ kind: "property", id: r.id, row: r }); drawActs(); }, onDbl: r => go("property", r.id),
      foot: `Totals · value ${f.usd(t.value)} · debt ${f.usd(t.debt)} · equity ${f.usd(t.equity)} · NOI ${f.usd(t.noi)} · cash flow ${f.susd(t.cf)} · rent roll ${f.usd(t.rent_roll)} / mo`,
    });
    const drawActs = () => {
      const p = props.find(x => S.sel?.kind === "property" && x.id === S.sel.id);
      root.querySelector("#pf-acts").innerHTML = p ? `<span class="ow-hint">${esc(f.street(p.address))}</span>${btn("own", "Ownership and value")} ${btn("units", "Units", { cls: "ghost" })}` : `<span class="ow-hint">Select a row to edit purchase facts or set your own value</span>`;
    };
    drawActs();

    // ---- lease expiries
    const exp = (d.expiring || []).map(e => ({ ...e, key: e.lease_id }));
    table(root.querySelector("#pf-exp"), {
      id: "pf-exp", rows: exp, key: r => r.key, nav: false, maxH: 260, sort: { k: "days", dir: 1 },
      cols: [
        { k: "address", label: "Unit", l: true, fmt: (v, r) => `<span class="lg-memo" title="${esc(v)} · ${esc(r.unit || "")} · base rent ${f.usd(r.rent)}">${esc(f.street(v))} <span class="mut">· ${esc(r.unit || "")}</span></span>` },
        { k: "tenant", label: "Tenant", l: true, fmt: v => `<span class="lg-memo" style="max-width:110px">${esc(v || f.DASH)}</span>` },
        { k: "end", label: "Ends", fmt: v => f.dateY(v) },
        { k: "days", label: "Days", title: "Negative = past the end, still in the unit (holdover)", fmt: v => f.int(v), cls: v => daysCls(v) },
        { k: "act", label: "", sort: false, fmt: (v, r) => `${btn("renew", "Renew", { attrs: `data-lease="${r.lease_id}"` })} ${btn("end", "End", { cls: "ghost", attrs: `data-lease="${r.lease_id}"` })}` },
      ],
      empty: "No lease ends in the next 90 days", onRow: r => select({ kind: "lease", id: r.lease_id, row: r }),
    });

    // ---- equity vs debt by property
    const eqEl = root.querySelector("#pf-eq");
    const sorted = props.slice().sort((a, b) => (b.value || 0) - (a.value || 0));
    if (sorted.some(p => f.ok(p.value))) {
      C.bars(eqEl, {
        horizontal: true, stacked: true, cats: sorted.map(p => f.street(p.address)), legend: true,
        series: [{ name: "Equity", vals: sorted.map(p => (f.ok(p.equity) ? p.equity : null)), color: "acc" }, { name: "Debt", vals: sorted.map(p => p.debt || null), color: "mut" }],
        y: { fmt: v => f.cusd(v) }, onClick: (c, j) => select({ kind: "property", id: sorted[j].id, row: sorted[j] }),
      });
    } else eqEl.innerHTML = `<div class="empty"><span>No values on file. Set your own value from the properties table.</span></div>`;

    // lease rows for renew / end come from the rent roll (it has current rent, balance, deposit)
    const leaseRow = async id => {
      try { return (await get("/api/rentroll")).find(u => String(u.lease_id) === String(id)) || null; } catch (e) { return null; }
    };
    bind(root, {
      "act:units": () => { const p = props.find(x => S.sel?.kind === "property" && x.id === S.sel.id); if (p) { showPropertyUnits(p.id); go("rentroll"); } },
      "act:own": () => { const p = props.find(x => S.sel?.kind === "property" && x.id === S.sel.id); if (p) editOwned(p); },
      "act:renew": async el => { const r = await leaseRow(el.dataset.lease); if (r) renewLease(r); else toast("That lease is no longer active", "bad"); },
      "act:end": async el => { const r = await leaseRow(el.dataset.lease); if (r) endLease(r); else toast("That lease is no longer active", "bad"); },
    });
  },
};
