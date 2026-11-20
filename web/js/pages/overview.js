// Overview — property register, shared map selection, and operating figures for the selected asset.
import { S, esc, f, get, go, post } from "../core.js";
import { bind, btn, chips, confirmModal, empty, formModal, panel, selectBox, table, toast, useCss } from "../ui.js";
import { mapView } from "../map.js";

useCss("overview");

const q = (root, id) => root.querySelector("#ov-" + id);
const filters = { q: "", asset: "", status: "", price: "", performance: "" };
let selected = null, eventsView = "activity", basis = "", workspace = null;
let map = null, mapEl = null, mapPending = null;
const openDeal = d => d.stage !== "rejected" && d.stage !== "acquired";
const rent = r => r.reported_rent ?? r.rent_est;
const amount = r => (r.owned ? r.value_est : null) ?? r.price ?? r.ask ?? r.value_est;
const currency = () => S.state?.demo ? "USD" : S.state?.config?.currency || "USD";

const cols = [
  { k: "address", label: "Property", l: true, fmt: (v, r) => `<button class="ov-address" data-act="select" data-id="${r.id}"><b>${esc(f.street(v))}</b><small>${esc(f.city(v) || [r.city, r.state].filter(Boolean).join(", "))}</small></button>` },
  { k: "asset_class", label: "Asset class", l: true, fmt: esc },
  { k: "status", label: "Status", l: true, fmt: esc },
  { k: "amount", label: "Ask / Value", val: amount, fmt: (v, r) => r.value_source && v === r.value_est
    ? `<span title="${esc(r.value_source)}">${f.cusd(v)}</span>` : f.cusd(v) },
  { k: "rent", label: "Rent / mo", val: rent, fmt: (v, r) => f.usd(rent(r)) },
  { k: "budget_net_month", label: "Net / mo", fmt: v => f.susd(v, v % 1 ? 2 : 0), cls: f.cls,
    title: "Budgeted monthly rent minus listed costs, including mortgage payments" },
  { k: "cap_gross", label: "Gross yield", fmt: v => f.pct(v), title: "Annual rent divided by asking price or value, before costs" },
];

function kpi(label, value, detail, page) {
  const attr = page ? `data-go="${page}"` : 'data-act="exceptions"';
  return `<button ${attr}><span>${label}</span><b>${value}</b><small>${detail}</small></button>`;
}

function renderMetrics(root, d) {
  const m = d.metrics;
  const flagged = new Set(d.attention.map(a => a.property_id).filter(Boolean)).size;
  q(root, "metrics").innerHTML =
    kpi("Properties tracked", f.int(m.tracked), `${m.owned} owned · ${m.listings} sale listings`, "properties") +
    kpi("Pipeline value", f.cusd(m.pipeline_value), `Active deals · ${currency()}`, "pipeline") +
    kpi("Active opportunities", f.int(m.active_deals), `${d.deals.filter(r => r.stage === "diligence").length} in due diligence`, "pipeline") +
    (m.budgeted_properties
      ? kpi("Budget net / mo", f.susd(m.budget_net_month, m.budget_net_month % 1 ? 2 : 0), `${m.budgeted_properties} of ${m.owned} owned properties`, "portfolio")
      : kpi("Avg. projected IRR", f.pct(m.avg_irr), m.irr_n ? `Across ${m.irr_n} modeled deals` : "No modeled deals", "pipeline")) +
    kpi("Portfolio value", f.cusd(m.portfolio_value), m.portfolio_value == null ? "No valuations on file" : `${currency()}${f.ok(m.value_chg_12m) ? " · " + f.spct(m.value_chg_12m) + " over 12 months" : ""}`, "portfolio") +
    kpi("Properties needing attention", f.int(flagged), `${d.attention.length} open exceptions`);
}

const option = (v, label) => ({ v, label });
function buildFilters(root, rows) {
  const classes = [...new Set(rows.map(r => r.asset_class))].sort();
  if (!classes.includes(filters.asset)) filters.asset = "";
  q(root, "filters").innerHTML =
    `<label class="fld"><input data-input="q" value="${esc(filters.q)}" placeholder="Address or ZIP" aria-label="Address or ZIP" style="width:150px;text-align:left"></label>`
    + selectBox("asset", [option("", "All asset classes"), ...classes], filters.asset, { title: "Asset class" })
    + selectBox("status", [option("", "All statuses"), option("owned", "Owned"), option("deal", "In pipeline"), option("listed", "Listed"), option("tracked", "Tracked")], filters.status, { title: "Status" })
    + selectBox("price", [option("", "Any price"), option("low", "Under $250K"), option("mid", "$250K–$400K"), option("high", "$400K and up")], filters.price, { title: "Price range" })
    + selectBox("performance", [option("", "Any return"), option("yield", "Gross yield ≥ 8%"), option("irr", "Projected IRR ≥ 15%")], filters.performance, { title: "Performance" })
    + btn("clear", "Clear", { cls: "ghost" }) + '<span class="ov-count" id="ov-count" role="status"></span>';
}

