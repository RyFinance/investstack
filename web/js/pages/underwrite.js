// Underwrite — the financial model for the selected property: Rental hold, BRRRR and Flip.
// Inputs on the left are prefilled from the property profile (gold outline = came from data, tooltip names the
// source); anything the user types is kept per property in module state (and localStorage) so re-renders and
// data events never wipe it. Every change recalculates through api("/api/underwrite") — a pure calculation, no write.
import { S, f, api, get, post, pref, load, save, esc, openExternal, streetView } from "../core.js";
import { table, panel, kv, chips, btn, sep, selectBox, bind, toast, formModal, csv, heat, parseNum, useCss, debounce } from "../ui.js";
import * as C from "../charts.js";

useCss("underwrite");

/* ---------- input definitions (display units: usd = dollars, pct = percent typed as 7.25, n = plain number) ---------- */

const RENTAL = [
  ["Purchase", [
    { k: "price", label: "Purchase price", t: "usd" },
    { k: "closing", label: "Closing costs (% price)", t: "pct" },
    { k: "rehab", label: "Rehab at purchase", t: "usd" },
  ]],
  ["Income", [
    { k: "rent_month", label: "Gross rent / mo", t: "usd" },
    { k: "other_income_month", label: "Other income / mo", t: "usd" },
    { k: "vacancy", label: "Vacancy & credit loss", t: "pct" },
  ]],
  ["Expenses", [
    { k: "taxes_year", label: "Property tax / yr", t: "usd" },
    { k: "insurance_year", label: "Insurance / yr", t: "usd" },
    { k: "hoa_month", label: "HOA / mo", t: "usd" },
    { k: "utilities_month", label: "Owner utilities / mo", t: "usd" },
    { k: "other_exp_year", label: "Other opex / yr", t: "usd" },
    { k: "mgmt", label: "Management (% EGI)", t: "pct" },
    { k: "maint", label: "Repairs (% rent)", t: "pct" },
    { k: "capex", label: "Capex reserve (% rent)", t: "pct" },
  ]],
  ["Financing", [
    { k: "down", label: "Down payment", t: "pct" },
    { k: "rate", label: "Interest rate", t: "pct" },
    { k: "years", label: "Amortisation (yrs)", t: "n" },
    { k: "io", label: "Interest only", t: "bool" },
  ]],
  ["Growth & exit", [
    { k: "rent_growth", label: "Rent growth / yr", t: "pct" },
    { k: "exp_growth", label: "Expense growth / yr", t: "pct" },
    { k: "appreciation", label: "Appreciation / yr", t: "pct" },
    { k: "exit_cap", label: "Exit cap (blank: apprec.)", t: "pct", opt: true },
    { k: "hold", label: "Hold (yrs)", t: "n" },
    { k: "sell_cost", label: "Selling costs", t: "pct" },
  ]],
];

const BRRRR = [
  ["Buy & rehab", [
    { k: "price", label: "Purchase price", t: "usd" },
    { k: "closing", label: "Closing costs (% price)", t: "pct" },
    { k: "rehab", label: "Rehab budget", t: "usd" },
    { k: "hold_months", label: "Months to refinance", t: "n" },
    { k: "carry_month", label: "Holding cost / mo", t: "usd" },
  ]],
  ["Refinance", [
    { k: "arv", label: "After-repair value", t: "usd" },
    { k: "refi_ltv", label: "Refi loan-to-value", t: "pct" },
    { k: "refi_rate", label: "Refi rate", t: "pct" },
    { k: "years", label: "Amortisation (yrs)", t: "n" },
    { k: "refi_cost", label: "Refi costs (% loan)", t: "pct" },
  ]],
  ["Rent", [
    { k: "rent_month", label: "Gross rent / mo", t: "usd" },
    { k: "opex_month", label: "Opex + reserves / mo", t: "usd" },
  ]],
];

const FLIP = [
  ["Buy & rehab", [
    { k: "price", label: "Purchase price", t: "usd" },
    { k: "closing", label: "Buy closing (% price)", t: "pct" },
    { k: "rehab", label: "Rehab budget", t: "usd" },
    { k: "months", label: "Months held", t: "n" },
    { k: "carry_month", label: "Holding cost / mo", t: "usd" },
  ]],
  ["Financing", [
    { k: "loan_ltc", label: "Loan (% of cost)", t: "pct" },
    { k: "rate", label: "Loan rate", t: "pct" },
    { k: "points", label: "Points (% loan)", t: "pct" },
  ]],
  ["Sale", [
    { k: "arv", label: "After-repair value", t: "usd" },
    { k: "sell_cost", label: "Selling costs (% ARV)", t: "pct" },
  ]],
];

const DEFS = { rental: RENTAL, brrrr: BRRRR, flip: FLIP };
const FIELDS = Object.fromEntries(Object.entries(DEFS).map(([s, g]) => [s, g.flatMap(x => x[1])]));
const LABEL = { rental: "Rental", brrrr: "BRRRR", flip: "Flip" };

/* ---------- module state ---------- */

let tab = pref("uw.tab") || "rental";
let sens = Object.assign({ row: "price", col: "rent_month", metric: "coc" }, pref("uw.sens") || {});
let gridM = Object.assign({ brrrr: "left_in", flip: "profit" }, pref("uw.grid") || {});
const ov = load("uw.ov", {});           // { [pid]: { rental: { k: display value }, brrrr: {…}, flip: {…} } }
let last = { key: "", res: null, err: "" }, seq = 0;
let rootEl = null, rerender = () => {};

const ovFor = (pid, s) => ((ov[pid] = ov[pid] || {})[s] = ov[pid][s] || {});
const persist = () => save("uw.ov", ov);

/* ---------- defaults from the profile ---------- */

const num = v => (v != null && v !== "" && Number.isFinite(+v) ? +v : null);
const d = (v, src, data = false) => ({ v: num(v), src, data });
const pctD = (v, src) => d(v * 100, src);

