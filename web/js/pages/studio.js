// Development Studio — what could be built on the selected site.
// Centre: a 3D viewport (parcel, zoning envelope, proposed massing, existing buildings, ground shadow) with camera
// presets, north arrow, scale bar, layer toggles and click-to-inspect. Right: a resizable technical inspector
// with collapsible sections; editable parameters are input boxes, calculated outputs are plain figures, and every
// figure opens its source, unit, date, method and status. Undo/redo, keyboard shortcuts, save state.
// Geometry and zoning are illustrative (rectangular parcel from lot area + frontage; preset zoning values).
import { S, f, api, get, post, go, esc, isDark, on, pref } from "../core.js";
import { bind, btn, useCss, toast, formModal, debounce, parseNum } from "../ui.js";
import { loadLib, STYLE, concrete } from "../map.js";

useCss("studio");

const state = new Map();          // property id → { inputs, presets, uses, saved, prov, edited:Set, hist:[], fut:[], savedAs, dirty }
let map = null, mapPid = null, last = null, offTheme = null, keysWired = false, rootEl = null;
let layers = Object.assign({ parcel: true, envelope: true, proposed: true, existing: true, shadow: true, labels: true }, pref("st_layers") || {});
let open = Object.assign({ feas: true, zoning: true, params: true, cost: false, fin: false, scen: true }, pref("st_open") || {});
let picked = null;                // { kind, props }

const PCT = new Set(["max_coverage", "coverage", "eff", "soft", "contingency", "vacancy", "opex", "exit_cap", "ltc", "rate", "sell_cost"]);
// [key, label, unit, min, max, method/notes]
const P = {
  lot_sqft: ["Lot area", "sf", 500, 5e6], frontage: ["Frontage", "ft", 10, 5000],
  front: ["Front setback", "ft", 0, 200], rear: ["Rear setback", "ft", 0, 200], side: ["Side setbacks (each)", "ft", 0, 200],
  max_height: ["Height limit", "ft", 10, 1000], max_far: ["Max floor-area ratio", "×", 0.1, 30], max_coverage: ["Max lot coverage", "%", 5, 100],
  floors: ["Floors", "", 1, 80], coverage: ["Lot coverage", "%", 1, 100], floor_h: ["Floor-to-floor height", "ft", 8, 40],
  eff: ["Efficiency (net / gross)", "%", 30, 100], unit_sf: ["Average unit size", "sf", 0, 5000], rotation: ["Site rotation", "°", -90, 90],
  land: ["Land cost", "$", 0, 1e9], hard_sf: ["Hard cost", "$/gsf", 20, 2000], soft: ["Soft costs", "% of hard", 0, 80], contingency: ["Contingency", "% of hard+soft", 0, 50],
  months: ["Construction period", "months", 1, 120], ltc: ["Loan to cost", "%", 0, 90], rate: ["Construction loan rate", "%", 0, 30],
  rent_sf: ["Rent on net area", "$/nsf/yr", 1, 500], vacancy: ["Stabilised vacancy", "%", 0, 60], opex: ["Operating expenses", "% of EGI", 0, 90],
  exit_cap: ["Exit cap rate", "%", 2, 15], sell_cost: ["Selling costs", "% of value", 0, 15],
};
const SECTIONS = {
  zoning: ["front", "rear", "side", "max_height", "max_far", "max_coverage"],
  params: ["lot_sqft", "frontage", "floors", "coverage", "floor_h", "eff", "unit_sf", "rotation"],
  fin: ["land", "hard_sf", "soft", "contingency", "months", "ltc", "rate", "rent_sf", "vacancy", "opex", "exit_cap", "sell_cost"],
};
const STATUS = { verified: "Verified record", estimated: "Estimate", manual: "Entered by you", assumed: "Default assumption", illustrative: "Illustrative", preset: "Zoning preset (illustrative)", calc: "Calculated" };
const disp = (k, v) => (v == null || v === "" ? "" : PCT.has(k) ? +(v * 100).toFixed(2) : k === "land" ? Math.round(v) : +(+v).toFixed(2));
const COL = { proposed: "#CFCFC6", retail: "#B9A26E", industrial: "#98AAAC", office: "#A6A2B2", envelope: "#C2A462", over: "#C27A6C" };

/* ---------- provenance ---------- */

