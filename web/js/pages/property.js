// Property — the full profile of the selected property: hero with facts, a 3D map and street view, value and rent
// estimates with range, source and date, asking vs value, quick returns with their assumptions, the score, tax and
// sale history, ZIP trends, what is missing, documents and every action on it.
import { S, f, get, post, go, select, esc, streetView, openExternal, today } from "../core.js";
import { table, panel, kv, btn, sep, bind, toast, formModal, confirmModal, useCss, src, pill } from "../ui.js";
import { mapView } from "../map.js";
import * as C from "../charts.js";
import { ladder, openStreet } from "./comps.js";
import { addOwnedFromAddress } from "./portfolio.js";

useCss("property");

let map = null, mapEl = null, mapP = null, mapPid = null;

const FACTORS = [
  { k: "cashflow", label: "Cash flow", drv: q => f.pct(q.coc), band: "CoC −5% … 12%" },
  { k: "cap", label: "Cap rate", drv: q => f.pct(q.cap, 2), band: "3% … 10%" },
  { k: "discount", label: "Discount", drv: q => f.spct(q.discount), band: "value ÷ price −10% … +15%" },
  { k: "momentum", label: "Momentum", drv: q => f.spct(q.momentum), band: "ZIP value + rent 1y −4% … 8%" },
  { k: "negotiable", label: "Negotiable", drv: (q, p) => f.days(p.dom), band: "DOM 0 … 120" },
  { k: "risk", label: "Data confidence", drv: () => "", band: "estimates present, range width, age" },
];
const TYPES = ["Single Family", "Multi-Family", "Townhouse", "Condo", "Manufactured", "Land"];
const srcKind = s => (/your|manual/i.test(s || "") ? "m" : /assum|rough|default/i.test(s || "") ? "x" : /bill|record|assessor/i.test(s || "") ? "v" : "e");
const isMine = e => /your|manual/i.test(e?.source || "");
const earth = (lat, lon) => `https://earth.google.com/web/@${+lat},${+lon},260a,420d,35y,0h,62t,0r`;
const propertySites = {
  zillow: "https://www.zillow.com/c/canada/canada-homes/",
  realtor: "https://www.realtor.ca/",
  assessment: "https://www.bcassessment.ca/Property/AssessmentSearch",
};

function sourceDescription(ref) {
  if (ref.kind === "location") return "Address and coordinates";
  const row = JSON.parse(ref.fields || "{}");
  if (ref.kind === "assessment") return `${row.year} assessment · CAD ${f.int(row.assessed_total)}${row.valuation_date ? " · valued " + f.dateY(row.valuation_date) : ""}`;
  if (ref.kind === "provider") return [
    row.beds != null && `${f.int(row.beds)} beds`,
    row.baths != null && `${f.num(row.baths, row.baths % 1 ? 1 : 0)} baths`,
    row.sqft != null && `${f.int(row.sqft)} sf floor area`,
    row.lot != null && `${f.int(row.lot)} sf lot`,
    row.year_built != null && `Built ${row.year_built}`,
    row.rent != null && `${row.currency} ${f.num(row.rent, row.rent % 1 ? 2 : 0)} estimated rent / mo`,
    row.value != null && `${row.currency} ${f.num(row.value, row.value % 1 ? 2 : 0)} estimated value`,
  ].filter(Boolean).join(" · ");
  if (ref.kind !== "municipal") return "User-reviewed listing import";
  return [
    row.zoning && `Zoning ${row.zoning}`,
    row.pid && `PID ${row.pid}`,
    f.ok(row.assessed_total) && `${row.assessment_year || ""} assessment · CAD ${f.int(row.assessed_total)}`.trim(),
    f.ok(row.lot) && `Mapped lot ${f.int(row.lot)} sf`,
  ].filter(Boolean).join(" · ") || "Municipal address and map pin";
}

function dataPanel(P) {
  const p = P.property, bc = /^(?:bc|b\.c\.?|british columbia)$/i.test(p.state || "");
  const refs = P.sources || [];
  return panel({ title: "Property data", flush: true,
    right: (bc ? btn("municipal-data", "Pull municipal data", { cls: "pri" }) + btn("bc-address", "Look up B.C. address") : "")
      + btn("listing-data", "Import listing facts", { cls: bc ? "" : "pri" })
      + '<button class="btn ghost" data-go="setup">Data connections ↗</button>',
    body: `<div class="pp-data-links">
      ${btn("zillow", "Zillow ↗", { cls: "ghost" })}${btn("realtor", "REALTOR.ca ↗", { cls: "ghost" })}
      ${bc ? btn("assessment", "BC Assessment ↗", { cls: "ghost" }) : ""}
    </div>` + (refs.length ? `<table class="t pp-data-table"><thead><tr><th class="l nosort">Source</th><th class="l nosort">Data</th><th class="nosort">Saved</th></tr></thead><tbody>
      ${refs.map(ref => `<tr><td class="l">${ref.url ? btn("open-data-source", ref.source + " ↗", { cls: "ghost", attrs: `data-id="${ref.id}"` }) : esc(ref.source)}</td>
      <td class="l">${esc(sourceDescription(ref))}</td><td>${f.dateY(ref.imported)}</td></tr>`).join("")}</tbody></table>` : ""),
  });
}

/** ZHVI value at (or just before) a date, from a [{date,value}] series. */
function idxAt(series, d) {
  let v = null;
  for (const x of series || []) { if (x.date <= d) v = x.value; else break; }
  return v;
}

async function ensureMap(slot, pts, fit) {
  if (!mapEl) {
    mapEl = document.createElement("div");
    mapEl.className = "pp-map";
    slot.replaceWith(mapEl);
    mapP = mapView(mapEl, { points: pts, tilt3d: true, labels: true, onClick: id => {
      const c = (S.prop?.comps || []).find(x => String(x.id) === String(id));
      if (c) select({ kind: "comp", id: c.id, row: c });
    } });
    const mine = mapP, m = await mine;
    if (mapP !== mine) { m.destroy(); return; }   // page left while the map was loading
    map = m;
    map.setPoints(pts, { fit: true });
    return;
  }
  slot.replaceWith(mapEl);
  if (!map) { const mine = mapP, m = await mine; if (mapP !== mine) return; map = m; }
  map.setPoints(pts, { fit });
}