/** Rental-hold defaults. price: the effective price (after the user's own edit), so assumed % of price follow it. */
function rentalDefaults(P, price) {
  const L = P.listing, V = P.value, R = P.rent, q = P.quick || {}, ctx = P.ctx || {};
  const out = {};
  if (num(L?.price)) out.price = d(L.price, `Asking price · ${L.source || "listing"}${L.listed ? " · listed " + L.listed : ""}`, true);
  else if (num(V?.value)) out.price = d(V.value, `${V.source || "value estimate"} ${V.as_of || ""} (no asking price)`.trim(), true);
  else out.price = d(null, "No asking price or value estimate — type a price");
  const p = num(price) ?? out.price.v;
  if (num(R?.value)) out.rent_month = d(R.value, `${R.source || "rent estimate"} ${R.as_of || ""}${num(R.low) ? ` · range ${f.usd(R.low)}–${f.usd(R.high)}` : ""}${num(R.n) ? ` · ${R.n} comps` : ""}`, true);
  else if (num(q.rent_est)) out.rent_month = d(q.rent_est, q.rent_src || "rent estimate", true);
  else out.rent_month = d(null, "No rent estimate — type the rent, or get one on Comps");
  out.other_income_month = d(0, "None assumed");
  out.vacancy = pctD(0.05, "5% (assumed)");
  if (num(P.tax?.amount)) out.taxes_year = d(P.tax.amount, P.tax.src || "tax record", true);
  else out.taxes_year = d(p != null ? p * 0.012 : null, "1.2% of price (assumed)");
  out.insurance_year = d(p != null ? Math.max(900, p * 0.005) : null, "0.5% of price, $900 minimum (assumed; same as the quick returns)");
  out.hoa_month = d(0, "None on record");
  out.utilities_month = d(0, "Tenant pays (assumed)");
  out.other_exp_year = d(0, "None assumed");
  out.mgmt = pctD(0.08, "8% of effective income (assumed)");
  out.maint = pctD(0.05, "5% of rent (assumed)");
  out.capex = pctD(0.05, "5% of rent (assumed)");
  out.closing = pctD(0.03, "3% of price (assumed)");
  out.rehab = d(0, "None assumed");
  out.down = pctD(0.25, "25% (investor loan, assumed)");
  const rate = num(ctx.rate);
  out.rate = rate != null ? d(rate * 100, ctx.rate_src || "investor rate", !/default|assum/i.test(ctx.rate_src || "")) : pctD(0.07, "7% (assumed)");
  out.years = d(30, "30-year loan");
  out.io = { v: false, src: "Amortising" };
  out.rent_growth = pctD(0.03, "3% (assumed)");
  out.exp_growth = pctD(0.03, "3% (assumed)");
  out.appreciation = pctD(0.03, "3% (assumed)");
  out.exit_cap = { v: null, src: "Blank: sale price grows at appreciation" };
  out.hold = d(10, "10 years");
  out.sell_cost = pctD(0.06, "6% (assumed)");
  return out;
}

/** BRRRR / Flip defaults, built from the rental tab's effective inputs so the three tabs start from one view. */
function otherDefaults(P, s, R) {
  const V = P.value, ctx = P.ctx || {};
  const arv = num(V?.value) ? d(V.value, `${V.source || "value estimate"} ${V.as_of || ""} — as-is value; set your after-repair value`.trim(), true)
    : d(null, "No value estimate — type the after-repair value");
  const price = d(R.price, "Rental tab purchase price");
  const rehab = d(R.rehab, "Rental tab rehab");
  const carry = d(((R.taxes_year || 0) + (R.insurance_year || 0)) / 12 + (R.utilities_month || 0) + (R.hoa_month || 0),
    "Tax + insurance + HOA + utilities from the Rental tab");
  if (s === "brrrr") {
    let opex = null;
    if (num(R.rent_month) != null) {
      const gross = (R.rent_month + (R.other_income_month || 0)) * 12, rent = R.rent_month * 12;
      const vac = gross * (R.vacancy || 0) / 100, egi = gross - vac;
      opex = ((R.taxes_year || 0) + (R.insurance_year || 0) + (R.hoa_month || 0) * 12 + (R.utilities_month || 0) * 12 + (R.other_exp_year || 0)
        + egi * (R.mgmt || 0) / 100 + rent * ((R.maint || 0) + (R.capex || 0)) / 100 + vac) / 12;
    }
    const rate = num(ctx.rate);
    return {
      price, rehab, arv, closing: d(R.closing, "Rental tab closing costs"), hold_months: d(6, "6 months (assumed)"), carry_month: carry,
      refi_ltv: pctD(0.75, "75% (typical cash-out refi)"),
      refi_rate: rate != null ? d(rate * 100, ctx.rate_src || "investor rate", !/default|assum/i.test(ctx.rate_src || "")) : pctD(0.072, "7.2% (assumed)"),
      years: d(30, "30-year loan"), refi_cost: pctD(0.02, "2% of loan (assumed)"),
      rent_month: d(R.rent_month, "Rental tab rent"),
      opex_month: d(opex, "Rental tab year-1 opex + vacancy + capex reserve"),
    };
  }
  return {
    price, rehab, arv, closing: pctD(0.02, "2% of price (assumed)"), months: d(6, "6 months (assumed)"), carry_month: carry,
    loan_ltc: pctD(0, "All cash (set a hard-money loan here)"), rate: pctD(0.11, "11% hard money (assumed)"), points: pctD(0.02, "2 points (assumed)"),
    sell_cost: pctD(0.08, "8% of ARV: commission + closing (assumed)"),
  };
}

/** Effective inputs for a strategy: { vals (display units), meta: { k: { src, data, edited } } }. */
function inputsFor(P, s) {
  const pid = P.property.id, o = ovFor(pid, "rental");
  const pass1 = rentalDefaults(P, null);
  const price = o.price !== undefined ? o.price : pass1.price.v;
  const rd = rentalDefaults(P, price);
  const merge = (defs, ovs) => {
    const vals = {}, meta = {};
    for (const [k, x] of Object.entries(defs)) {
      const ed = ovs[k] !== undefined;
      vals[k] = ed ? ovs[k] : x.v;
      meta[k] = { src: ed ? `Your input (default: ${x.src})` : x.src, data: !ed && x.data, edited: ed, def: x.v };
    }
    return { vals, meta };
  };
  const rental = merge(rd, o);
  if (s === "rental") return rental;
  return merge(otherDefaults(P, s, rental.vals), ovFor(pid, s));
}

/** Display values → engine body (percent → fraction). Returns { body } or { need: "what is missing" }. */
function toBody(s, vals) {
  const inputs = {};
  for (const fl of FIELDS[s]) {
    const v = vals[fl.k];
    if (fl.t === "bool") { inputs[fl.k] = !!v; continue; }
    if (v == null) {
      if (fl.opt) { inputs[fl.k] = null; continue; }
      return { need: fl.label };
    }
    inputs[fl.k] = fl.t === "pct" ? v / 100 : v;
  }
  if (!(inputs.price > 0)) return { need: "Purchase price" };
  if (s === "rental") {
    if (!(inputs.rent_month > 0)) return { need: "Gross rent / mo" };
    inputs.hold = Math.max(1, Math.min(40, Math.round(inputs.hold || 10)));
    inputs.years = Math.max(1, inputs.years || 30);
    if (inputs.exit_cap != null && !(inputs.exit_cap > 0)) inputs.exit_cap = null;
    return { body: { strategy: s, inputs, sens: { ...sens } } };
  }
  if (!(inputs.arv > 0)) return { need: "After-repair value" };
  if (s === "flip" && !(inputs.months > 0)) return { need: "Months held" };
  if (s === "brrrr") inputs.years = Math.max(1, inputs.years || 30);
  return { body: { strategy: s, inputs } };
}

/* ---------- formatting ---------- */

function showIn(t, v) {
  if (v == null || v === "") return "";
  if (t === "usd") return f.ok(v) ? Math.round(+v).toLocaleString("en-US") : "";
  if (t === "pct") return String(+(+v).toFixed(3));
  return String(+(+v).toFixed(2));
}
const money = v => f.usd(f.ok(v) && Math.abs(v) < 0.5 ? 0 : v);
const signedMoney = v => (f.ok(v) ? `<em class="sg ${f.cls(Math.abs(v) < 0.5 ? 0 : v)}">${money(v)}</em>` : f.DASH);