function provOf(st, k) {
  if (st.edited.has(k)) return { status: "manual", source: "Entered in the Studio", updated: "this session" };
  if (st.prov?.[k]) return st.prov[k];
  if (SECTIONS.zoning.includes(k)) return { status: "preset", source: `${st.inputs.zone} preset: typical values, not this site's code`, updated: null };
  if (["hard_sf", "rent_sf", "opex", "floor_h", "eff", "unit_sf"].includes(k)) return { status: "assumed", source: `Typical ${st.inputs.use} assumption`, updated: null };
  if (k === "frontage") return { status: "assumed", source: "Derived: about √(lot ÷ 2.2), a typical deep lot", updated: null };
  return { status: "assumed", source: "Default assumption", updated: null };
}
const METHOD = {
  gfa: ["Gross floor area", "sf", "Footprint × floors"], far: ["Floor-area ratio", "×", "Gross floor area ÷ lot area"],
  coverage: ["Lot coverage", "%", "Footprint ÷ lot area"], height: ["Building height", "ft", "Floors × floor-to-floor height"],
  units: ["Homes", "", "Residential net area ÷ average unit size (mixed use: upper floors only)"],
  used: ["Zoning capacity used", "%", "Gross floor area ÷ the lesser of FAR limit × lot and buildable area × floors allowed by height"],
  cost: ["Total development cost", "$", "Land + hard + soft + contingency + loan interest (about 55% average draw over the build)"],
  noi: ["Stabilised NOI", "$/yr", "Net area × rent × (1 − vacancy) × (1 − operating expenses)"],
  value: ["Value on completion", "$", "Stabilised NOI ÷ exit cap rate"], profit: ["Development profit", "$", "Value × (1 − selling costs) − total cost"],
  yoc: ["Yield on cost", "%", "Stabilised NOI ÷ total cost"], em: ["Equity multiple", "×", "(Equity + profit) ÷ equity; equity = cost − loan"],
  irr: ["Indicative IRR", "%/yr", "Equity multiple annualised over build time + 12 months lease-up (not a cash-flow IRR)"],
  residual: ["Residual land value", "$", "Net value ÷ 1.15 − costs other than land: what land could cost for a 15% margin on cost"],
};

function showInfo(html, anchor) {
  const tip = rootEl.querySelector("#st-tip");
  tip.innerHTML = html;
  tip.hidden = false;
  const r = anchor.getBoundingClientRect(), pr = rootEl.getBoundingClientRect();
  tip.style.top = Math.min(r.bottom - pr.top + 6, pr.height - tip.offsetHeight - 8) + "px";
  tip.style.left = Math.max(8, Math.min(r.left - pr.left - 40, pr.width - tip.offsetWidth - 8)) + "px";
}
const infoInput = (st, k) => { const p = provOf(st, k), d = P[k]; return `<b>${esc(d[0])}</b><dl><dt>Value</dt><dd>${esc(disp(k, st.inputs[k]))} ${esc(d[1])}</dd><dt>Status</dt><dd><i class="sx ${p.status}"></i>${STATUS[p.status]}</dd><dt>Source</dt><dd>${esc(p.source)}</dd><dt>Updated</dt><dd>${esc(p.updated || "—")}</dd><dt>Valid range</dt><dd>${disp(k, PCT.has(k) ? d[2] / 100 : d[2])}–${disp(k, PCT.has(k) ? d[3] / 100 : d[3])} ${esc(d[1])}</dd></dl>`; };
const infoCalc = (k, v) => { const m = METHOD[k]; return `<b>${esc(m[0])}</b><dl><dt>Value</dt><dd>${v}</dd><dt>Status</dt><dd><i class="sx calc"></i>Calculated</dd><dt>Method</dt><dd>${esc(m[2])}</dd><dt>Unit</dt><dd>${esc(m[1] || "count")}</dd></dl>`; };

/* ---------- 3D viewport ---------- */

const CAMS = {
  persp: { label: "Perspective", key: "P", pitch: 60, bearing: -32 },
  top: { label: "Plan", key: "L", pitch: 0, bearing: 0 },
  front: { label: "Front", key: "E", pitch: 78, bearing: 0 },
  iso: { label: "Isometric", key: "I", pitch: 50, bearing: 45 },
};
let cam = "persp";
function setCam(id, animate = true) {
  cam = id;
  if (!map || !last?.bounds) return;
  const c = CAMS[id], rot = +(state.get(S.pid)?.inputs.rotation || 0);
  const bearing = id === "front" ? rot : id === "top" ? 0 : c.bearing + rot;
  const lons = last.bounds.map(p => p[0]), lats = last.bounds.map(p => p[1]);
  const opt = map.cameraForBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: { top: 90, bottom: 110, left: 60, right: 60 }, bearing });
  const zoom = Math.min(19.6, (opt?.zoom || 18) - (id === "front" ? 0.5 : 0));
  map[animate ? "easeTo" : "jumpTo"]({ center: opt?.center, zoom, pitch: c.pitch, bearing, duration: animate ? 650 : 0 });
  rootEl?.querySelectorAll("[data-act=cam]").forEach(b => b.classList.toggle("on", b.dataset.cam === id));
}

function applyLayers() {
  if (!map?.isStyleLoaded()) return;
  const vis = (id, on_) => { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on_ ? "visible" : "none"); };
  vis("va-parcel-f", layers.parcel); vis("va-parcel", layers.parcel); vis("va-env", layers.envelope); vis("va-env-l", layers.envelope);
  vis("va-floors", layers.proposed); vis("va-shadow", layers.shadow && layers.proposed); vis("b3d", layers.existing);
  for (const l of map.getStyle().layers) if (l.type === "symbol") vis(l.id, layers.labels);
}