function matches(r, d) {
  const needle = filters.q.trim().toLowerCase(), v = amount(r);
  if (needle && ![r.address, r.city, r.zip].some(s => String(s || "").toLowerCase().includes(needle))) return false;
  if (filters.asset && filters.asset !== r.asset_class) return false;
  if (filters.status && filters.status !== r.status_kind) return false;
  if (filters.price && !f.ok(v)) return false;
  if (filters.price === "low" && v >= 250000 || filters.price === "mid" && (v < 250000 || v >= 400000) || filters.price === "high" && v < 400000) return false;
  if (filters.performance === "yield") return r.cap_gross >= .08;
  if (filters.performance === "irr") return d.deals.some(x => x.property_id === r.id && openDeal(x) && x.irr >= .15);
  return true;
}

function mapped(r) { return f.ok(r.lat) && f.ok(r.lon); }

function mapPoints(rows) {
  const palette = { owned: "#e4e4e4", deal: "#a3a3a3", listed: "#6a6a6a", tracked: "#888888" };
  return rows.filter(mapped).map(r => ({
    id: r.id, lat: r.lat, lon: r.lon, color: palette[r.status_kind],
    label: f.street(r.address),
    html: `<b>${esc(f.street(r.address))}</b><br>${esc(r.status)} · ${f.cusd(amount(r))}`,
  }));
}

function drawMap(root, rows, fit) {
  const slot = q(root, "map"), pts = mapPoints(rows);
  if (!pts.length) {
    if (slot.contains(mapEl)) mapEl.hidden = true;
    q(root, "map-empty").hidden = false;
    q(root, "map-fit").disabled = true;
    return;
  }
  q(root, "map-empty").hidden = true;
  q(root, "map-fit").disabled = false;
  if (!mapEl) {
    mapEl = document.createElement("div");
    slot.append(mapEl);
    const pending = mapView(mapEl, { points: pts, selected, labels: false, onClick: id => choose(root, +id) });
    mapPending = pending;
    pending.then(view => {
      if (mapPending !== pending) { view.destroy(); return; }
      map = view;
      drawMap(root, root.__ov.visible, true);
    }).catch(() => {
      if (mapPending === pending) q(root, "map-empty").hidden = false;
    });
    return;
  }
  mapEl.hidden = false;
  map?.setPoints(pts, { fit });
  map?.select(selected);
}

function choose(root, id) {
  if (!root.__ov.visible.some(r => r.id === id)) return;
  if (id !== selected) basis = "";
  selected = id;
  root.__ov.table?.setSel(id);
  map?.select(id);
  renderRecord(root);
}

function drawRegister(root, fit = false) {
  const v = root.__ov;
  v.visible = v.rows.filter(r => matches(r, v.data));
  if (!v.visible.some(r => r.id === selected)) {
    selected = v.visible[0]?.id ?? null;
    basis = "";
  }
  q(root, "count").textContent = `${f.int(v.visible.length)} of ${f.int(v.rows.length)} properties`;
  v.table = table(q(root, "table"), {
    id: "ov-register", rows: v.visible, cols, key: r => r.id, sel: selected,
    sort: { k: "status", dir: 1 }, limit: 125, empty: "No properties match this view.",
    onRow: r => choose(root, r.id), onDbl: r => go("property", r.id),
  });
  root.querySelector(".ov-work").classList.toggle("ov-unmapped", !v.rows.some(mapped));
  drawMap(root, v.visible, fit);
  renderRecord(root);
}