const SENS_KEYS = [
  { v: "price", label: "Price", t: "usd" }, { v: "rent_month", label: "Rent", t: "usd" }, { v: "rate", label: "Rate", t: "pct" },
  { v: "vacancy", label: "Vacancy", t: "pct" }, { v: "down", label: "Down", t: "pct" }, { v: "appreciation", label: "Appreciation", t: "pct" },
  { v: "rent_growth", label: "Rent growth", t: "pct" }, { v: "exp_growth", label: "Expense growth", t: "pct" }, { v: "mgmt", label: "Management", t: "pct" },
  { v: "rehab", label: "Rehab", t: "usd" }, { v: "exit_cap", label: "Exit cap", t: "pct" },
];
const METRICS = {
  coc: { label: "Cash-on-cash", fmt: v => f.pct(v, 1), mid: 0.08, mids: "8%" },
  irr: { label: "IRR", fmt: v => f.pct(v, 1), mid: 0.10, mids: "10%" },
  cap: { label: "Cap rate", fmt: v => f.pct(v, 2), mid: 0.06, mids: "6%" },
  dscr: { label: "DSCR", fmt: v => f.x(v), mid: 1.25, mids: "1.25×" },
  cash_flow_month: { label: "Cash flow / mo", fmt: v => f.usd(v), mid: 0, mids: "$0" },
};

/* ---------- local BRRRR / Flip formulas (same as valora/uw.py; checked against the engine's base case) ---------- */

function pmt(P, r, years) { const n = years * 12, i = r / 12; return !P ? 0 : i ? P * i / (1 - (1 + i) ** -n) : P / n; }
function brrrrJS(x) {
  const all_in = x.price * (1 + x.closing) + x.rehab + x.carry_month * x.hold_months, loan = x.arv * x.refi_ltv;
  const cash_out = loan * (1 - x.refi_cost), left_in = all_in - cash_out, p = pmt(loan, x.refi_rate, x.years), cf = x.rent_month - x.opex_month - p;
  return { all_in, loan, cash_out, left_in, payment: p, cash_flow_month: cf, coc: left_in > 0 ? cf * 12 / left_in : null, equity: x.arv - loan };
}
function flipJS(x) {
  const loan = (x.price + x.rehab) * x.loan_ltc, interest = loan * x.rate / 12 * x.months;
  const costs = x.price * x.closing + x.arv * x.sell_cost + x.carry_month * x.months + interest + loan * x.points;
  const profit = x.arv - x.price - x.rehab - costs;
  const cash = x.price + x.rehab + x.price * x.closing + x.carry_month * x.months + interest + loan * x.points - loan;
  return { profit, costs, cash, roi: cash > 0 ? profit / cash : null, annualized: cash > 0 && x.months > 0 && profit > -cash ? (1 + profit / cash) ** (12 / x.months) - 1 : null, interest, loan };
}
const near = (a, b) => (a == null && b == null) || (f.ok(a) && f.ok(b) && Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.001));

/* ---------- page ---------- */

export default {
  id: "underwrite",
  deps: [],
  async render(root, ctx) {
    rootEl = root;
    rerender = () => this.render(root, ctx);
    const P = S.prop, pid = P.property.id;
    if (!DEFS[tab]) tab = "rental";
    const { vals, meta } = inputsFor(P, tab);

    ctx.sub.innerHTML = chips("tab", ["rental", "brrrr", "flip"].map(v => ({ v, label: LABEL[v], sub: Object.keys(ovFor(pid, v)).length ? "edited" : "" })), tab)
      + sep() + btn("save", "Save scenario", { cls: "pri", title: "Save these inputs and results under a name for this property" })
      + btn("reset", "Reset to profile", { cls: "ghost", title: `Discard your edits on the ${LABEL[tab]} tab and go back to the profile's figures` });
    ctx.bar.innerHTML = (f.ok(P.property.lat) && f.ok(P.property.lon) ? btn("sv", "Street View", { cls: "ghost", title: "Open Google Street View at this address in your browser" }) : "")
      + btn("csv", "CSV", { title: tab === "rental" ? "Export the pro forma" : "Export inputs and results" })
      + `<span title="Gold outline: the figure came from data. Blue: you changed it.">${esc(f.street(P.property.address))}</span>`;
    bind(ctx.sub, {
      "chip:tab": v => { tab = v; pref("uw.tab", v); last.key = ""; this.render(root, ctx); },
      "act:save": () => saveScenario(P),
      "act:reset": () => { ovFor(pid, tab); ov[pid][tab] = {}; persist(); last.key = ""; this.render(root, ctx); toast(`${LABEL[tab]} inputs reset to the profile`); },
    });
    bind(ctx.bar, { "act:csv": () => exportCsv(P), "act:sv": () => openStreet(P) });

    root.innerHTML = `<div class="uw">
      <aside class="uw-left pnl">
        <div class="ph"><h3>Inputs</h3><span class="s">${LABEL[tab]}</span><div class="r"><span class="uw-key"><i class="g"></i>data <i class="b"></i>yours</span></div></div>
        <div class="uw-form" id="uw-form">${formHtml(tab, vals, meta)}</div>
        <div id="uw-srcs">${sourcesHtml(P, tab, meta)}</div>
      </aside>
      <div class="uw-out" id="uw-out"></div>
    </div>`;

    bind(root, {
      "input:uwf": (v, el) => onEdit(P, el, v),
      "change:uwf": (v, el) => { if (el.type === "checkbox") onEdit(P, el, el.checked); else tidy(el); },
      "act:clr": el => { const k = el.dataset.k; delete ovFor(pid, tab)[k]; persist(); last.key = ""; this.render(root, ctx); },
      "change:sr": v => { if (v === sens.col) sens.col = sens.row; sens.row = v; pref("uw.sens", sens); recalc(P, true); },
      "change:sc": v => { if (v === sens.row) sens.row = sens.col; sens.col = v; pref("uw.sens", sens); recalc(P, true); },
      "change:sm": v => { sens.metric = v; pref("uw.sens", sens); recalc(P, true); },
      "chip:gm": v => { gridM[tab] = v; pref("uw.grid", gridM); drawOut(P); },
      "act:load": el => loadScenario(P, +el.dataset.id),
      "act:save": () => saveScenario(P),
    });
    drawOut(P);
    await recalc(P, false);
  },
  leave() { seq++; },
};

/* ---------- the form ---------- */

function formHtml(s, vals, meta) {
  return DEFS[s].map(([grp, fields]) => `<h6>${esc(grp)}</h6>` + fields.map(fl => {
    const m = meta[fl.k] || {}, cls = m.edited ? "ed" : m.data ? "src" : "";
    const tip = esc(m.src || "");
    if (fl.t === "bool") return `<label class="uw-l" title="${tip}">${esc(fl.label)}</label><span class="uw-v uw-b"><input type="checkbox" data-input="uwf" data-k="${fl.k}"${vals[fl.k] ? " checked" : ""}></span>`;
    return `<label class="uw-l" title="${tip}">${esc(fl.label)}${m.edited ? ` <a class="uw-x" data-act="clr" data-k="${fl.k}" title="Back to the profile figure (${esc(showIn(fl.t, m.def) || "blank")})">↺</a>` : ""}</label>`
      + `<span class="uw-v ${fl.t}"><input class="${cls}" data-input="uwf" data-k="${fl.k}" value="${esc(showIn(fl.t, vals[fl.k]))}" title="${tip}" inputmode="decimal" autocomplete="off" spellcheck="false"${fl.opt ? ' placeholder="—"' : ""}></span>`;
  }).join("")).join("");
}