async function ensureMap(el, lat, lon) {
  if (map && mapPid === S.pid) return map;
  if (map) { map.remove(); map = null; }
  let gl;
  try { gl = await loadLib(); } catch (e) { el.innerHTML = `<div class="map-off">The 3D view could not load. The inspector still works.</div>`; return null; }
  el.innerHTML = "";
  try {
    map = new gl.Map({ container: el, style: STYLE(), center: [lon, lat], zoom: 18, pitch: 60, bearing: -32, attributionControl: { compact: true }, maxPitch: 82, antialias: true });
  } catch (e) { el.innerHTML = `<div class="map-off">The 3D view needs WebGL, which is not available here.</div>`; return null; }
  mapPid = S.pid;
  window.__vaStudioMap = map;   // for debugging in the console
  map.addControl(new gl.ScaleControl({ unit: "imperial", maxWidth: 120 }), "bottom-right");
  const add = () => {
    concrete(map);
    try { map.setLight({ anchor: "map", position: [1.4, 210, 38], color: "#ffffff", intensity: 0.42 }); } catch (e) { /* older style spec */ }
    for (const l of map.getStyle().layers) {   // roads read as streets: lighter casing, wider at high zoom
      if (l.type === "line" && /road|street|highway|transportation|path/.test(l.id) && !/label/.test(l.id)) {
        try { map.setPaintProperty(l.id, "line-color", isDark() ? "#4a4c47" : "#d3d3cc"); } catch (e) { /* skip */ }
      }
    }
    if (map.getSource("openmaptiles") && !map.getLayer("b3d")) {
      map.addLayer({ id: "b3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 14,
        paint: { "fill-extrusion-color": isDark() ? "#3c3e39" : "#cfcfc8", "fill-extrusion-opacity": 0.92, "fill-extrusion-vertical-gradient": true,
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 7], "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0] } });
    }
    if (!map.getSource("va-site")) {
      map.addSource("va-site", { type: "geojson", data: last?.geo || { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "va-shadow", type: "fill", source: "va-site", filter: ["==", ["get", "k"], "shadow"], paint: { "fill-color": "#000000", "fill-opacity": 0.32 } });
      map.addLayer({ id: "va-parcel-f", type: "fill", source: "va-site", filter: ["==", ["get", "k"], "parcel"], paint: { "fill-color": "#E6E5DF", "fill-opacity": 0.06 } });
      map.addLayer({ id: "va-parcel", type: "line", source: "va-site", filter: ["==", ["get", "k"], "parcel"], paint: { "line-color": "#E6E5DF", "line-width": 2 } });
      map.addLayer({ id: "va-env-l", type: "line", source: "va-site", filter: ["==", ["get", "k"], "envelope"], paint: { "line-color": COL.envelope, "line-width": 1.4, "line-dasharray": [3, 2] } });
      map.addLayer({ id: "va-floors", type: "fill-extrusion", source: "va-site", filter: ["==", ["get", "k"], "floor"],
        paint: { "fill-extrusion-color": floorColor(), "fill-extrusion-opacity": 1, "fill-extrusion-height": ["get", "height"], "fill-extrusion-base": ["get", "base"], "fill-extrusion-vertical-gradient": true } });
      map.addLayer({ id: "va-env", type: "fill-extrusion", source: "va-site", filter: ["==", ["get", "k"], "envelope"],
        paint: { "fill-extrusion-color": COL.envelope, "fill-extrusion-opacity": 0.1, "fill-extrusion-height": ["get", "height"], "fill-extrusion-base": 0 } });
    }
    applyLayers();
  };
  map.on("load", () => { add(); if (last) { paintMap(); setCam(cam, false); } });
  map.on("styledata", () => { if (map.isStyleLoaded() && !map.getSource("va-site")) { try { add(); paintMap(); } catch (e) { /* loading */ } } });
  map.on("rotate", () => { const n = rootEl?.querySelector("#st-north"); if (n) n.style.transform = `rotate(${-map.getBearing()}deg)`; });
  map.on("click", e => {
    const hit = map.queryRenderedFeatures(e.point, { layers: ["va-floors", "va-env", "va-parcel-f", "b3d"].filter(l => map.getLayer(l)) })[0];
    picked = hit ? { layer: hit.layer.id, props: hit.properties } : null;
    drawPick();
  });
  map.on("mousemove", e => { map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers: ["va-floors", "b3d"].filter(l => map.getLayer(l)) }).length ? "pointer" : ""; });
  map.on("error", () => { /* tiles offline: the massing still draws */ });
  offTheme?.();
  offTheme = on("theme", () => map?.setStyle(STYLE()));
  return map;
}
const floorColor = () => (last && !last.compliant ? COL.over : ["match", ["get", "use"], "retail", COL.retail, "industrial", COL.industrial, "office", COL.office, COL.proposed]);
function paintMap() {
  const src = map?.getSource("va-site");
  if (src && last?.geo) src.setData(last.geo);
  const parcel = last?.geo?.features.find(x => x.properties.k === "parcel");
  if (parcel && map?.getLayer("b3d")) {
    try { map.setFilter("b3d", ["!", ["within", { type: "Polygon", coordinates: parcel.geometry.coordinates }]]); } catch (e) { /* within unsupported: leave all */ }
  }
  if (map?.getLayer("va-floors")) map.setPaintProperty("va-floors", "fill-extrusion-color", floorColor());
}

function drawPick() {
  const el = rootEl?.querySelector("#st-pick");
  if (!el) return;
  if (!picked) { el.hidden = true; return; }
  const p = picked.props, m = last?.massing;
  let h = "";
  if (picked.layer === "va-floors") h = `<b>Proposed · floor ${+p.i + 1} of ${m?.floors}</b><dl><dt>Use</dt><dd>${esc(p.use || "")}</dd><dt>Floor plate</dt><dd>${f.int(p.area)} sf</dd><dt>Top of floor</dt><dd>${f.num(p.ft, 1)} ft</dd><dt>Building</dt><dd>${f.int(m?.gfa)} gsf · ${f.num(m?.height, 0)} ft</dd></dl>`;
  else if (picked.layer === "va-env") h = `<b>Zoning envelope</b><dl><dt>Buildable area</dt><dd>${f.int(p.area)} sf</dd><dt>Height limit</dt><dd>${f.num(p.ft, 0)} ft</dd><dt>Basis</dt><dd>Parcel less setbacks (preset values)</dd></dl>`;
  else if (picked.layer === "va-parcel-f") h = `<b>Parcel</b><dl><dt>Area</dt><dd>${f.int(p.area)} sf · ${f.num(p.area / 43560, 2)} ac</dd><dt>Frontage × depth</dt><dd>${f.num(last.site.width, 0)} × ${f.num(last.site.depth, 0)} ft</dd><dt>Geometry</dt><dd>Rectangle from lot area (illustrative)</dd></dl>`;
  else if (picked.layer === "b3d") { const ht = p.render_height; h = `<b>Existing building</b><dl><dt>Height</dt><dd>${ht != null ? f.num(ht * 3.2808, 0) + " ft" : "unknown (drawn at 23 ft)"}</dd><dt>Source</dt><dd>OpenStreetMap via OpenFreeMap</dd><dt>Status</dt><dd>Context only, not surveyed</dd></dl>`; }
  el.innerHTML = `<button class="st-x" data-act="unpick">✕</button>${h}`;
  el.hidden = false;
}

/* ---------- inspector ---------- */

function sec(id, title, body, right = "") {
  return `<section class="ins${open[id] ? " open" : ""}" data-sec="${id}"><header data-act="sec" data-id="${id}"><i></i><h4>${title}</h4>${right}</header><div class="ins-b">${body}</div></section>`;
}
function inputRow(st, k) {
  const d = P[k], p = provOf(st, k);
  return `<div class="ir" data-k="${k}"><label>${esc(d[0])}</label><span class="iv"><input data-input="p:${k}" value="${esc(disp(k, st.inputs[k]))}" inputmode="decimal" autocomplete="off" spellcheck="false"><em>${esc(d[1])}</em></span><button class="sx-b" data-act="info" data-k="${k}" title="${esc(STATUS[p.status])}: ${esc(p.source)}"><i class="sx ${p.status}"></i></button><small class="err" hidden></small></div>`;
}
const outRow = (k, label, v, sub = "", cls = "") => `<div class="or"><label>${esc(label)}</label><b class="${cls}">${v}</b><button class="sx-b" data-act="calc" data-k="${k}" data-v="${esc(v.replace(/<[^>]+>/g, ""))}" title="Calculated: ${esc(METHOD[k]?.[2] || "")}"><i class="sx calc"></i></button>${sub ? `<small>${sub}</small>` : ""}</div>`;

function drawInspector(st) {
  const r = last;
  if (!r) return;
  const m = r.massing, c = r.cost, inc = r.income, ret = r.returns, i = st.inputs;
  const verdict = !r.compliant ? ["bad", "Outside the zoning envelope", `Breaks ${r.checks.filter(x => !x.ok).map(x => x.k.toLowerCase()).join(", ")}. The massing is drawn in red.`]
    : ret.profit > 0 ? ["good", "Feasible on these assumptions", `${f.pct(ret.margin)} margin on cost; yield on cost ${f.pct(ret.yield_on_cost, 2)} vs ${f.pct(i.exit_cap, 2)} exit cap.`]
    : ["check", "Does not pencil", `Value on completion is ${f.cusd(-ret.profit)} below cost. Land at about ${f.cusd(Math.max(0, ret.residual_land))} would give a 15% margin.`];
  const fmtv = x => (x.fmt === "pct" ? f.pct(x.v) : x.fmt === "x" ? f.x(x.v) : x.fmt === "ft" ? f.num(x.v, 0) + " ft" : f.int(x.v) + " sf");
  const fmtl = x => (x.fmt === "pct" ? f.pct(x.limit, 0) : x.fmt === "x" ? f.x(x.limit, 1) : x.fmt === "ft" ? f.num(x.limit, 0) + " ft" : f.int(x.limit) + " sf");
  const zoneSel = `<select class="sel" data-input="zone" title="Zoning preset (illustrative values)">${Object.keys(st.presets).map(z => `<option${z === i.zone ? " selected" : ""}>${esc(z)}</option>`).join("")}</select>`;
  const useSel = `<select class="sel" data-input="use" title="Building use">${Object.keys(st.uses).map(u => `<option${u === i.use ? " selected" : ""}>${esc(u)}</option>`).join("")}</select>`;
  const saved = st.saved || [];
  const scenRows = [...r.scenarios.map((x, j) => ({ ...x, gen: j })), ...saved.map(x => { const o = JSON.parse(x.outputs || "{}"); return { name: x.name, saved: x, ...o, floors: JSON.parse(x.inputs || "{}").floors, compliant: true }; })];
  const body = el => rootEl.querySelector(`[data-sec="${el}"] .ins-b`);
  const html = sec("feas", "Feasibility", `<div class="vd ${verdict[0]}"><b>${verdict[1]}</b><span>${verdict[2]}</span></div>`
      + outRow("cost", "Total development cost", f.usd(c.total), `${f.usd(c.per_gsf)} / gsf${c.per_unit ? " · " + f.usd(c.per_unit) + " / home" : ""}`)
      + outRow("noi", "Stabilised NOI", f.usd(inc.noi), `${f.usd(inc.gross)} gross potential rent`)
      + outRow("value", "Value on completion", f.usd(inc.value), `at ${f.pct(i.exit_cap, 2)} exit cap`)
      + outRow("profit", "Development profit", f.susd(ret.profit), `${f.spct(ret.margin)} margin on cost`, f.cls(ret.profit))
      + outRow("yoc", "Yield on cost", f.pct(ret.yield_on_cost, 2), f.ok(ret.spread) ? `${f.spct(ret.spread, 2)} spread to exit cap` : "")
      + outRow("em", "Equity multiple", f.x(ret.equity_multiple), `equity ${f.usd(c.equity)} · loan ${f.usd(c.loan)}`)
      + outRow("irr", "Indicative IRR", f.pct(ret.irr), "simplified, see method")
      + outRow("residual", "Residual land value", f.usd(ret.residual_land), "for a 15% margin on cost"),
      `<span class="hs ${verdict[0]}">${verdict[0] === "good" ? "Feasible" : verdict[0] === "bad" ? "Non-compliant" : "Marginal"}</span>`)
    + sec("zoning", "Zoning", `<div class="ins-row">${zoneSel}<span class="mut">Preset values: replace with the site's code</span></div>`
      + r.checks.map(x => `<div class="zc ${x.ok ? "ok" : "no"}"><i></i><label>${esc(x.k)}</label><b>${fmtv(x)}</b><em>≤ ${fmtl(x)}</em></div>`).join("")
      + SECTIONS.zoning.map(k => inputRow(st, k)).join(""), `<span class="hs ${r.compliant ? "good" : "bad"}">${r.checks.filter(x => x.ok).length}/${r.checks.length} pass</span>`)
    + sec("params", "Development parameters", `<div class="ins-row">${useSel}<span class="mut">use sets typical costs and rents</span></div>`
      + SECTIONS.params.map(k => inputRow(st, k)).join("")
      + outRow("gfa", "Gross floor area", f.int(m.gfa) + " sf", `${f.int(m.net_sf)} sf net`) + outRow("far", "Floor-area ratio", f.x(m.far))
      + outRow("height", "Building height", f.num(m.height, 1) + " ft") + outRow("units", "Homes", m.units ? f.int(m.units) : f.DASH)
      + outRow("used", "Zoning capacity used", f.pct(m.used, 0), `${f.int(m.allowed_gfa)} sf allowed`, m.used > 1 ? "down" : ""))
    + sec("cost", "Cost breakdown", [["Land", c.land], ["Hard costs", c.hard], ["Soft costs", c.soft], ["Contingency", c.contingency], ["Construction interest", c.interest]]
      .map(([k, v]) => `<div class="cb"><label>${k}</label><div><i style="width:${c.total ? Math.max(0, v / c.total * 100) : 0}%"></i></div><b>${f.usd(v)}</b><em>${f.pct(c.total ? v / c.total : null, 0)}</em></div>`).join("")
      + `<div class="cb tot"><label>Total</label><div></div><b>${f.usd(c.total)}</b><em></em></div>`, `<span class="hs">${f.cusd(c.total)}</span>`)
    + sec("fin", "Financial assumptions", SECTIONS.fin.map(k => inputRow(st, k)).join(""))
    + sec("scen", "Scenarios", `<table class="sc-t"><thead><tr><th>Scenario</th><th>Fl</th><th>GFA</th><th>FAR</th><th>Profit</th><th>YoC</th><th></th></tr></thead><tbody>`
      + scenRows.map(x => `<tr><td>${esc(x.name)}${x.saved ? ` <span class="tag">saved</span>` : ""}${x.compliant ? "" : ` <span class="tag down">over</span>`}</td><td>${x.floors ?? f.DASH}</td><td>${f.compact(x.gfa)}</td><td>${f.ok(x.far) ? (+x.far).toFixed(2) : f.DASH}</td><td class="${f.cls(x.profit)}">${f.cusd(x.profit)}</td><td>${f.pct(x.yield_on_cost, 1)}</td><td>${x.gen === 0 ? `<span class="mut">current</span>` : `<button class="btn" data-act="load" data-gen="${x.gen ?? ""}" data-sid="${x.saved?.id ?? ""}">Load</button>`}</td></tr>`).join("")
      + `</tbody></table><div class="ins-row"><button class="btn" data-act="save">Save current as scenario</button></div>`);
  const ins = rootEl.querySelector("#st-ins-body"), top = ins.scrollTop;
  const focus = document.activeElement?.dataset?.input;
  if (focus && focus.startsWith("p:") && ins.contains(document.activeElement)) {   // typing: update outputs only, keep the input
    for (const id of ["feas", "cost", "scen"]) body(id).innerHTML = new DOMParser().parseFromString(html, "text/html").querySelector(`[data-sec="${id}"] .ins-b`).innerHTML;
    for (const id of ["zoning", "params"]) {
      const fresh = new DOMParser().parseFromString(html, "text/html").querySelector(`[data-sec="${id}"] .ins-b`);
      body(id).querySelectorAll(".or, .zc").forEach((el, j) => { const n = fresh.querySelectorAll(".or, .zc")[j]; if (n) el.outerHTML = n.outerHTML; });
    }
  } else { ins.innerHTML = html; ins.scrollTop = top; }
}

function drawHud(st) {
  const r = last, m = r.massing, hud = rootEl.querySelector("#st-hud");
  if (!hud) return;
  hud.innerHTML = [["GFA", f.int(m.gfa) + " sf", "gfa"], ["FAR", f.x(m.far), "far"], ["Height", f.num(m.height, 0) + " ft", "height"],
    ["Coverage", f.pct(m.coverage, 0), "coverage"], ["Homes", m.units ? f.int(m.units) : f.DASH, "units"], ["Capacity used", f.pct(m.used, 0), "used"]]
    .map(([k, v, id]) => `<div title="${esc(METHOD[id]?.[2] || "")}" class="${id === "used" && m.used > 1 ? "over" : ""}"><span>${k}</span><b>${v}</b></div>`).join("");
  const s = document.getElementById("st-state");
  if (!s) return;
  s.className = "st-state " + (st.dirty ? "dirty" : "clean");
  s.textContent = st.dirty ? "Unsaved changes" : st.savedAs ? `Saved · ${st.savedAs}` : "No changes";
  const bar = document.getElementById("bar-r");
  bar.querySelector("[data-act=undo]") && (bar.querySelector("[data-act=undo]").disabled = !st.hist.length);
  bar.querySelector("[data-act=redo]") && (bar.querySelector("[data-act=redo]").disabled = !st.fut.length);
}

/* ---------- page ---------- */

export default {
  id: "studio",
  async render(root, ctx) {
    rootEl = root;
    const p = S.prop.property, pid = p.id;
    if (!state.has(pid)) {
      const d = await get(`/api/develop/${pid}`);
      state.set(pid, { inputs: { ...d.defaults }, presets: d.presets, uses: d.uses, saved: d.saved, prov: d.prov, edited: new Set(), hist: [], fut: [], dirty: false, savedAs: null });
    }
    const st = state.get(pid), inp = st.inputs;
    const lat = f.ok(p.lat) ? +p.lat : 39.9612, lon = f.ok(p.lon) ? +p.lon : -82.9988;

    const calc = async (fit = false) => {
      try { last = await api("/api/develop", { inputs: inp, lat, lon }); } catch (e) { toast(String(e.message || e), "bad"); return; }
      paintMap(); drawHud(st); drawInspector(st); drawPick();
      if (fit) setCam(cam);
    };
    const soon = debounce(() => calc(false), 80);
    const snapshot = () => { st.hist.push(JSON.stringify({ inputs: inp, edited: [...st.edited] })); if (st.hist.length > 100) st.hist.shift(); st.fut = []; st.dirty = true; };
    const restore = (json) => { const o = JSON.parse(json); Object.keys(inp).forEach(k => delete inp[k]); Object.assign(inp, o.inputs); st.edited = new Set(o.edited); syncInputs(); calc(true); };
    const undo = () => { if (!st.hist.length) return; st.fut.push(JSON.stringify({ inputs: inp, edited: [...st.edited] })); restore(st.hist.pop()); st.dirty = true; toast("Undone"); };
    const redo = () => { if (!st.fut.length) return; st.hist.push(JSON.stringify({ inputs: inp, edited: [...st.edited] })); restore(st.fut.pop()); st.dirty = true; };
    const syncInputs = () => {
      root.querySelectorAll("[data-input^='p:']").forEach(el => { const k = el.dataset.input.slice(2); if (document.activeElement !== el) el.value = disp(k, inp[k]); });
      for (const [k, mul] of [["floors", 1], ["coverage", 100], ["rotation", 1]]) {
        const sl = root.querySelector(`.st-dials [data-input="d:${k}"]`), v = Math.round((inp[k] || 0) * mul);
        if (sl) sl.value = v;
        const lab = root.querySelector(`#d-${k}`); if (lab) lab.textContent = v + (k === "coverage" ? "%" : k === "rotation" ? "°" : "");
      }
    };
    st.api = { undo, redo, calc, setCam };

    ctx.sub.innerHTML = `<span class="st-addr">${esc(p.address)}</span><span class="tag amb" title="The parcel is a rectangle from lot area and frontage, and zoning values are typical presets. Replace them with the site's actual code before relying on any result.">Illustrative geometry and zoning</span>`;
    ctx.bar.innerHTML = `<span class="st-state" id="st-state"></span>` + btn("undo", "Undo", { title: "Undo (⌘Z)" }) + btn("redo", "Redo", { title: "Redo (⇧⌘Z)" }) + btn("save", "Save scenario", { title: "Save (⌘S)" }) + btn("uw", "Underwriting") + btn("reset", "Reset", { title: "Back to the defaults for this property" });

    if (root.dataset.pid !== String(pid) || !root.querySelector(".st-wrap")) {
      root.dataset.pid = String(pid);
      root.classList.add("fill", "st");
      const w = pref("st_ins_w") || 392;
      root.innerHTML = `<div class="st-wrap" style="--ins-w:${w}px">
        <div class="st-view">
          <div class="st-tools">
            <div class="grp">${Object.entries(CAMS).map(([id, c]) => `<button data-act="cam" data-cam="${id}" class="${id === cam ? "on" : ""}" title="${c.label} view (${c.key})">${c.label}</button>`).join("")}</div>
            <div class="grp" id="st-layers">${[["parcel", "Parcel"], ["envelope", "Envelope"], ["proposed", "Proposed"], ["existing", "Existing"], ["shadow", "Shadow"], ["labels", "Labels"]]
              .map(([k, l]) => `<button data-act="layer" data-k="${k}" class="${layers[k] ? "on" : ""}" title="Show or hide: ${l}"><i class="lk ${k}"></i>${l}</button>`).join("")}</div>
          </div>
          <div id="st-map" class="no-swipe"></div>
          <div class="st-hud" id="st-hud"></div>
          <button class="st-north" title="North (click to reset the bearing)" data-act="north"><svg id="st-north" viewBox="0 0 32 32"><path d="M16 4l5 12h-10z" fill="#E6E5DF"/><path d="M16 28l-5-12h10z" fill="#5E6059"/><text x="16" y="31.5" text-anchor="middle" font-size="0">N</text></svg><span>N</span></button>
          <div class="st-pick" id="st-pick" hidden></div>
          <div class="st-dials">
            <label title="Floors (− / + keys)"><span>Floors</span><input type="range" min="1" max="30" step="1" data-input="d:floors"><b id="d-floors"></b></label>
            <label title="Footprint as a share of the lot"><span>Coverage</span><input type="range" min="5" max="100" step="1" data-input="d:coverage"><b id="d-coverage"></b></label>
            <label title="Rotate the site to match the street"><span>Rotation</span><input type="range" min="-90" max="90" step="1" data-input="d:rotation"><b id="d-rotation"></b></label>
          </div>
        </div>
        <div class="st-split" title="Drag to resize the inspector"></div>
        <aside class="st-ins"><div class="st-ins-h"><b>Inspector</b><span class="leg"><i class="sx manual"></i>editable<i class="sx calc"></i>calculated</span></div><div id="st-ins-body"></div></aside>
        <div class="st-tip" id="st-tip" hidden></div>
      </div>`;
      // resizable inspector
      const wrap = root.querySelector(".st-wrap");
      root.querySelector(".st-split").addEventListener("pointerdown", e => {
        e.preventDefault();
        const x0 = e.clientX, w0 = parseFloat(getComputedStyle(wrap).getPropertyValue("--ins-w"));
        const mv = ev => { const nw = Math.max(320, Math.min(640, w0 - (ev.clientX - x0))); wrap.style.setProperty("--ins-w", nw + "px"); map?.resize(); };
        const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); pref("st_ins_w", parseFloat(wrap.style.getPropertyValue("--ins-w"))); };
        window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
      });
      root.addEventListener("click", e => { if (!e.target.closest("#st-tip, [data-act=info], [data-act=calc]")) root.querySelector("#st-tip").hidden = true; });
      await ensureMap(root.querySelector("#st-map"), lat, lon);
    }
    if (!keysWired) {
      keysWired = true;
      window.addEventListener("keydown", e => {
        if (S.page !== "studio" || !(e.metaKey || e.ctrlKey)) return;
        const k = e.key.toLowerCase(), s2 = state.get(S.pid);
        if (!s2?.api) return;
        if (k === "z") { e.preventDefault(); e.shiftKey ? s2.api.redo() : s2.api.undo(); }
        else if (k === "y") { e.preventDefault(); s2.api.redo(); }
        else if (k === "s") { e.preventDefault(); document.querySelector("#bar-r [data-act=save]")?.click(); }
      }, true);
    }

    const setInput = (k, raw, fromSlider = false) => {
      const d = P[k], n = typeof raw === "number" ? raw : parseNum(raw);
      const row = root.querySelector(`.ir[data-k="${k}"]`), err = row?.querySelector(".err");
      const lo = d[2], hi = d[3], shown = n;
      if (n == null || shown < lo || shown > hi) {
        if (row) { row.classList.add("bad"); err.hidden = false; err.textContent = n == null ? "Enter a number" : `Must be between ${lo} and ${hi} ${d[1]}`; }
        return;
      }
      if (row) { row.classList.remove("bad"); err.hidden = true; }
      const v = PCT.has(k) && !fromSlider ? n / 100 : n;
      if (inp[k] === v) return;
      snapshot();
      inp[k] = v;
      st.edited.add(k);
      if (fromSlider) syncInputs();
      soon();
      const b = root.querySelector(`.ir[data-k="${k}"] .sx`); if (b) b.className = "sx manual";
    };
    const handlers = {
      "act:cam": el => setCam(el.dataset.cam),
      "act:layer": el => { layers[el.dataset.k] = !layers[el.dataset.k]; pref("st_layers", layers); el.classList.toggle("on", layers[el.dataset.k]); applyLayers(); },
      "act:north": () => map?.easeTo({ bearing: 0, duration: 400 }),
      "act:unpick": () => { picked = null; drawPick(); },
      "act:sec": el => { open[el.dataset.id] = !open[el.dataset.id]; pref("st_open", open); el.parentElement.classList.toggle("open", open[el.dataset.id]); },
      "act:info": el => showInfo(infoInput(st, el.dataset.k), el),
      "act:calc": el => showInfo(infoCalc(el.dataset.k, esc(el.dataset.v)), el),
      "act:load": el => {
        snapshot();
        const src = el.dataset.sid ? JSON.parse(st.saved.find(x => String(x.id) === el.dataset.sid).inputs) : last.scenarios[+el.dataset.gen].inputs;
        Object.assign(inp, src); syncInputs(); calc(true);
      },
      "act:save": () => save(),
      "change:zone": v => { snapshot(); Object.assign(inp, st.presets[v], { zone: v }); SECTIONS.zoning.forEach(k => st.edited.delete(k)); syncInputs(); calc(true); },
      "change:use": v => { snapshot(); const u = st.uses[v]; Object.assign(inp, { use: v, floor_h: u.floor_h, eff: u.eff, hard_sf: u.hard, rent_sf: u.rent, opex: u.opex, unit_sf: u.unit }); syncInputs(); calc(); },
      "input:d:floors": v => setInput("floors", +v, true),
      "input:d:coverage": v => setInput("coverage", +v / 100, true),
      "input:d:rotation": v => { setInput("rotation", +v, true); },
    };
    for (const k of Object.keys(P)) handlers[`input:p:${k}`] = v => setInput(k, v);
    const save = async () => {
      const v = await formModal("Save development scenario", [{ k: "name", label: "Name", value: `${inp.floors}-storey ${inp.use}, ${f.int(last?.massing.gfa)} sf`, full: true, req: true }]);
      if (!v?.name || !last) return;
      const outputs = { gfa: last.massing.gfa, far: last.massing.far, units: last.massing.units, cost: last.cost.total, noi: last.income.noi, value: last.income.value, profit: last.returns.profit, yield_on_cost: last.returns.yield_on_cost };
      const r = await post("/api/scenario", { property_id: pid, name: v.name, strategy: "develop", inputs: inp, outputs }, { quiet: true });
      if (r.error) return toast(r.error, "bad");
      const d = await api(`/api/develop/${pid}`);
      st.saved = d.saved; st.dirty = false; st.savedAs = `${v.name}, ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      drawHud(st); drawInspector(st);
      toast("Scenario saved to the property");
    };
    bind(root, handlers);
    bind(ctx.bar, { "act:undo": undo, "act:redo": redo, "act:save": save, "act:uw": () => go("underwrite", pid),
      "act:reset": () => { state.delete(pid); root.dataset.pid = ""; picked = null; this.render(root, ctx); } });
    syncInputs();
    await calc(ctx.reason === "show" || ctx.reason === "prop");
  },
  key(e) {
    const s2 = state.get(S.pid);
    if (!s2?.api) return false;
    const k = e.key.toLowerCase();
    const id = Object.keys(CAMS).find(c => CAMS[c].key.toLowerCase() === k);
    if (id) { s2.api.setCam(id); return true; }
    if (k === "=" || k === "+") { rootEl.querySelector('[data-input="d:floors"]').value = s2.inputs.floors + 1; rootEl.querySelector('[data-input="d:floors"]').dispatchEvent(new Event("input", { bubbles: true })); return true; }
    if (k === "-") { rootEl.querySelector('[data-input="d:floors"]').value = Math.max(1, s2.inputs.floors - 1); rootEl.querySelector('[data-input="d:floors"]').dispatchEvent(new Event("input", { bubbles: true })); return true; }
    return false;
  },
};