function renderRecord(root) {
  const v = root.__ov, r = v.byId.get(selected), owned = v.data.owned.find(p => p.property_id === selected);
  const deal = v.data.deals.find(d => d.property_id === selected);
  if (!r) {
    q(root, "record").innerHTML = '<div class="note">Select a property to see its figures.</div>';
    renderOperating(root, null, null);
    return;
  }
  const cells = [
    [r.value_is_assessed && amount(r) === r.value_est ? "Assessed value" : r.owned && r.value_est ? "Est. value" : r.price || r.ask ? "Asking price" : "Est. value", f.usd(amount(r))],
    [r.reported_rent != null ? "Reported rent / mo" : "Est. rent / mo", f.usd(rent(r))],
    f.ok(r.budget_net_month)
      ? ["Net / mo", f.susd(r.budget_net_month, r.budget_net_month % 1 ? 2 : 0)]
      : [f.ok(deal?.irr) ? "Projected IRR" : "Gross yield", f.pct(deal?.irr ?? r.cap_gross)],
    ["Size", `${f.int(r.units)} units · ${f.bb(r)}`],
  ];
  q(root, "record").innerHTML = `<div class="ov-record-head">
    <div><b>${esc(f.street(r.address))}</b><small>${esc(f.city(r.address))} · ${esc(r.asset_class)}</small></div>
    <span class="ov-record-status">${esc(r.status)}</span>
  </div><dl class="ov-record-facts">${cells.map(([k, value]) => `<div><dt>${k}</dt><dd>${value}</dd></div>`).join("")}</dl>
  <div class="ov-record-actions"><span>${currency()}${r.value_is_assessed ? " · " + esc(r.value_source) : ""}${mapped(r) ? "" : " · Location not mapped"}</span>
    <span><button class="btn ghost" data-prop="${r.id}" data-go="property">Open property ↗</button>
    ${mapped(r) ? btn("center", "Center map") : ""}</span>
  </div>`;
  renderOperating(root, r, owned);
}

function monthly(item) { return item.cadence === "annual" ? item.amount / 12 : item.amount; }

function operatingValues(owned, budgetMode) {
  if (!budgetMode) return [
    { name: "Rent collected", value: owned.income },
    { name: "Operating expenses", value: owned.opex },
    { name: "Debt service", value: owned.debt_service },
    { name: "Net after recorded costs", value: owned.cf },
  ];
  const rentLines = owned.budget.filter(item => item.kind === "rent");
  const costs = owned.budget.filter(item => item.kind === "expense");
  const sum = lines => lines.reduce((total, item) => total + monthly(item), 0);
  const income = rentLines.length ? sum(rentLines) : null;
  return [
    { name: "Reported rent", value: income },
    ...costs.map(item => ({ name: item.name, value: monthly(item) })),
    { name: "After listed costs", value: income == null ? null : income - sum(costs) },
  ];
}

function mixVisual(list) {
  const income = list[0].value, net = list.at(-1).value;
  const costs = list.slice(1, -1).reduce((sum, row) => sum + (row.value || 0), 0);
  if (!(income > 0 || costs > 0)) return "";
  if (net < 0 || income == null || list.slice(1, -1).some(row => row.value < 0)) {
    const max = Math.max(income || 0, costs, 1);
    return `<div class="ov-bars" aria-label="Rent and costs comparison">
      <span>Rent</span><i style="--measure:${100 * (income || 0) / max}%"></i>
      <span>Costs</span><i style="--measure:${100 * costs / max}%"></i>
    </div>`;
  }
  const shades = ["#555555", "#777777", "#a3a3a3", "#bcbcbc"];
  let start = 0;
  const stops = list.slice(1, -1).map(({ value }, i) => {
    const next = start + 100 * value / income;
    const stop = `${shades[i % shades.length]} ${start}% ${next}%`;
    start = next;
    return stop;
  }).filter((_, i) => list[i + 1].value > 0);
  if (!stops.length) return "";
  const background = `conic-gradient(${[...stops, `var(--ov-retained) ${start}% 100%`].join(",")})`;
  return `<div class="ov-donut" style="--mix:${background}" aria-label="Expenses as a share of rent"><b>${f.pct(net / income, 0)}</b><small>remaining</small></div>`;
}