function sourcesHtml(P, s, meta) {
  const rows = FIELDS[s].filter(fl => meta[fl.k]?.data || meta[fl.k]?.edited).map(fl =>
    `<div class="uw-s"><span>${esc(fl.label)}</span><em class="${meta[fl.k].edited ? "acc" : ""}">${esc(meta[fl.k].src)}</em></div>`).join("");
  const miss = (P.missing || []).map(m => `<div class="miss"><b>${esc(m.k)}</b><span>${esc(m.how)}</span></div>`).join("");
  const demo = [P.listing?.source, P.value?.source, P.rent?.source].some(x => /demo/i.test(x || "")) ? `<div class="note">Demo data: figures marked DEMO are generated samples, not market records.</div>` : "";
  return `<div class="uw-srch">Sources</div>${rows || `<div class="note">No figures from data yet. Everything here is an assumption or your input.</div>`}`
    + `<div class="note">Other fields are assumptions; hover any input for its basis.</div>${miss}${demo}`;
}

function onEdit(P, el, raw) {
  const k = el.dataset.k, fl = FIELDS[tab].find(x => x.k === k);
  if (!fl) return;
  const o = ovFor(P.property.id, tab);
  if (fl.t === "bool") o[k] = !!raw;
  else if (String(raw).trim() === "") { if (fl.opt) o[k] = null; else { el.classList.add("bad"); return; } }
  else {
    const v = parseNum(raw);
    if (v == null) { el.classList.add("bad"); return; }
    o[k] = v;
  }
  el.classList.remove("bad", "src");
  el.classList.add("ed");
  persist();
  if (tab === "rental" && k === "price") refreshDerived(P);
  recalcSoon(P);
}

/** Inputs whose default depends on the price (assumed tax / insurance) follow a price edit without a re-render. */
function refreshDerived(P) {
  const { vals, meta } = inputsFor(P, "rental");
  for (const k of ["taxes_year", "insurance_year"]) {
    if (meta[k].edited) continue;
    const el = rootEl?.querySelector(`input[data-k="${k}"]`);
    if (el && document.activeElement !== el) el.value = showIn("usd", vals[k]);
  }
}

function tidy(el) {
  const fl = FIELDS[tab].find(x => x.k === el.dataset.k);
  const v = parseNum(el.value);
  if (fl && v != null) el.value = showIn(fl.t, v);
}

/* ---------- calculation ---------- */

const recalcSoon = debounce(P => recalc(P, false), 220);

async function recalc(P, force) {
  if (S.prop !== P && S.prop?.property?.id !== P.property.id) return;
  const { vals } = inputsFor(P, tab), b = toBody(tab, vals), my = ++seq;
  const out = rootEl?.querySelector("#uw-out");
  if (!out) return;
  if (b.need) { last = { key: "", res: null, err: "", need: b.need, strategy: tab, vals }; drawOut(P); return; }
  const key = JSON.stringify(b.body);
  if (!force && key === last.key && last.res) return drawOut(P);
  out.classList.add("busy");
  let res = null, err = "";
  try { res = await api("/api/underwrite", b.body); } catch (e) { err = String(e.message || e); }
  if (my !== seq) return;
  out.classList.remove("busy");
  last = { key, res, err, strategy: tab, body: b.body, vals };
  drawOut(P);
}

/* ---------- outputs ---------- */

function drawOut(P) {
  const out = rootEl?.querySelector("#uw-out");
  if (!out) return;
  if (last.need && last.strategy === tab) {
    out.innerHTML = panel({ title: `${LABEL[tab]} model`, body: `<div class="empty"><b>${esc(last.need)} is needed to run the model</b><span>Type it in the inputs on the left. `
      + `${tab === "rental" ? "Rent estimates come from RentCast (Settings → API keys) or your own comps on the Comps page." : "Use your contractor's scope and recent renovated sales for the after-repair value."}</span></div>` })
      + scenariosHtml(P);
    drawScenarios(P);
    return;
  }
  if (!last.res || last.strategy !== tab) {
    out.innerHTML = last.err ? panel({ title: "Model", body: `<div class="strip warn"><b>The engine refused the inputs.</b> ${esc(last.err)}</div>` }) : `<div class="empty"><span class="spin"></span><span>Calculating…</span></div>`;
    return;
  }
  if (tab === "rental") drawRental(P, out, last.res);
  else if (tab === "brrrr") drawBrrrr(P, out, last.res, last.body.inputs);
  else drawFlip(P, out, last.res, last.body.inputs);
  drawScenarios(P);
}