export default {
  id: "property",
  async render(root, ctx) {
    const P = S.prop, p = P.property, pid = p.id;
    const L = P.listing, ask = L?.price ?? p.price ?? null, q = P.quick || null;
    const hasLL = f.ok(p.lat) && f.ok(p.lon);
    const mappedComps = (P.comps || []).filter(c => f.ok(c.lat) && f.ok(c.lon));
    const hasMap = hasLL || mappedComps.length > 0;
    const [cmp, sv, zipRows, pf] = await Promise.all([
      get(`/api/comps/${pid}`).catch(() => null),
      hasLL ? get(streetView(p.lat, p.lon)).catch(() => null) : null,
      p.zip && q ? get(`/api/listings?kind=sale&zip=${encodeURIComponent(p.zip)}`).catch(() => null) : null,
      P.owned ? get("/api/portfolio").catch(() => null) : null,
    ]);
    if (S.prop !== P) return;
    const demo = p.source === "DEMO";
    const own = pf?.properties?.find(x => x.id === pid) || null;

    /* ---------- command bar ---------- */
    const deal = P.deal;
    ctx.sub.innerHTML = btn("uw", "Underwrite", { cls: "pri", title: "Open the model (4)" }) + btn("comps", "Comps", { title: "Adjustment grid (8)" })
      + (deal ? btn("deal", `Pipeline: ${stageLabel(deal.stage)}`, { title: "Open this deal on the pipeline" }) : btn("pipe", "+ Pipeline", { title: "Add to the acquisition pipeline as Discovered" }))
      + btn("owned", P.owned ? "Purchase" : "Mark owned", { title: P.owned ? "Edit purchase price, date, closing and rehab" : "Record the purchase; the property moves to Portfolio" })
;   // estimate and fact actions sit on their panels so the toolbar fits at 1100px
    ctx.bar.innerHTML = "";
    bind(ctx.sub, {
      "act:uw": () => go("underwrite", pid), "act:comps": () => go("comps", pid), "act:deal": () => go("pipeline"),
      "act:pipe": () => addPipeline(P, ask, q), "act:owned": () => markOwned(P, ask),
    });

    /* ---------- hero ---------- */
    const status = [];
    if (L) status.push(pill(`${L.status || "Listed"} · ${f.days(L.dom)} on market`, L.status === "Active" ? "up" : ""));
    if (P.owned) status.push(pill("Owned", "amb"));
    if (deal) status.push(pill(`Pipeline · ${stageLabel(deal.stage)}`, ""));
    if (demo) status.push(`<span class="tag amb" title="Every figure for this property is generated demo data">Demo</span>`);
    const facts = [
      ["Type", esc(p.type || f.DASH)], ["Units", f.int(p.units)], ["Beds / baths", `${f.ok(p.beds) ? +p.beds : f.DASH} / ${f.ok(p.baths) ? +p.baths : f.DASH}`], ["Living area", f.sqft(p.sqft)],
      ["Lot", f.sqft(p.lot)], ["Built", p.year_built ? String(p.year_built) : f.DASH],
      [f.ok(ask) ? "$ / sf at ask" : "$ / sf at value", f.ok(ask) && p.sqft ? f.usd(ask / p.sqft) : f.ok(P.value?.value) && p.sqft ? f.usd(P.value.value / p.sqft) : f.DASH],
      ["Last sale", p.last_sale_price ? `${f.cusd(p.last_sale_price)}${p.last_sale_date ? " · " + String(p.last_sale_date).slice(0, 4) : ""}` : f.DASH],
      ["Listed", L ? `${f.dateY(L.listed)}` : f.DASH], ["County", esc((p.county || f.DASH).replace(/ County$/, ""))],
      ["Owner", esc(p.owner_name || f.DASH)], ["Tags", esc(p.tags || f.DASH)],
    ].filter(([, value]) => value !== f.DASH && value !== `${f.DASH} / ${f.DASH}`);
    const assessed = P.value?.basis === "assessment";
    const rangeSub = e => (e ? (f.ok(e.low) ? `${f.cusd(e.low)}–${f.cusd(e.high)}` : isMine(e) || e.basis === "assessment" ? `${esc(e.source || "Your figure")}${e.as_of ? " · " + f.dateY(e.as_of) : ""}` : "no range") : "Estimate needed");
    const rangeTip = e => (e ? `${e.source || ""} ${e.as_of || ""}${e.n ? " · " + e.n + " comps" : ""}` : "");
    const gap = f.ok(ask) && f.ok(P.value?.value) ? P.value.value / ask - 1 : null;
    const editB = btn("edit", "Edit facts", { title: "Correct beds, baths, area, lot, year, units, type, tags and notes" });
    const svLine = hasLL ? (sv?.embed ? `<div class="pp-svl">${editB}<span class="faint">Street View is below.</span></div>` : `<div class="pp-svl">${editB}${btn("sv2", "Street View ↗", { title: "Google Street View at this address (opens the browser)" })}${btn("earth2", "Earth 3D ↗", { title: "Google Earth photorealistic 3D at this address (opens the browser)" })}<span class="faint">A Google Maps key in <a class="link" data-go="settings">Settings</a> embeds Street View here (the Embed API is free).</span></div>`)
      : `<div class="pp-svl">${editB}<span class="faint">Property location unavailable</span></div>`;
    const figures = [
          L || !P.owned ? { k: "Asking", v: f.usd(ask), sub: L ? esc(L.source === "DEMO" ? "demo listing" : L.source || "") : "not listed" } : null,
          { k: assessed ? "Assessed value" : "Estimated value", v: f.usd(P.value?.value), sub: rangeSub(P.value), title: rangeTip(P.value) },
          { k: P.rent?.source === "your reported rent" ? "Reported monthly rent" : "Est. monthly rent", v: f.usd(P.rent?.value), sub: rangeSub(P.rent), title: rangeTip(P.rent) },
          L || !P.owned ? { k: "Vs asking", v: f.spct(gap), cls: f.cls(gap), sub: "value ÷ ask − 1", title: "Value estimate ÷ asking − 1 (positive: asking is below value)" }
            : { k: "Vs paid", v: f.spct(f.ok(P.value?.value) && P.owned.purchase_price ? P.value.value / P.owned.purchase_price - 1 : null), cls: f.cls(f.ok(P.value?.value) && P.owned.purchase_price ? P.value.value - P.owned.purchase_price : null), sub: "before closing and rehab" },
          q && f.ok(q.cap) ? { k: "Cap at ask", v: f.pct(q.cap, 2), sub: `CoC ${f.pct(q.coc)}` } : null,
          q && f.ok(q.cf) ? { k: "Cash flow", v: `${f.susd(q.cf)}<small class="pp-u">/mo</small>`, cls: f.cls(q.cf), sub: `DSCR ${f.x(q.dscr)}`, title: "Monthly cash flow after debt service, at the asking price" } : null,
          !q && P.owned ? { k: "Paid", v: f.usd(P.owned.purchase_price), sub: f.dateY(P.owned.purchase_date) } : null,
    ].filter(Boolean);
    const figureLedger = `<dl class="pp-ledger">${figures.map(({ k, v, sub, cls, title }) => `
      <div${title ? ` title="${esc(title)}"` : ""}>
        <dt>${esc(k)}${sub ? `<small>${sub}</small>` : ""}</dt>
        <dd class="${cls || ""}">${v}</dd>
      </div>`).join("")}</dl>`;
    const hero = `<section class="pp-summary">
      <div class="pp-overview${hasMap ? "" : " pp-unmapped"}">
        <section class="pp-financials" aria-label="Property financials">${figureLedger}</section>
        ${hasMap ? '<div id="pp-map-slot" class="pp-map"></div>' : ""}
        <div class="pp-record">
          <div class="pp-record-head">
            <div><h2>Property details</h2>
            <div class="s sel-text">${esc(f.city(p.address) || [p.city, [p.state, p.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "))}${p.county ? " · " + esc(p.county) : ""}</div></div>
            ${status.length ? `<div class="pp-st">${status.join(" ")}</div>` : ""}
          </div>
          ${facts.length ? `<dl class="pp-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd class="sel-text">${v}</dd></div>`).join("")}</dl>` : ""}
          ${svLine}
          ${p.notes ? `<div class="note sel-text"><b>Notes</b> · ${esc(p.notes)}</div>` : ""}
        </div>
      </div>
    </section>`;

    /* ---------- valuation ---------- */
    const recS = cmp?.value, recR = cmp?.rent_value;
    const zv = idxAt(P.zhvi, p.last_sale_date || ""), zNow = P.zhvi?.length ? P.zhvi[P.zhvi.length - 1] : null;
    const idxVal = p.last_sale_price && zv && zNow ? p.last_sale_price * zNow.value / zv : null;
    const paidRef = !f.ok(ask) && f.ok(P.owned?.purchase_price) ? P.owned.purchase_price : null;
    const ref = ask ?? paidRef, refL = paidRef != null ? "vs paid" : "vs ask";
    const estRows = [
      { key: "v", what: "Value", basis: assessed ? "Assessment" : isMine(P.value) ? "Your figure" : "AVM", e: P.value },
      { key: "vc", what: "Value", basis: "Sale comps, reconciled", e: recS ? { ...recS, source: "Your comps grid (Comps page)", as_of: null } : null },
      { key: "vi", what: "Value", basis: "Last sale × ZIP index", e: idxVal && !P.value ? { value: idxVal, n: 0, source: "Last sale × ZIP ZHVI — rough", as_of: zNow.date } : null },
      { key: "r", what: "Rent / mo", basis: isMine(P.rent) ? "Your figure" : "AVM", e: P.rent },
      { key: "rc", what: "Rent / mo", basis: "Rent comps, reconciled", e: recR ? { ...recR, source: "Your comps grid (Comps page)", as_of: null } : null },
    ].filter(r => r.key !== "vi" || r.e).map(r => ({ ...r, value: r.e?.value ?? null, low: r.e?.low ?? null, high: r.e?.high ?? null, n: r.e?.n ?? null, source: r.e?.source || null, as_of: r.e?.as_of || null,
      width: f.ok(r.e?.low) && f.ok(r.e?.high) && r.e?.value ? (r.e.high - r.e.low) / r.e.value : null,
      vsAsk: r.key.startsWith("v") && f.ok(r.e?.value) && f.ok(ref) && ref ? r.e.value / ref - 1 : null }));

    /* ---------- returns ---------- */
    const ins = f.ok(ask) ? Math.max(900, ask * 0.005) : null;
    const assume = q ? `At asking ${f.usd(ask)} · 25% down · 30-yr at ${f.pct(P.ctx?.rate, 2)} (${esc(P.ctx?.rate_src || "")}) · closing 3% · vacancy 5% · management 8% of income · repairs 5% · capex reserve 5% · taxes ${f.usd(P.tax?.amount)} (${esc(P.tax?.src || "")}) · insurance ${f.usd(ins)} (0.5% of price, min $900) · rent ${f.usd(q.rent_est)} (${esc(q.rent_src || "no estimate")}). Underwrite has the full model.` : "";
    let retBody;
    if (q && f.ok(q.cap)) {
      retBody = kv([
        { k: "Cap rate", v: f.pct(q.cap, 2) }, { k: "Cash on cash", v: f.pct(q.coc, 1), cls: f.cls(q.coc) },
        { k: "Cash flow / mo", v: f.susd(q.cf), cls: f.cls(q.cf) }, { k: "DSCR", v: f.x(q.dscr), cls: f.ok(q.dscr) ? (q.dscr >= 1.25 ? "up" : q.dscr < 1 ? "down" : "amb") : "" },
        { k: "GRM", v: f.num(q.grm, 1) }, { k: "Rent ÷ price", v: f.pct(q.one_pct, 2), sub: "1% rule" },
      ], { cls: "pp-g3" }) + `<div class="note">${assume}</div>`;
    } else if (q) {
      retBody = `<div class="empty"><b>No rent estimate, so no returns yet</b><span>Use <a class="link" data-act="myrent2">Set my rent</a>, add rent comps, or add a RentCast key in <a class="link" data-go="settings">Settings</a>.</span></div>`;
    } else if (P.owned) {
      const o = P.owned, cost = (o.purchase_price || 0) + (o.closing_costs || 0) + (o.rehab || 0);
      const val = own?.value ?? P.value?.value;
      const led = own && (own.income || own.opex || own.ds) ? own : null;   // no ledger entries yet: unknown, not $0
      retBody = kv([
        { k: "Bought", v: f.usd(o.purchase_price), sub: f.dateY(o.purchase_date) }, { k: "All-in cost", v: f.usd(o.purchase_price != null ? cost : null), sub: "incl. closing, rehab" },
        { k: "Value", v: f.usd(val), sub: esc(String(own?.value_src || P.value?.source || "").replace(/ \d{4}-\d\d-\d\d$/, "")), title: own?.value_src || P.value?.source || "" }, { k: "Gain", v: f.susd(f.ok(val) && o.purchase_price != null ? val - cost : null), cls: f.cls(f.ok(val) && o.purchase_price != null ? val - cost : null) },
        { k: "Equity", v: f.usd(own?.equity), sub: own ? (own.debt ? `LTV ${f.pct(own.ltv)}` : "no loan recorded") : "" }, { k: "NOI 12m", v: f.usd(led?.noi), sub: led ? "ledger actuals" : "no ledger entries yet" },
        { k: "Cash flow 12m", v: f.susd(led?.cf), cls: f.cls(led?.cf), sub: led ? "after debt service" : "no ledger entries yet" }, { k: "Cap on value", v: f.pct(led?.cap_on_value, 2), sub: led ? "NOI 12m ÷ value" : "" },
        { k: "DSCR", v: f.x(own?.dscr), cls: f.ok(own?.dscr) ? (own.dscr >= 1.25 ? "up" : own.dscr < 1 ? "down" : "amb") : "", sub: own ? (own.units_n ? `occupied ${own.occupied}/${own.units_n}` : "no units yet") : "" },
      ], { cls: "pp-g3" }) + `<div class="note">Trailing 12 months of recorded payments and expenses. Details on <a class="link" data-go="portfolio">Portfolio</a>, <a class="link" data-go="rentroll">Rent roll</a> and <a class="link" data-go="books">Books</a>.</div>`;
    } else {
      retBody = `<div class="empty"><b>Not listed, so no asking-price returns</b><span>Open <a class="link" data-act="uw2">Underwrite</a> and enter a price (it starts from the value estimate).</span></div>`;
    }

    /* ---------- score ---------- */
    let scoreBody = `<div class="empty"><span>${q ? "No score: too few inputs." : "Scored only while listed for sale."}</span></div>`;
    const W = zipRows?.weights || null;
    if (q && f.ok(q.score)) {
      const peers = (zipRows?.rows || []).filter(r => f.ok(r.score)).sort((a, b) => b.score - a.score);
      const rank = peers.findIndex(r => r.id === pid);
      const tw = W ? FACTORS.reduce((t, x) => t + (f.ok(q.score_parts?.[x.k]) ? W[x.k] || 0 : 0), 0) : 0;
      scoreBody = `<div class="pp-score"><div class="pp-sc-h"><span class="big">${f.score(q.score)}</span><span class="mut">/ 100${rank >= 0 ? ` · ranks #${rank + 1} of ${peers.length} listings in ZIP ${esc(p.zip)}` : ""}</span></div>
        <table class="t pp-fac"><thead><tr><th class="l nosort">Factor</th><th class="nosort">Driver</th><th class="l nosort">0 – 100</th><th class="nosort">Wt</th><th class="nosort" title="Weight × factor ÷ total weight">Pts</th></tr></thead><tbody>
        ${FACTORS.map(x => { const v = q.score_parts?.[x.k], w = W?.[x.k]; return `<tr title="Scale: ${esc(x.band)}"><td class="l">${x.label}</td><td>${x.drv(q, p) || f.DASH}</td>
          <td class="l"><span class="pp-bar"><i style="width:${f.ok(v) ? Math.max(0, Math.min(100, v)) : 0}%;background:${f.ok(v) ? (v >= 60 ? "var(--up)" : v < 35 ? "var(--down)" : "var(--amber)") : "none"}"></i></span>${f.score(v)}</td>
          <td>${f.ok(w) ? w : f.DASH}</td><td>${f.ok(v) && f.ok(w) && tw ? f.num(v * w / tw, 1) : f.DASH}</td></tr>`; }).join("")}
        </tbody></table></div><div class="note">Weighted average of the six factors (weights editable on <a class="link" data-go="screen">Screen</a>). A factor without data is left out and the weights re-normalise. Hover a row for its scale.</div>`;
    }

    /* ---------- missing, deal, docs ---------- */
    const miss = (P.missing || []).map(m => `<div class="miss"><b>${esc(m.k)}</b><span>${esc(m.how)}</span></div>`).join("")
      || `<div class="note">Nothing missing that the model uses.</div>`;
    const dealBody = deal ? kv([
      { k: "Stage", v: esc(stageLabel(deal.stage)), sub: f.ago(deal.stage_entered) }, { k: "Ask", v: f.usd(deal.ask) }, { k: "Offer", v: f.usd(deal.offer) },
      { k: "Strategy", v: esc(deal.strategy || f.DASH) },
    ], { cls: "tight" }) : "";

    /* ---------- layout ---------- */
    const svPanel = hasLL && sv?.embed ? panel({ title: "Street view", sub: "Google Street View · live imagery", right: btn("sv2", "Street View ↗", { cls: "ghost" }) + btn("earth2", "Earth 3D ↗", { cls: "ghost" }),
      flush: true, body: `<iframe class="sv pp-sv" src="${esc(sv.embed)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>` }) : "";
    const zz = P.zip || {};
    const zipSub = (m, label) => (m ? `ZIP ${esc(p.zip)} · ${label} · 1y <span class="${f.cls(m.chg1y)}">${f.spct(m.chg1y)}</span> · 5y <span class="${f.cls(m.chg5y)}">${f.spct(m.chg5y)}</span> · ${esc(f.mo(m.as_of))}` : `ZIP ${esc(p.zip || f.DASH)} · ${label}`);
    const scen = P.scenarios || [];
    const taxUse = P.tax && P.tax.amount > 0;
    const missP = panel({ title: "What's missing", flush: true, body: miss });
    const docsP = panel({ title: "Documents", sub: `${(P.docs || []).length} linked`, right: `<a class="link" data-go="inbox">Inbox</a>`, flush: true, body: `<div id="pp-docs"></div>` })
      + (scen.length ? panel({ title: "Saved scenarios", right: `<a class="link" data-act="uw2">Underwrite</a>`, flush: true, body: `<div id="pp-scen"></div>` }) : "");
    const dealP = deal ? panel({ title: "Deal", right: `<a class="link" data-go="pipeline">Pipeline</a>`, flush: true, body: dealBody + (deal.notes ? `<div class="note">${esc(deal.notes)}</div>` : "") }) : "";
    root.innerHTML = hero + dataPanel(P) + svPanel + `
      ${panel({ title: "Value and rent estimates", right: btn("myfig", "My figures", { cls: "ghost", title: "Enter your own value or rent; it is shown as yours with today's date" }) + btn("est", "Refresh AVM", { cls: "ghost", title: "RentCast value + rent AVM with comparables (2 API calls)" }), flush: true, body: `<div id="pp-est"></div>${![P.value?.value, recS?.value, ask, P.owned?.purchase_price].some(f.ok) ? "" : `<div class="pp-ldr">${ladder({
        band: f.ok(P.value?.low) ? { lo: P.value.low, hi: P.value.high, label: "AVM range" } : recS ? { lo: recS.low, hi: recS.high, label: "comps range" } : null,
        pins: [{ v: P.value?.value, label: assessed ? "Assessed" : isMine(P.value) ? "Yours" : "AVM", cls: "mut" }, { v: recS?.value, label: "Comps", cls: "acc" }, { v: ask, label: "Asking", cls: "gold" }, ...(P.owned ? [{ v: P.owned.purchase_price, label: "Paid", cls: "mut" }] : [])],
        fmt: f.cusd })}</div>`}` })}
      <div class="cols2">
        ${panel({ title: q ? "Quick returns" : P.owned ? "Owned" : "Returns", sub: q ? "at the asking price · year 1" : P.owned ? "your figures" : "", flush: true, body: retBody })}
        ${q ? panel({ title: "Score", sub: "prospect score, 0–100", flush: true, body: scoreBody }) : `<div class="stack">${missP}${dealP}${docsP}</div>`}
      </div>
      ${q ? `<div class="cols2"><div class="stack">${missP}${dealP}</div><div class="stack">${docsP}</div></div>` : ""}
      <div class="cols2">
        ${panel({ title: "Tax and assessment", sub: taxUse ? `model uses ${f.usd(P.tax.amount)} · ${esc(P.tax.src || "")}` : "model assumes 1.2% of price", flush: true, body: `<div id="pp-taxc" class="pp-ch"></div><div id="pp-tax"></div>` })}
        ${panel({ title: "Sale and listing history", flush: true, body: `<div id="pp-sales"></div><div id="pp-lst"></div>` })}
      </div>
      <div class="cols2">
        ${panel({ title: "Home values", sub: zipSub(zz.zhvi, "ZHVI"), body: `<div id="pp-zhvi"></div>` })}
        ${panel({ title: "Rents", sub: zipSub(zz.zori, "ZORI"), body: `<div id="pp-zori"></div>` })}
      </div>
      <div class="note">Sources: ${demo ? "demo data generated for the sample market; " : ""}ZIP indexes are Zillow Research ZHVI (typical home value) and ZORI (typical rent), ZIP-level, not this property. Not an appraisal.</div>`;

    bind(root, {
      "act:sv2": () => openStreet(p.lat, p.lon), "act:earth2": () => openExternal(earth(p.lat, p.lon)),
      "act:myrent2": () => myFigure(pid, "rent", P), "act:uw2": () => go("underwrite", pid),
      "act:lurl": el => openExternal(el.dataset.u),
      "act:est": () => refresh(pid), "act:edit": () => editFacts(p), "act:myfig": () => myFigure(pid, "value", P),
      "act:bc-address": () => lookupBCAddress(p), "act:listing-data": () => importListingFacts(p),
      "act:municipal-data": () => pullMunicipalData(p),
      ...Object.fromEntries(Object.entries(propertySites).map(([id, url]) => [`act:${id}`, () => openExternal(url)])),
      "act:open-data-source": el => {
        const ref = P.sources?.find(s => s.id === +el.dataset.id);
        if (ref?.url?.startsWith("https://")) openExternal(ref.url);
      },
    });

    /* estimates table */
    const estimates = root.querySelector("#pp-est");
    const present = estRows.filter(r => f.ok(r.value));
    if (!present.length) {
      estimates.innerHTML = '<div class="note">Add your value or rent estimate, or <a class="link" data-go="comps">build one from comps</a>.</div>';
    } else table(estimates, {
      id: "pp-est", rows: present, key: r => r.key, nav: false,
      cols: [
        { k: "what", label: "Estimate", l: true, sort: false, fmt: (v, r) => `${v} <span class="mut">· ${r.basis}</span>` },
        { k: "value", label: "Figure", sort: false, fmt: v => `<b>${f.usd(v)}</b>` },
        { k: "low", label: "Low – high", sort: false, fmt: (v, r) => (f.ok(v) && f.ok(r.high) ? `${f.cusd(v)} – ${f.cusd(r.high)}` : f.DASH) },
        { k: "width", label: "Width", sort: false, title: "(high − low) ÷ figure", fmt: v => f.pct(v, 0) },
        { k: "n", label: "N", sort: false, title: "Comparables behind it", fmt: v => (v ? f.int(v) : f.DASH) },
        { k: "vsAsk", label: refL, title: `Value figure ÷ ${paidRef != null ? "purchase price" : "asking price"} − 1`, sort: false, fmt: v => f.spct(v), cls: v => f.cls(v) },
        { k: "source", label: "Source", l: true, sort: false, fmt: (v, r) => (v ? src(`${v}${r.as_of ? " " + r.as_of : ""}`, srcKind(v)) : `<span class="faint">none yet</span>`) },
      ],
    });

    /* docs and scenarios */
    if (!(P.docs || []).length) root.querySelector("#pp-docs").innerHTML = `<div class="empty"><span>No documents yet. Drop a lease, tax bill, rent roll or listing brochure on the window; it lands in the <a class="link" data-go="inbox">Inbox</a>.</span></div>`;
    else table(root.querySelector("#pp-docs"), {
      id: "pp-docs", rows: (P.docs || []).map(d => ({ ...d, key: d.id })), nav: false, maxH: 200,
      cols: [{ k: "name", label: "File", l: true, fmt: v => esc(v) }, { k: "kind", label: "Kind", l: true, fmt: v => esc(String(v || "").replace("_", " ")) },
        { k: "pages", label: "Pages", fmt: v => f.int(v) }, { k: "imported", label: "Added", fmt: v => f.dateY(v) }, { k: "status", label: "Status", l: true }],
      onRow: () => go("inbox"),
      empty: "No documents. Drop a lease, tax bill, rent roll or listing brochure on the window; it lands in the Inbox.",
    });
    if (scen.length) table(root.querySelector("#pp-scen"), {
      id: "pp-scen", rows: scen.map(s => { let o = {}; try { o = JSON.parse(s.outputs || "{}"); } catch (e) { o = {}; } return { key: s.id, name: s.name, strategy: s.strategy, updated: s.updated, coc: o.coc, cap: o.cap, cf: o.cash_flow_month, irr: o.irr }; }),
      nav: false, maxH: 180, onRow: () => go("underwrite", pid),
      cols: [{ k: "name", label: "Scenario", l: true, fmt: v => esc(v) }, { k: "strategy", label: "Type", l: true }, { k: "cap", label: "Cap", fmt: v => f.pct(v, 2) },
        { k: "coc", label: "CoC", fmt: v => f.pct(v), cls: v => f.cls(v) }, { k: "cf", label: "CF / mo", fmt: v => f.susd(v), cls: v => f.cls(v) }, { k: "irr", label: "IRR", fmt: v => f.pct(v) },
        { k: "updated", label: "Saved", fmt: v => f.dateY(v) }],
    });

    /* tax and assessment */
    const parc = (P.parcels || []).slice().sort((a, b) => a.year - b.year);
    const taxRows = parc.map((x, i) => ({ ...x, key: x.id ?? x.year, chg: i && parc[i - 1].tax_amount && x.tax_amount ? x.tax_amount / parc[i - 1].tax_amount - 1 : null,
      rate: x.tax_amount && x.assessed_total ? x.tax_amount / x.assessed_total : null }));
    if (parc.length > 0) C.bars(root.querySelector("#pp-taxc"), {
      h: 170, cats: parc.map(x => String(x.year)), stacked: true, legend: true,
      series: [{ name: "Land", vals: parc.map(x => x.assessed_land), color: "mut" }, { name: "Improvements", vals: parc.map(x => x.assessed_impr), color: "acc" }],
      y: { fmt: v => f.cusd(v) },
    });
    else root.querySelector("#pp-taxc").remove();
    table(root.querySelector("#pp-tax"), {
      id: "pp-tax", rows: taxRows, nav: false, sort: { k: "year", dir: -1 },
      cols: [{ k: "year", label: "Year", l: true },
        { k: "assessed_total", label: "Assessed", fmt: v => `<b>${f.usd(v)}</b>` }, { k: "tax_amount", label: "Tax", fmt: v => f.usd(v) },
        { k: "chg", label: "Tax y/y", fmt: v => f.spct(v), cls: v => f.cls(-v) }, { k: "rate", label: "Rate", title: "Tax ÷ assessed value", fmt: v => f.pct(v, 2) },
        { k: "source", label: "Source", l: true, fmt: v => (v ? src(v === "DEMO" ? "Demo data" : v, v === "DEMO" ? "e" : "v") : f.DASH) }],
      empty: `No assessor record. Look up the parcel on the ${p.county || "county"} assessor site; meanwhile the model uses ${taxUse ? f.usd(P.tax.amount) + ", " + P.tax.src : "1.2% of price"}.`,
    });

    /* sales and listings */
    const sales = (P.sales || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const vNow = P.value?.value;
    const saleRows = sales.map((s, i) => {
      const prev = i ? sales[i - 1] : null;
      const yrs = d => Math.max(0.01, (Date.parse(today()) - Date.parse(d)) / (365.25 * 864e5));
      return { ...s, key: s.id ?? s.date, ppsf: s.price && p.sqft ? s.price / p.sqft : null,
        chg: prev?.price && s.price ? s.price / prev.price - 1 : null,
        cagr: f.ok(vNow) && s.price && s.date ? (vNow / s.price) ** (1 / yrs(s.date)) - 1 : null };
    });
    table(root.querySelector("#pp-sales"), {
      id: "pp-sales", rows: saleRows, nav: false, sort: { k: "date", dir: -1 },
      cols: [{ k: "date", label: "Date", l: true, fmt: v => f.dateY(v) }, { k: "kind", label: "Event", l: true, fmt: (v, r) => `${esc(v || "Sale")}${r.source ? ` <span class="faint" title="Source: ${esc(r.source)}">· ${esc(r.source === "DEMO" ? "demo" : r.source)}</span>` : ""}` }, { k: "price", label: "Price", fmt: (v, r) => `<b title="${f.ok(r.ppsf) ? f.usd(r.ppsf) + " / sf" : ""}">${f.usd(v)}</b>` },
        { k: "ppsf", label: "$/sf", fmt: v => f.usd(v), hide: true }, { k: "chg", label: "vs prior", fmt: v => f.spct(v), cls: v => f.cls(v) },
        { k: "cagr", label: "CAGR", title: "Annualised change from this sale to today's value estimate", fmt: v => f.spct(v), cls: v => f.cls(v) },
      ],
      empty: "No recorded sales. Deed history comes from the county recorder, or from RentCast with a key.",
    });
    table(root.querySelector("#pp-lst"), {
      id: "pp-lst", rows: (P.listings || []).map(x => ({ ...x, key: x.id })), nav: false, sort: { k: "listed", dir: -1 },
      cols: [{ k: "listed", label: "Listed", l: true, fmt: v => f.dateY(v) }, { k: "kind", label: "Kind", l: true }, { k: "price", label: "Price", fmt: v => `<b>${f.usd(v)}</b>` },
        { k: "status", label: "Status", l: true }, { k: "dom", label: "DOM", fmt: v => f.days(v) }, { k: "removed", label: "Removed", fmt: v => f.dateY(v), hide: !(P.listings || []).some(x => x.removed) },
        { k: "source", label: "Source", l: true, fmt: (v, r) => (r.url ? `<a class="link" data-act="lurl" data-u="${esc(r.url)}">${esc(v || "link")}</a>` : v ? src(v === "DEMO" ? "Demo" : v, "e") : f.DASH) }],
      empty: "No listings on record.",
    });

    /* ZIP trends */
    const zline = (el, s, name, color, fmt) => {
      if (!(s || []).length) { el.innerHTML = `<div class="empty"><span>${S.state?.market?.zips ? `No Zillow series for ZIP ${esc(p.zip || f.DASH)}.` : `Market data is not downloaded. Get it on <a class="link" data-go="market">Market</a>.`}</span></div>`; return; }
      C.line(el, { h: 190, series: [{ name, pts: s.map(x => [x.date, x.value]), color, width: 1.6 }], x: { type: "date" }, y: { fmt } });
    };
    zline(root.querySelector("#pp-zhvi"), P.zhvi, "ZHVI", "acc", v => f.cusd(v));
    zline(root.querySelector("#pp-zori"), P.zori, "ZORI", "amber", v => f.usd(v));

    /* map: subject (gold) + comps */
    const pts = (hasLL ? [{ id: "s" + pid, lat: p.lat, lon: p.lon, kind: "subject", label: f.street(p.address), html: `<b>${esc(f.street(p.address))}</b><br>${f.usd(ask ?? P.value?.value)} · subject` }] : [])
      .concat(mappedComps.map(c => ({ id: c.id, lat: c.lat, lon: c.lon, v: c.included ? null : 0, label: f.cusd(c.price) + (c.kind === "rent" ? "/mo" : ""),
        html: `<b>${esc(f.street(c.address))}</b><br>${c.kind === "rent" ? "Rent comp" : "Sale comp"} · ${f.usd(c.price)}${c.kind === "rent" ? "/mo" : ""}<br>${f.bb(c)} · ${f.sqft(c.sqft)} · ${f.num(c.distance, 2)} mi · ${f.dateY(c.date)}` })));
    const slot = root.querySelector("#pp-map-slot");
    if (slot) {
      const fit = mapPid !== pid;
      mapPid = pid;
      ensureMap(slot, pts, fit).catch(e => console.error(e));
    } else {
      this.leave();
    }
  },
  leave() { map?.destroy(); map = null; mapEl = null; mapP = null; mapPid = null; },
};

/* ---------- actions ---------- */

async function pullMunicipalData(p) {
  const unit = p.address.match(/\bunit\s+([A-Z0-9-]+)/i)?.[1] || "";
  const addressLine = f.street(p.address).replace(/^unit\s+[A-Z0-9-]+\s*[–-]\s*/i, "");
  const house = addressLine.match(/^\d+[A-Z]?/i)?.[0] || "";
  const street = addressLine.slice(house.length).replace(/\bunit\s+[A-Z0-9-]+/i, "").trim();
  const city = (p.city || f.city(p.address)).toLowerCase();
  let municipality = city.includes("langley") ? "langley" : "surrey";
  if (!city.includes("langley") && !city.includes("surrey")) {
    const selected = await formModal("Choose municipal source", [{
      k: "municipality", label: "Municipality", type: "select",
      options: [{ v: "surrey", label: "City of Surrey" }, { v: "langley", label: "Township of Langley" }],
    }], { ok: "Continue" });
    if (!selected) return;
    municipality = selected.municipality;
  }
  const langley = municipality === "langley";
  const v = await formModal(langley ? "Pull Township of Langley data" : "Pull City of Surrey data", langley ? [
    { k: "house", label: "Civic number", value: house, req: true },
    { k: "unit", label: "Unit number", value: unit },
    { k: "street", label: "Street name (optional)", value: street, full: true },
  ] : [
    { k: "address", label: "Full Surrey street address", value: p.address, req: true, full: true },
  ], {
    ok: "Find property",
    note: langley ? "InvestStack sends the civic and unit numbers to the Township’s published assessment feed."
      : "InvestStack sends the address to the B.C. geocoder and uses the matched coordinates to query Surrey’s parcel and zoning layers.",
  });
  if (!v) return;
  const path = "/api/property/municipal-data";
  toast("Searching public records…");
  const found = await post(path, { ...v, id: p.id, municipality }, { quiet: true });
  if (found.error) return toast(found.error, "bad");
  if (!found.matches?.length) return toast("No municipal match. Check the civic number, unit, and street.", "bad");
  let row = found.matches[0];
  if (found.matches.length > 1) {
    const match = await formModal("Choose a property match", [{
      k: "token", label: "Matched property", type: "select", value: row.token, full: true,
      options: found.matches.map(r => ({ v: r.token, label: r.address })),
    }], { ok: "Review match", note: found.more ? "Showing the first 10 matches. Add the street name to narrow the search." : "" });
    if (!match) return;
    row = found.matches.find(r => r.token === match.token);
    if (!row) return;
  }
  const details = [
    row.pid && `PID ${esc(row.pid)}`,
    row.zoning && `Zoning ${esc(row.zoning)}`,
    f.ok(row.lot) && `Mapped lot ${f.int(row.lot)} sf`,
    f.ok(row.assessed_total) && `${row.assessment_year || ""} assessment · CAD ${f.int(row.assessed_total)}`.trim(),
  ].filter(Boolean).join(" · ");
  const confirmed = await confirmModal("Save municipal property data",
    `Current property · <b>${esc(p.address)}</b><br>Matched address · <b>${esc(row.address)}</b>${details ? "<br>" + details : ""}<br>Source · ${esc(row.source)}`, "Save match");
  if (!confirmed) return;
  const saved = await post(path, { id: p.id, token: row.token });
  toast(saved.error || "Municipal data and map pin saved", saved.error ? "bad" : "");
}

async function lookupBCAddress(p) {
  const query = await formModal("Look up B.C. address", [{
    k: "address", label: "Full street address, including unit and municipality", value: p.address, req: true, full: true,
  }], { ok: "Look up", note: "This sends the address you enter to the B.C. Address Geocoder. Review the match before saving it to this property." });
  if (!query) return;
  toast("Looking up the address…");
  const path = "/api/property/bc-location";
  const r = await post(path, { id: p.id, address: query.address }, { quiet: true });
  if (r.error) return toast(r.error, "bad");
  if (!r.matches?.length) return toast("No exact-level address match. Check the street name and unit, then try again.", "bad");
  const v = await formModal("Confirm the address match", [{
    k: "site", label: "Matching address", type: "select", value: r.matches[0].site, full: true,
    options: r.matches.map(m => ({ v: m.site, label: `${m.address}${f.ok(m.score) ? " · " + m.score + "% match" : ""}` })),
  }], { ok: "Save address and map pin", note: `Current property · <b>${esc(p.address)}</b>` });
  if (!v) return;
  const saved = await post(path, { id: p.id, address: query.address, site: v.site });
  toast(saved.error || "Address and map pin saved", saved.error ? "bad" : "");
}

async function importListingFacts(p) {
  const v = await formModal("Import listing facts", [
    { k: "source", label: "Source", type: "select", options: ["Zillow", "REALTOR.ca", "Other listing"],
      value: S.state?.config?.currency === "CAD" && !S.state?.demo ? "REALTOR.ca" : "Zillow" },
    { k: "url", label: "Listing link (optional)", full: true, ph: "https://…" },
    { k: "text", label: "Paste listing facts", type: "textarea", ph: "4 beds · 3 baths · 1,800 sqft\nYear built: 2005" },
  ], { ok: "Review facts", note: `Use listing facts for <b>${esc(p.address)}</b>. The app extracts recognizable figures from the text you paste.` });
  if (!v) return;
  const path = "/api/property/listing-data";
  const preview = await post(path, { id: p.id, preview: true, text: v.text }, { quiet: true });
  if (preview.error) return toast(preview.error, "bad");
  const fields = [
    ["beds", "Beds"], ["baths", "Baths"], ["sqft", "Living area (sq ft)"], ["lot", "Lot area (sq ft)"], ["year_built", "Year built"],
  ].map(([k, label]) => ({
    k, label: `${label}${f.ok(p[k]) ? " · current " + f.num(p[k], k === "beds" || k === "baths" ? 1 : 0) : ""}`, type: "number", value: preview.facts?.[k],
  }));
  const reviewed = await formModal("Review listing facts", [...fields,
    { k: "asking", label: "Asking price", type: "number", value: preview.facts?.asking },
    { k: "listing", label: "Save asking price as", type: "select", full: true, value: "facts",
      options: [{ v: "facts", label: "Property facts only" }, { v: "active", label: "Active sale listing" }] },
  ], { ok: "Save to property", note: "Check the figures against the listing. Blank facts leave the current property fields in place." });
  if (!reviewed) return;
  const { listing, ...facts } = reviewed;
  const saved = await post(path, { id: p.id, source: v.source, url: v.url, facts, active_sale: listing === "active" });
  toast(saved.error || "Listing facts saved", saved.error ? "bad" : "");
}

const STAGES = { discovered: "Discovered", researching: "Researching", underwriting: "Underwriting", diligence: "Due diligence", offer: "Offer", acquired: "Acquired", rejected: "Rejected" };
const stageLabel = s => STAGES[s] || s || f.DASH;

async function addPipeline(P, ask, q) {
  const r = await post("/api/pipeline", { act: "add", property_id: P.property.id, ask: ask ?? P.value?.value ?? null, strategy: "rental", score: q?.score ?? null });
  toast(r.error || `Added ${f.street(P.property.address)} to the pipeline as Discovered`, r.error ? "bad" : "");
}

async function markOwned(P, ask) {
  const o = P.owned || {}, edit = !!P.owned;
  if (!edit && !S.state?.demo) return addOwnedFromAddress(P.property);
  const v = await formModal(edit ? "Purchase details" : "Mark as owned", [
    { k: "purchase_price", label: "Purchase price", type: "number", value: o.purchase_price ?? ask ?? P.value?.value ?? "", req: true },
    { k: "purchase_date", label: "Closing date", type: "date", value: o.purchase_date || today(), req: true },
    { k: "closing_costs", label: "Closing costs", type: "number", value: o.closing_costs ?? "" },
    { k: "rehab", label: "Rehab spent", type: "number", value: o.rehab ?? "" },
  ], { ok: edit ? "Save" : "Mark as owned", note: edit ? "" : "Moves the property to Portfolio. Add units, leases and the loan there, or drop the lease and mortgage statement files on the window." });
  if (!v) return;
  const data = { property_id: P.property.id, purchase_price: v.purchase_price, purchase_date: v.purchase_date || null, closing_costs: v.closing_costs ?? 0, rehab: v.rehab ?? 0 };
  const r = await post("/api/portfolio", edit ? { act: "edit", table: "owned", id: P.property.id, data } : { act: "add", table: "owned", data });
  toast(r.error || (edit ? "Purchase details saved" : `${f.street(P.property.address)} is now in your portfolio`), r.error ? "bad" : "");
}

async function refresh(pid) {
  const rc = S.state?.rentcast || {};
  if (!rc.has_key && !S.state?.config?.has_rentcast_key) {
    toast("Refreshing estimates needs a RentCast key (Settings). Meanwhile use My figures, or add comps.", "bad");
    return;
  }
  const ok = await confirmModal("Refresh estimates", `Pulls the RentCast value and rent AVMs with their comparables: <b>2 API calls</b>. Used this month: ${f.int(rc.used)} of ${f.int(rc.allowance ?? rc.free)}${rc.billable ? ` · ${f.int(rc.billable)} billable so far (${f.usd(rc.est_cost, 2)})` : ""}.`, "Refresh");
  if (!ok) return;
  const r = await post("/api/estimate", { id: pid, refresh: true });
  toast(r.error || "Estimates refreshed", r.error ? "bad" : "");
}

async function editFacts(p) {
  const types = TYPES.includes(p.type) || !p.type ? TYPES : [p.type, ...TYPES];
  const v = await formModal("Edit facts", [
    { k: "type", label: "Type", type: "select", value: p.type || "Single Family", options: types },
    { k: "units", label: "Units", type: "number", value: p.units ?? "" },
    { k: "beds", label: "Beds (all units)", type: "number", value: p.beds ?? "" }, { k: "baths", label: "Baths (all units)", type: "number", value: p.baths ?? "" },
    { k: "sqft", label: "Living area (sf)", type: "number", value: p.sqft ?? "" }, { k: "lot", label: "Lot (sf)", type: "number", value: p.lot ?? "" },
    { k: "year_built", label: "Year built", type: "number", value: p.year_built ?? "" },
    { k: "tags", label: "Tags", value: p.tags || "", ph: "Neighbourhood, flags" },
    { k: "notes", label: "Notes", type: "textarea", value: p.notes || "" },
  ], { ok: "Save facts", note: "Your figures replace the record's. Estimates and comps adjust on the next read." });
  if (!v) return;
  const r = await post("/api/property/edit", { id: p.id, data: v });
  toast(r.error || "Facts saved", r.error ? "bad" : "");
}

async function myFigure(pid, kind, P) {
  const cur = { value: P.value, rent: P.rent };
  const v = await formModal("Set my value / rent", [
    { k: "kind", label: "Figure", type: "select", value: kind, options: [{ v: "value", label: "Value ($)" }, { v: "rent", label: "Rent, all units ($ / month)" }] },
    { k: "value", label: "Amount", type: "number", value: cur[kind]?.value != null ? Math.round(cur[kind].value) : "", req: true },
    { k: "source", label: "Source", value: "", ph: "Broker opinion, appraisal, current rent roll…", full: true },
  ], { ok: "Save", note: `Your figure becomes the estimate used everywhere, shown as yours with today's date. Now: value ${f.usd(cur.value?.value)}${cur.value ? ` (${esc(cur.value.source || "")})` : ""} · rent ${f.usd(cur.rent?.value)}${cur.rent ? ` (${esc(cur.rent.source || "")})` : ""}.` });
  if (!v) return;
  if (!f.ok(v.value) || v.value <= 0) { toast("Enter a positive number", "bad"); return; }
  const s = String(v.source || "").trim();
  const r = await post("/api/property/value", { id: pid, kind: v.kind, value: v.value, source: !s ? "your figure" : /your/i.test(s) ? s : `${s} (your figure)` });
  toast(r.error || `${v.kind === "value" ? "Value" : "Rent"} set to ${f.usd(v.value)}`, r.error ? "bad" : "");
}