function renderOperating(root, r, owned) {
  const el = q(root, "operating");
  q(root, "op-title").textContent = r ? f.street(r.address) : "";
  if (!owned) {
    q(root, "op-controls").innerHTML = "";
    el.innerHTML = '<div class="note">Rent and costs appear here for owned properties. Select an owned asset to view its figures.</div>';
    return;
  }
  const mode = basis || (owned.budget.length ? "budget" : "recorded");
  const budgetMode = mode === "budget";
  q(root, "op-controls").innerHTML = chips("basis", [option("budget", "Monthly budget"), option("recorded", "Recorded · 12m")], mode);
  const lines = operatingValues(owned, budgetMode);
  const haveData = budgetMode ? owned.budget.length > 0 : lines.slice(0, -1).some(line => line.value !== 0);
  const memo = budgetMode ? "Reported figures. Annual costs are divided by 12. Includes any mortgage payment in this budget." : "Source: recorded payments and expenses, plus scheduled debt service over 12 months.";
  el.innerHTML = (haveData ? `<div class="ov-operating-body">${mixVisual(lines)}<dl class="ov-money-lines">${lines.map((row, i) =>
    `<div><dt>${esc(row.name)}</dt><dd class="${i === lines.length - 1 && row.value < 0 ? "down" : ""}">${f.usd(row.value, budgetMode && row.value % 1 ? 2 : 0)}</dd></div>`).join("")}</dl></div>`
    : `<div class="note">${budgetMode ? "Add monthly rent and recurring expenses for this property." : "No payments or costs recorded for this property yet."}</div>`) +
    `<div class="ov-op-foot"><span>${currency()} · ${memo}</span>${budgetMode ? btn("budget", "Add item") : ""}</div>` +
    (budgetMode && owned.budget.length ? `<details class="ov-budget"><summary>Budget items</summary>
      ${owned.budget.map(item => `<button class="ov-budget-item" data-act="budget-line" data-id="${item.id}"><span>${esc(item.name)}</span>
      <span>${f.usd(item.amount)} / ${item.cadence === "annual" ? "yr" : "mo"}</span></button>`).join("")}</details>` : "");
}

async function editBudget(root, id = null) {
  const pid = selected;
  const owned = root.__ov.data.owned.find(r => r.property_id === pid);
  if (!owned) return;
  const item = owned.budget.find(r => r.id === id);
  const result = await formModal(item ? "Edit budget item" : "Add budget item", [
    { k: "name", label: "Name", value: item?.name || "", req: true, full: true },
    { k: "kind", label: "Type", type: "select", value: item?.kind || "expense", options: [option("rent", "Rent"), option("expense", "Expense")] },
    { k: "cadence", label: "Frequency", type: "select", value: item?.cadence || "monthly", options: [option("monthly", "Monthly"), option("annual", "Annual")] },
    { k: "amount", label: `Amount (${currency()})`, type: "number", value: item?.amount, req: true },
  ], { ok: "Save", danger: item ? "Remove item" : null, note: "Budget entries do not create charges, payments, or expenses in the ledger." });
  if (!result) return;
  if (result.__danger) {
    if (!(await confirmModal("Remove budget item", `Remove ${esc(item.name)} from this budget?`, "Remove"))) return;
    const r = await post("/api/portfolio", { act: "delete", table: "budget", id: item.id });
    toast(r.error || "Budget item removed", r.error ? "bad" : "");
    return;
  }
  const r = await post("/api/portfolio", { act: item ? "edit" : "add", table: "budget", id: item?.id,
    data: { ...result, property_id: pid } });
  toast(r.error || "Budget item saved", r.error ? "bad" : "");
}

function renderPipeline(root, d) {
  const active = d.deals.filter(openDeal);
  q(root, "pipeline").innerHTML = active.length ? `<table class="t ov-mini"><thead><tr><th class="l">Stage</th><th>Deals</th><th>Asking</th></tr></thead><tbody>${
    d.stages.filter(s => s.id !== "rejected" && s.id !== "acquired").map(stage => {
      const deals = active.filter(deal => deal.stage === stage.id);
      const ask = deals.reduce((total, deal) => total + (deal.ask || 0), 0);
      return `<tr><td class="l">${esc(stage.label)}</td><td>${deals.length}</td><td>${deals.length ? f.cusd(ask) : f.DASH}</td></tr>`;
    }).join("")}</tbody></table>` : '<div class="note">No active deals. Add properties to the pipeline to track them here.</div>';
}

function renderEvents(root, d) {
  q(root, "event-tabs").innerHTML = chips("event", [option("activity", "Activity"), option("upcoming", "Deadlines"), option("attention", "Exceptions")], eventsView);
  const rows = d[eventsView].slice(0, 7);
  q(root, "events").innerHTML = rows.length ? `<table class="t ov-mini ov-events"><tbody>${rows.map(event => {
    const date = event.ts || event.due;
    const first = eventsView === "attention" ? f.street(event.address) : date ? f.date(date) : f.DASH;
    const text = esc(event.title || event.text);
    const destination = event.go || (event.kind === "lease" ? "rentroll" : event.kind === "task" ? "pipeline" : "property");
    return `<tr><td class="l">${esc(first)}</td><td class="l" title="${text}">${event.property_id
      ? `<button data-go="${esc(destination)}" data-prop="${+event.property_id}">${text}</button>` : text}</td></tr>`;
  }).join("")}</tbody></table>` : `<div class="note">${{ activity: "No recent activity.", upcoming: "No upcoming deadlines.", attention: "No open exceptions." }[eventsView]}</div>`;
}