function drawRental(P, out, r) {
  r.value_ref = num(P.value?.value);
  const i = r.inputs || {}, ask = num(P.listing?.price), hold = i.hold || (r.proforma || []).length;
  const exitBasis = i.exit_cap ? `exit at ${f.pct(i.exit_cap, 2)} cap on year-${hold + 1} NOI` : `sale price grown ${f.pct(i.appreciation, 1)}/yr`;
  out.innerHTML = `<section class="pnl">
      <div class="ph"><h3>Rental hold</h3><span class="s">year 1 · ${f.pct(i.down, 0)} down at ${f.pct(i.rate, 2)}${i.io ? " interest-only" : ` / ${f.int(i.years)} yr`} · ${f.int(hold)}-yr hold, ${esc(exitBasis)}</span></div>
      ${kv([
        { k: "Cap rate", v: f.pct(r.cap, 2), title: "Year-1 NOI / price" },
        { k: "Cash-on-cash", v: f.pct(r.coc, 2), cls: f.cls(r.coc), title: "(NOI − capex reserve − debt service) / cash in" },
        { k: "DSCR", v: f.x(r.dscr), cls: f.ok(r.dscr) ? (r.dscr >= 1.25 ? "" : r.dscr < 1 ? "down" : "amb") : "", title: "NOI / annual principal and interest" },
        { k: "IRR", v: f.pct(r.irr, 1), cls: f.cls(r.irr), title: "On annual levered cash flows including the sale" },
        { k: "Equity multiple", v: f.x(r.multiple), title: "Total cash returned / cash in" },
        { k: "Cash flow / mo", v: f.usd(r.cash_flow_month), cls: f.cls(r.cash_flow_month), title: "Year 1, after capex reserve and debt service" },
        { k: "Cash in", v: f.usd(r.cash_in), title: "Down payment + closing + rehab" },
        { k: "NOI yr 1", v: f.usd(r.noi), title: "Effective gross income − operating expenses" },
      ], { cls: "uw-k4" })}
      ${kv([
        { k: "Loan", v: f.usd(r.loan) },
        { k: "Payment / mo", v: f.usd(r.payment), title: "Principal and interest" },
        { k: "Breakeven occ.", v: f.pct(r.breakeven_occ, 1), title: "(Opex + debt service) / gross income" },
        { k: "Opex ratio", v: f.pct(r.opex_ratio, 1), title: "Opex / effective gross income (capex reserve excluded)" },
        { k: "GRM", v: f.num(r.grm, 2), title: "Price / annual gross rent" },
        { k: "Rent / price", v: f.pct(r.one_pct, 2), title: "Monthly rent / (price + rehab): the 1% rule" },
        { k: "Debt yield", v: r.loan ? f.pct(r.noi / r.loan, 1) : f.DASH, title: "Year-1 NOI / loan amount (lenders look for 8–10%+)" },
        { k: `Exit value yr ${f.int(hold)}`, v: f.usd(r.sale), sub: `net ${f.cusd(r.net_sale)}`, title: "Gross sale price; net = after selling costs and loan payoff" },
      ], { cls: "tight uw-k4" })}
    </section>
    ${panel({ title: "Pro forma", sub: `annual · rent +${f.pct(i.rent_growth, 1)}/yr, expenses +${f.pct(i.exp_growth, 1)}/yr · sale in year ${f.int(hold)}`, flush: true, body: `<div id="uw-pf"></div>` })}
    <div class="uw-g2">
      ${panel({ title: "Cash flows", sub: "equity in, annual cash flow, net sale", body: `<div id="uw-cf"></div>` })}
      ${panel({ title: "Max offer", sub: ask ? `vs asking ${f.usd(ask)}` : "highest price that still meets the target", flush: true, body: offerHtml(r, ask) })}
    </div>
    <div class="uw-g2">
      ${panel({ title: "Sensitivity", right: sensControls(i), body: `<div id="uw-sens"></div><div class="note" style="padding:6px 0 0">Rows and columns step ±5% / ±10% for money inputs and ±0.5 / ±1 point for rates; every other input held. Centre cell (in brackets) is the current case; green above ${METRICS[sens.metric]?.mids || ""}, red below.</div>` })}
      ${panel({ title: "Amortisation", sub: `${f.usd(r.payment)}/mo · interest over the hold ${f.usd((r.amort || []).slice(0, hold).reduce((a, x) => a + (x.interest || 0), 0))}`, flush: true, body: `<div id="uw-am"></div>` })}
    </div>
    ${scenariosHtml(P)}`;

  // pro forma: line items as rows, years as columns
  const pf = r.proforma || [], yrs = pf.map(y => y.year);
  const lines = [
    ["Gross income", y => y.gross],
    ["Vacancy", y => -y.vacancy],
    ["Effective gross income", y => y.egi, "tot"],
    ["Property tax", y => -y.taxes],
    ["Insurance", y => -y.insurance],
    ["Management", y => -y.mgmt],
    ["Repairs", y => -y.maint],
    ["HOA, utilities, other", y => -(y.opex - y.taxes - y.insurance - y.mgmt - y.maint)],
    ["Net operating income", y => y.noi, "tot"],
    ["Capex reserve", y => -y.capex],
    ["Debt service", y => -y.debt],
    ["Cash flow", y => y.cash_flow, "tot sg"],
    ["Net sale proceeds", y => (y.year === hold ? r.net_sale : null), "sg"],
    ["Total cash flow", (y, j) => r.flows?.[j + 1], "tot sg"],
    ["Cash-on-cash", y => (r.cash_in ? y.cash_flow / r.cash_in : null), "pct"],
    ["DSCR", y => (y.debt ? y.noi / y.debt : null), "x"],
    ["Loan balance", y => y.balance, "memo"],
  ];
  // a line that is zero (or blank) in every year is noise: drop it, except the totals
  const live = lines.filter(([, fn, cls]) => (cls || "").includes("tot") || pf.some((y, j) => { const v = fn(y, j); return f.ok(v) && Math.abs(v) >= (/pct|x/.test(cls || "") ? 1e-9 : 0.5); }));
  const rows = live.map(([label, fn, cls], n) => {
    const row = { key: n, label, cls: cls || "" };
    pf.forEach((y, j) => { row["y" + y.year] = fn(y, j); });
    return row;
  });
  const cell = (v, row) => {
    if (!f.ok(v)) return f.DASH;
    if (row.cls.includes("pct")) return f.pct(v, 1);
    if (row.cls.includes("x")) return f.x(v);
    if (row.cls.includes("sg")) return signedMoney(v);
    return money(v);
  };
  table(out.querySelector("#uw-pf"), {
    id: "uw-pf", rows, key: r2 => r2.key, nav: false, cls: "uw-pft",
    rowCls: r2 => r2.cls,
    cols: [{ k: "label", label: "", l: true, sort: false, w: 170 }, ...yrs.map(y => ({ k: "y" + y, label: `Yr ${y}`, sort: false, fmt: (v, r2) => cell(v, r2) }))],
  });

  const n = pf.length;
  C.bars(out.querySelector("#uw-cf"), {
    h: 220, stacked: true, cats: ["Yr 0", ...yrs.map(y => `Yr ${y}`)],
    series: [
      { name: "Equity in", vals: [-(r.cash_in || 0), ...yrs.map(() => null)], color: "mut" },
      { name: "Operating cash flow", vals: [null, ...pf.map(y => y.cash_flow)], color: "acc" },
      { name: "Net sale", vals: [null, ...pf.map((y, j) => (j === n - 1 ? r.net_sale : null))], color: "amber" },
    ],
    y: { fmt: v => (v < 0 ? "−$" : "$") + f.compact(Math.abs(v)) },
  });

  drawSens(out, r);

  const am = (r.amort || []).map((a, j, arr) => ({ ...a, key: a.year, cum: arr.slice(0, j + 1).reduce((s, x) => s + x.interest, 0), paid: r.loan ? 1 - a.balance / r.loan : null }));
  table(out.querySelector("#uw-am"), {
    id: "uw-am", rows: am, key: a => a.key, maxH: 268, nav: false, sel: hold,
    cols: [
      { k: "year", label: "Yr", w: 34 },
      { k: "interest", label: "Interest", fmt: money },
      { k: "principal", label: "Principal", fmt: money },
      { k: "balance", label: "Balance", fmt: money },
      { k: "cum", label: "Cum. interest", fmt: money },
      { k: "paid", label: "Paid down", fmt: v => f.pct(v, 1) },
    ],
    foot: `Highlighted: year ${f.int(hold)}, the sale. Balance at sale ${f.usd(pf[n - 1]?.balance)}.`,
    empty: "No loan: 100% down",
  });
}

function offerHtml(r, ask) {
  const row = (label, v, tip) => {
    const d0 = f.ok(v) && ask ? v / ask - 1 : null;
    return `<div class="uw-o" title="${esc(tip)}"><span>${esc(label)}</span><b>${f.ok(v) ? f.usd(v) : `<span class="mut" title="Not reachable at any price with these inputs">${f.DASH}</span>`}</b><em class="${f.cls(d0)}">${d0 != null ? f.spct(d0, 1) + " vs ask" : ""}</em></div>`;
  };
  return `<div class="uw-offers">
      ${row("6% cash-on-cash", r.offer_coc_6, "Highest price with year-1 CoC ≥ 6%")}
      ${row("8% cash-on-cash", r.offer_coc_8, "Highest price with year-1 CoC ≥ 8%")}
      ${row("10% cash-on-cash", r.offer_coc_10, "Highest price with year-1 CoC ≥ 10%")}
      ${row("1.25× DSCR", r.offer_dscr_125, "Highest price with NOI / debt service ≥ 1.25 (the usual lender floor)")}
    </div>
    ${kv([
      { k: "Total profit", v: (r.flows || []).length && r.flows.every(f.ok) ? signedMoney(r.flows.reduce((a, b) => a + b, 0)) : f.ok(r.multiple) && f.ok(r.cash_in) ? signedMoney(r.cash_in * (r.multiple - 1)) : f.DASH, title: "Cash returned over the hold minus cash in" },
      { k: "Price / value", v: f.ok(r.inputs?.price) && f.ok(r.value_ref) ? f.pct(r.inputs.price / r.value_ref, 0) : f.DASH, title: "Purchase price / value estimate" },
    ], { cls: "tight" })}
    <div class="note">Each figure holds every other input fixed and solves for price by bisection in the engine.</div>`;
}

function sensControls(i) {
  const keys = SENS_KEYS.filter(k => k.v !== "exit_cap" || i.exit_cap).filter(k => k.v !== "rehab" || i.rehab > 0);
  return selectBox("sr", keys, sens.row, { title: "Rows" }) + `<span class="faint">×</span>` + selectBox("sc", keys, sens.col, { title: "Columns" })
    + selectBox("sm", Object.entries(METRICS).map(([v, m]) => ({ v, label: m.label })), sens.metric, { title: "Metric" });
}

function drawSens(out, r) {
  const el = out.querySelector("#uw-sens"), s = r.sens;
  if (!el) return;
  if (!s || !s.grid?.length) { el.innerHTML = `<div class="empty"><span>No sensitivity returned</span></div>`; return; }
  const kt = k => SENS_KEYS.find(x => x.v === k)?.t || "pct";
  const lab = (k, v, j) => { const t = kt(k), x = t === "usd" ? (Math.abs(v) < 10000 ? f.usd(v) : "$" + f.compact(v)) : f.pct(v, 2); return j === 2 ? `[${x}]` : x; };
  const rk = s.row[0], ck = s.col[0], m = METRICS[s.metric] || METRICS.coc;
  const rn = SENS_KEYS.find(x => x.v === rk)?.label || rk, cn = SENS_KEYS.find(x => x.v === ck)?.label || ck;
  el.innerHTML = `<div class="uw-axis"><span>${esc(rn)} ↓</span><span>${esc(cn)} →</span></div><div id="uw-hm"></div>`;
  C.heat(el.querySelector("#uw-hm"), {
    rows: s.row[1].map((v, j) => lab(rk, v, j)), cols: s.col[1].map((v, j) => lab(ck, v, j)), z: s.grid,
    scale: "div", mid: m.mid, fmt: m.fmt, cellH: 28, label: m.label,
  });
}

/* ---------- BRRRR ---------- */

function drawBrrrr(P, out, r, x) {
  const js = brrrrJS(x), okJS = near(js.left_in, r.left_in) && near(js.cash_flow_month, r.cash_flow_month);
  out.innerHTML = `<section class="pnl">
      <div class="ph"><h3>BRRRR</h3><span class="s">buy, rehab, rent, refinance at ${f.pct(x.refi_ltv, 0)} of ${f.usd(x.arv)} ARV after ${f.int(x.hold_months)} months</span></div>
      ${kv([
        { k: "All-in cost", v: f.usd(r.all_in), title: "Price + closing + rehab + holding costs" },
        { k: "Refi loan", v: f.usd(r.loan) },
        { k: "Cash out", v: f.usd(r.cash_out), title: "Refi loan less refi costs" },
        { k: "Cash left in", v: f.usd(r.left_in), cls: f.ok(r.left_in) ? (r.left_in <= 0 ? "up" : "") : "", title: "All-in cost − cash out. Zero or less: all capital recovered" },
        { k: "Payment / mo", v: f.usd(r.payment) },
        { k: "Cash flow / mo", v: f.usd(r.cash_flow_month), cls: f.cls(r.cash_flow_month) },
        { k: "Cash-on-cash", v: r.infinite ? `<em class="sg up">∞</em>` : f.pct(r.coc, 1), cls: f.cls(r.coc), sub: r.infinite ? "no cash left in" : "", title: "Annual cash flow / cash left in" },
        { k: "Equity at refi", v: f.usd(r.equity), title: "ARV − refi loan" },
      ], { cls: "uw-k4" })}
    </section>
    <div class="uw-g2">
      ${panel({ title: "Capital", sub: "where the money goes and comes back", flush: true, body: `<div id="uw-cap"></div>` })}
      ${panel({ title: "ARV × refi LTV", sub: okJS ? "centre = current case" : "grid hidden: disagrees with the engine", right: chips("gm", [{ v: "left_in", label: "Left in" }, { v: "cash_flow_month", label: "CF/mo" }, { v: "coc", label: "CoC" }], gridM.brrrr), body: `<div id="uw-bg"></div>` })}
    </div>
    ${scenariosHtml(P)}`;
  const carry = x.carry_month * x.hold_months;
  const lines = [
    { label: "Purchase price", v: -x.price }, { label: "Closing", v: -x.price * x.closing }, { label: "Rehab", v: -x.rehab },
    { label: `Holding (${f.int(x.hold_months)} mo × ${f.usd(x.carry_month)})`, v: -carry },
    { label: "All-in cost", v: -r.all_in, cls: "tot" },
    { label: `Refi loan (${f.pct(x.refi_ltv, 0)} × ARV)`, v: r.loan }, { label: "Refi costs", v: -(r.loan - r.cash_out) },
    { label: "Cash out", v: r.cash_out, cls: "tot" },
    { label: "Cash left in the deal", v: -r.left_in, cls: "tot sg" },
    { label: "Rent / mo", v: x.rent_month }, { label: "Opex + reserves / mo", v: -x.opex_month }, { label: "Debt service / mo", v: -r.payment },
    { label: "Cash flow / mo", v: r.cash_flow_month, cls: "tot sg" },
  ].map((l, k) => ({ ...l, key: k }));
  table(out.querySelector("#uw-cap"), { id: "uw-cap", rows: lines, key: l => l.key, nav: false, rowCls: l => l.cls || "",
    cols: [{ k: "label", label: "", l: true, sort: false }, { k: "v", label: "Amount", sort: false, fmt: (v, l) => ((l.cls || "").includes("sg") ? signedMoney(v) : money(v)) }] });
  const el = out.querySelector("#uw-bg");
  if (!okJS) { el.innerHTML = `<div class="note">The in-page grid did not match the engine's result, so it is not shown.</div>`; return; }
  const ar = [-0.1, -0.05, 0, 0.05, 0.1].map(s => x.arv * (1 + s)), lt = [-0.1, -0.05, 0, 0.05].map(s => Math.max(0.05, x.refi_ltv + s));
  if (!lt.includes(x.refi_ltv)) lt.splice(2, 0, x.refi_ltv);
  const m = gridM.brrrr, z = ar.map(a => lt.map(l => brrrrJS({ ...x, arv: a, refi_ltv: l })[m]));
  const fm = m === "coc" ? v => f.pct(v, 1) : v => f.usd(v);
  C.heat(el, { rows: ar.map((a, j) => (j === 2 ? `[$${f.compact(a)}]` : "$" + f.compact(a))), cols: lt.map(l => (Math.abs(l - x.refi_ltv) < 1e-9 ? `[${f.pct(l, 0)}]` : f.pct(l, 0))),
    z, scale: "div", mid: m === "left_in" ? 0 : m === "coc" ? 0.08 : 0, fmt: fm, cellH: 28, label: { left_in: "Cash left in", cash_flow_month: "Cash flow / mo", coc: "Cash-on-cash" }[m], colors: m === "left_in" ? ["up", "down"] : undefined });
}