function build(root) {
  root.innerHTML = `<div id="ov-metrics" class="ov-metrics"></div>
    <div id="ov-filters" class="ov-filters"></div>
    <div class="ov-work">
      ${panel({ title: "Property register", cls: "ov-register", flush: true, body: '<div id="ov-table" class="tbl-host grow"></div>' })}
      ${panel({ title: "Property map", cls: "ov-map-panel", right: '<button id="ov-map-fit" class="btn ghost" data-act="fit">Fit results</button>', flush: true,
        body: '<div id="ov-map" class="no-swipe"><p id="ov-map-empty" hidden>No mapped locations in this view.</p></div>' })}
      ${panel({ title: "Selected property", cls: "ov-record", flush: true, body: '<div id="ov-record"></div>' })}
    </div>
    <div class="ov-lower">
      ${panel({ title: "Rent and costs", sub: '<span id="ov-op-title"></span>', cls: "ov-operating", right: '<div class="ov-inline" id="ov-op-controls"></div>', flush: true, body: '<div id="ov-operating"></div>' })}
      ${panel({ title: "Deal pipeline", right: btn("pipeline", "Open ↗", { cls: "ghost" }), flush: true, body: '<div id="ov-pipeline"></div>' })}
      ${panel({ title: "Activity", right: '<div class="ov-inline" id="ov-event-tabs"></div>', flush: true, body: '<div id="ov-events"></div>' })}
    </div>`;
}

export default {
  id: "overview",
  deps: ["prop"],
  async render(root, ctx) {
    const [data, rows] = await Promise.all([get("/api/overview"), get("/api/properties")]);
    if (workspace !== !!S.state?.demo) {
      workspace = !!S.state?.demo;
      selected = null;
      basis = "";
      Object.keys(filters).forEach(k => { filters[k] = ""; });
    }
    if (ctx.reason === "prop" && rows.some(r => r.id === S.pid)) {
      selected = S.pid;
      basis = "";
    }
    if (selected == null) selected = rows.find(r => r.id === S.pid)?.id ?? rows[0]?.id ?? null;
    root.__ov = { data, rows, byId: new Map(rows.map(r => [r.id, r])), visible: [] };
    ctx.sub.innerHTML = `<span class="mut">${currency()}${workspace ? " · Sample data" : " · Your workspace"}</span>`;
    ctx.bar.innerHTML = "";
    if (!q(root, "table")) build(root);
    renderMetrics(root, data);
    buildFilters(root, rows);
    drawRegister(root, true);
    renderPipeline(root, data);
    renderEvents(root, data);
    const apply = (k, value) => { filters[k] = value; drawRegister(root, true); };
    bind(root, {
      "input:q": value => apply("q", value),
      ...Object.fromEntries(["asset", "status", "price", "performance"].map(k => [`change:${k}`, value => apply(k, value)])),
      "act:clear": () => { Object.keys(filters).forEach(k => { filters[k] = ""; }); buildFilters(root, rows); drawRegister(root, true); },
      "act:select": el => choose(root, +el.dataset.id),
      "act:fit": () => drawMap(root, root.__ov.visible, true),
      "act:center": () => { const r = root.__ov.byId.get(selected); if (r && mapped(r)) map?.flyTo(r.lat, r.lon, 15); },
      "act:pipeline": () => go("pipeline"),
      "act:exceptions": () => { eventsView = "attention"; renderEvents(root, data); q(root, "events").scrollIntoView({ block: "nearest" }); },
      "act:budget": () => editBudget(root),
      "act:budget-line": el => editBudget(root, +el.dataset.id),
      "chip:event": value => { eventsView = value; renderEvents(root, data); },
      "chip:basis": value => { basis = value; renderRecord(root); },
    });
  },
  leave() {
    // Destroy the map when leaving so hidden pages do not retain a WebGL context.
    mapPending = null;
    map?.destroy();
    mapEl?.remove();
    map = mapEl = null;
  },
};