/* ---------- Flip ---------- */

function drawFlip(P, out, r, x) {
  const js = flipJS(x), okJS = near(js.profit, r.profit) && near(js.cash, r.cash);
  const maxOffer70 = r.rule70;
  const beArv = x.sell_cost < 1 ? (x.price + x.rehab + (r.costs - x.arv * x.sell_cost)) / (1 - x.sell_cost) : null;
  out.innerHTML = `<section class="pnl">
      <div class="ph"><h3>Flip</h3><span class="s">buy at ${f.usd(x.price)}, ${f.usd(x.rehab)} rehab, sell at ${f.usd(x.arv)} after ${f.int(x.months)} months${x.loan_ltc ? ` · ${f.pct(x.loan_ltc, 0)} of cost financed at ${f.pct(x.rate, 1)}` : " · all cash"}</span></div>
      ${kv([
        { k: "Profit", v: f.usd(r.profit), cls: f.cls(r.profit) },
        { k: "ROI", v: f.pct(r.roi, 1), cls: f.cls(r.roi), title: "Profit / cash invested" },
        { k: "Annualised", v: f.pct(r.annualized, 1), cls: f.cls(r.annualized), title: "ROI compounded to a year" },
        { k: "Margin", v: f.pct(r.margin, 1), cls: f.cls(r.margin), title: "Profit / ARV" },
        { k: "Cash needed", v: f.usd(r.cash), title: "Everything not covered by the loan" },
        { k: "Total costs", v: f.usd(r.costs), title: "Closing, selling, holding, interest, points (rehab and price excluded)" },
        { k: "70% rule max", v: f.usd(maxOffer70), sub: f.ok(maxOffer70) && x.price ? `<em class="sg ${f.cls(maxOffer70 - x.price)}">${f.susd(maxOffer70 - x.price)}</em> vs price` : "", title: "ARV × 70% − rehab" },
        { k: "Break-even ARV", v: f.usd(beArv), sub: f.ok(beArv) && x.arv ? `${f.spct(beArv / x.arv - 1, 1)} vs ARV` : "", title: "Sale price at which profit is zero, with every cost held" },
      ], { cls: "uw-k4" })}
    </section>
    <div class="uw-g2">
      ${panel({ title: "Deal sheet", flush: true, body: `<div id="uw-fl"></div>` })}
      ${panel({ title: "ARV × rehab", sub: okJS ? (x.rehab > 0 ? "centre = current case" : "no rehab entered: steps of $10K from $0") : "grid hidden: disagrees with the engine", right: chips("gm", [{ v: "profit", label: "Profit" }, { v: "roi", label: "ROI" }, { v: "annualized", label: "Annual." }], gridM.flip), body: `<div id="uw-fg"></div>` })}
    </div>
    ${scenariosHtml(P)}`;
  const lines = [
    { label: "After-repair value", v: x.arv, cls: "tot" },
    { label: "Purchase price", v: -x.price }, { label: "Rehab", v: -x.rehab },
    { label: `Buy closing (${f.pct(x.closing, 1)})`, v: -x.price * x.closing },
    { label: `Selling (${f.pct(x.sell_cost, 1)} of ARV)`, v: -x.arv * x.sell_cost },
    { label: `Holding (${f.int(x.months)} mo × ${f.usd(x.carry_month)})`, v: -x.carry_month * x.months },
    { label: "Loan interest", v: -js.interest }, { label: "Points", v: -js.loan * x.points },
    { label: "Profit", v: r.profit, cls: "tot sg" },
    { label: "Loan", v: js.loan, cls: "memo" }, { label: "Cash needed", v: r.cash, cls: "memo" },
  ].map((l, k) => ({ ...l, key: k }));
  table(out.querySelector("#uw-fl"), { id: "uw-fl", rows: lines, key: l => l.key, nav: false, rowCls: l => l.cls || "",
    cols: [{ k: "label", label: "", l: true, sort: false }, { k: "v", label: "Amount", sort: false, fmt: (v, l) => ((l.cls || "").includes("sg") ? signedMoney(v) : money(v)) }] });
  const el = out.querySelector("#uw-fg");
  if (!okJS) { el.innerHTML = `<div class="note">The in-page grid did not match the engine's result, so it is not shown.</div>`; return; }
  const ar = [-0.1, -0.05, 0, 0.05, 0.1].map(s => x.arv * (1 + s));
  const rb = x.rehab > 0 ? [-0.2, -0.1, 0, 0.1, 0.2].map(s => x.rehab * (1 + s)) : [0, 10000, 20000, 30000, 40000];
  const m = gridM.flip, z = ar.map(a => rb.map(b => flipJS({ ...x, arv: a, rehab: b })[m]));
  C.heat(el, { rows: ar.map((a, j) => (j === 2 ? `[$${f.compact(a)}]` : "$" + f.compact(a))), cols: rb.map((b, j) => (x.rehab > 0 && j === 2 ? `[$${f.compact(b)}]` : "$" + f.compact(b))),
    z, scale: "div", mid: m === "profit" ? 0 : 0.15, fmt: m === "profit" ? v => (v < 0 ? "−$" : "$") + f.compact(Math.abs(v)) : v => f.pct(v, 0), cellH: 28,
    label: { profit: "Profit", roi: "ROI", annualized: "Annualised" }[m] });
}

/* ---------- scenarios ---------- */

/** SQLite datetime('now') is UTC without a zone marker; mark it so the browser does not read it as local time. */
const utc = ts => (ts && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d)?$/.test(ts) ? ts.replace(" ", "T") + "Z" : ts);
const parse = s => { if (s && typeof s === "object") return s; try { return JSON.parse(s || "{}"); } catch (e) { return {}; } };

function headline(strategy, inp, o) {
  inp = inp || {}; o = o || {};
  return {
    price: inp.price, rent: inp.rent_month, arv: inp.arv,
    cash_in: strategy === "rental" ? o.cash_in : strategy === "brrrr" ? o.left_in : o.cash,
    cf: o.cash_flow_month, coc: o.coc, cap: o.cap, dscr: o.dscr, irr: o.irr, profit: strategy === "flip" ? o.profit : null, roi: o.roi,
  };
}

function scenariosHtml(P) {
  const n = (P.scenarios || []).length;
  return panel({ title: "Scenarios", sub: n ? `${n} saved for this property · click Load to restore inputs` : "none saved yet",
    right: btn("save", "Save current", { title: "Save the current inputs and results under a name" }), flush: true, body: `<div id="uw-sc"></div>`, cls: "uw-scp" });
}

function drawScenarios(P) {
  const el = rootEl?.querySelector("#uw-sc");
  if (!el) return;
  const rows = [];
  if (last.res && last.strategy === tab) rows.push({ key: "cur", name: "Current (unsaved)", strategy: tab, updated: null, cur: true, ...headline(tab, last.body.inputs, last.res) });
  for (const s of P.scenarios || []) {
    const inp = parse(s.inputs), o = parse(s.outputs);
    rows.push({ key: s.id, id: s.id, name: s.name, strategy: s.strategy, updated: s.updated, ...headline(s.strategy, inp, o) });
  }
  const cols = [
      { k: "name", label: "Scenario", l: true, fmt: (v, r) => `<b>${esc(v)}</b>` },
      { k: "strategy", label: "Strategy", l: true, fmt: v => esc(LABEL[v] || v) },
      { k: "price", label: "Price", fmt: money },
      { k: "rent", label: "Rent/mo", fmt: money },
      { k: "arv", label: "ARV", fmt: money },
      { k: "cash_in", label: "Cash in", title: "Rental: cash in · BRRRR: cash left in · Flip: cash needed", fmt: money },
      { k: "cf", label: "CF/mo", fmt: v => signedMoney(v) },
      { k: "coc", label: "CoC", fmt: v => f.pct(v, 1), cls: v => f.cls(v), heat: v => heat(v, -0.05, 0.15, { mid: 0.08 }) },
      { k: "cap", label: "Cap", fmt: v => f.pct(v, 2) },
      { k: "dscr", label: "DSCR", fmt: v => f.x(v) },
      { k: "irr", label: "IRR", fmt: v => f.pct(v, 1), cls: v => f.cls(v) },
      { k: "profit", label: "Profit", fmt: v => signedMoney(v) },
      { k: "roi", label: "ROI", fmt: v => f.pct(v, 1), cls: v => f.cls(v) },
      { k: "updated", label: "Saved", fmt: (v, r) => (r.cur ? `<span class="faint">live</span>` : esc(f.ago(utc(v)))), title: "When the scenario was saved" },
      { k: "act", label: "", sort: false, fmt: (v, r) => (r.cur ? "" : `<button class="btn" data-act="load" data-id="${r.id}">Load</button>`) },
  ];
  // only the columns some row fills: a rental-only list has no ARV / profit / ROI, a flip-only list no cap / DSCR / IRR
  const keep = new Set(["name", "strategy", "updated", "act"]);
  table(el, {
    id: "uw-sc", rows, key: r => r.key, nav: false, rowCls: r => (r.cur ? "cur" : ""),
    empty: "None saved. Save scenario keeps a named case to compare here.",
    cols: cols.filter(c => keep.has(c.k) || rows.some(r => f.ok(r[c.k]))),
  });
}

async function saveScenario(P) {
  if (!last.res || last.strategy !== tab) { toast("Nothing to save yet: the model needs a price and a rent first", "bad"); return; }
  const n = (P.scenarios || []).length;
  const v = await formModal("Save scenario", [{ k: "name", label: "Name", value: n ? `${LABEL[tab]} ${n + 1}` : "Base case", full: true, req: true }],
    { ok: "Save", note: `Saves the ${LABEL[tab]} inputs and headline results for ${esc(f.street(P.property.address))}. A scenario with the same name is replaced.` });
  if (!v || !v.name) return;
  const r = last.res, outputs = tab === "rental"
    ? Object.fromEntries(["loan", "cash_in", "payment", "noi", "cap", "cash_flow_month", "coc", "dscr", "grm", "irr", "multiple", "sale", "net_sale", "offer_coc_8", "offer_dscr_125"].map(k => [k, r[k]]))
    : { ...r };
  const res = await post("/api/scenario", { property_id: P.property.id, name: v.name, strategy: tab, inputs: last.body.inputs, outputs });
  if (res.error) toast(res.error, "bad"); else toast(`Saved "${v.name}"`);
}

function loadScenario(P, id) {
  const s = (P.scenarios || []).find(x => x.id === id);
  if (!s) return;
  const strat = DEFS[s.strategy] ? s.strategy : "rental", inp = parse(s.inputs), o = {};
  for (const fl of FIELDS[strat]) {
    if (!(fl.k in inp)) continue;
    const v = inp[fl.k];
    o[fl.k] = fl.t === "bool" ? !!v : v == null ? null : fl.t === "pct" ? +(v * 100).toFixed(4) : v;
  }
  // keep only the figures that differ from the profile, so data-sourced fields keep their gold outline and source
  ovFor(P.property.id, strat);
  ov[P.property.id][strat] = {};
  if (strat === "rental" && o.price !== undefined) ov[P.property.id].rental.price = o.price;   // tax / insurance defaults follow the price
  const { meta } = inputsFor(P, strat);
  for (const fl of FIELDS[strat]) {
    if (!(fl.k in o)) continue;
    const dv = meta[fl.k]?.def, v = o[fl.k];
    const same = fl.t === "bool" ? !!dv === !!v : (v == null && dv == null) || (f.ok(v) && f.ok(dv) && Math.abs(v - dv) < (fl.t === "pct" ? 1e-4 : 0.005));
    if (same) delete o[fl.k];
  }
  ov[P.property.id][strat] = o;
  persist();
  tab = strat; pref("uw.tab", strat); last.key = "";
  toast(`Loaded "${s.name}"`);
  rerender();
}

/* ---------- export ---------- */

function exportCsv(P) {
  const slug = f.street(P.property.address).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (!last.res || last.strategy !== tab) { toast("Nothing to export yet", "bad"); return; }
  if (tab === "rental") {
    const cols = ["year", "gross", "vacancy", "egi", "taxes", "insurance", "mgmt", "maint", "opex", "noi", "capex", "debt", "cash_flow", "balance"].map(k => ({ k }));
    csv(`valora-proforma-${slug}.csv`, cols, last.res.proforma || []);
  } else {
    const rows = [...Object.entries(last.body.inputs).map(([k, v]) => ({ kind: "input", k, v })), ...Object.entries(last.res).map(([k, v]) => ({ kind: "result", k, v }))];
    csv(`valora-${tab}-${slug}.csv`, [{ k: "kind" }, { k: "k", csv: "field" }, { k: "v", csv: "value" }], rows);
  }
}

/* ---------- Street View (Google, opens in the browser; the inspector and Property page carry the 3D map) ---------- */

async function openStreet(P) {
  const p = P.property;
  if (!(f.ok(p?.lat) && f.ok(p?.lon))) { toast("No coordinates for this address: look it up again from the search bar", "bad"); return; }
  try { const sv = await get(streetView(p.lat, p.lon)); if (sv?.link) openExternal(sv.link); } catch (e) { toast(String(e.message || e), "bad"); }
}
