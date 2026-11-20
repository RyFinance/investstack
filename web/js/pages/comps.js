// Comps — sale and rent comparables for the selected property: the adjustment grid with include toggles,
// the reconciled figure against the AVM and the asking price, a map of subject + comps, add a comp by hand, $/sf.
import { S, f, get, post, select, esc, streetView, openExternal } from "../core.js";
import { table, panel, kv, chips, btn, sep, bind, toast, formModal, csv, useCss } from "../ui.js";
import { mapView } from "../map.js";
import * as C from "../charts.js";

useCss("property");

/* ---------- shared helpers (property.js imports these) ---------- */

/** A horizontal value ladder: a band (range), small ticks (individual comps) and labelled pins.
 *  ladder({ band:{lo,hi,label}, ticks:[{v,title,dim}], pins:[{v,label,cls:"acc|gold|mut"}], fmt }) → html */
export function ladder(o) {
  const fmt = o.fmt || f.cusd;
  const vals = [o.band?.lo, o.band?.hi, ...(o.ticks || []).map(t => t.v), ...(o.pins || []).map(p => p.v)].filter(f.ok).map(Number);
  if (!vals.length) return `<div class="note">No figures to place.</div>`;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) { lo *= 0.95; hi *= 1.05; }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const x = v => ((v - lo) / (hi - lo) * 100).toFixed(2);
  let h = `<div class="ldr"><div class="ldr-track">`;
  if (o.band && f.ok(o.band.lo) && f.ok(o.band.hi)) h += `<i class="ldr-band" style="left:${x(o.band.lo)}%;width:${(x(o.band.hi) - x(o.band.lo)).toFixed(2)}%" title="${esc(o.band.label || "")} ${esc(fmt(o.band.lo))} – ${esc(fmt(o.band.hi))}"></i>`;
  for (const t of o.ticks || []) if (f.ok(t.v)) h += `<i class="ldr-tick${t.dim ? " dim" : ""}" style="left:${x(t.v)}%" title="${esc(t.title || fmt(t.v))}"></i>`;
  const pins = (o.pins || []).filter(p => f.ok(p.v)).sort((a, b) => a.v - b.v);
  pins.forEach((p, i) => {
    const pos = +x(p.v), side = pos > 78 ? " r" : pos < 22 ? " l" : "";
    h += `<b class="ldr-pin ${p.cls || "acc"} ${i % 2 ? "dn" : "up"}${side}" style="left:${pos}%"><span>${esc(p.label)} <em>${esc(fmt(p.v))}</em></span></b>`;
  });
  h += `</div><div class="ldr-ax"><span>${esc(fmt(lo + pad))}</span>${o.band?.label ? `<span class="faint">${esc(o.band.label)}</span>` : ""}<span>${esc(fmt(hi - pad))}</span></div></div>`;
  return h;
}

/** Comps merged with their profile rows (address, size, date, coordinates). kind: "sale" | "rent" */
export function mergedComps(prop, cmp, kind) {
  const info = new Map((prop?.comps || []).map(c => [c.id, c]));
  const s = prop?.property || {};
  return (cmp?.[kind] || []).map(a => {
    const c = info.get(a.id) || {};
    const net = (a.lines || []).reduce((t, l) => t + (+l.v || 0), 0);
    const w = 1 / (0.05 + Math.abs(a.gross_adj || 0) + 0.1 * Math.max(0, a.dist_mi || 0));   // same as valora/uw.py reconcile()
    const row = { ...c, ...a, key: a.id, net, w, ppsf: f.ok(a.price) && c.sqft ? a.price / c.sqft : null,
      appsf: f.ok(a.adjusted) && s.sqft ? a.adjusted / s.sqft : null };
    for (const l of a.lines || []) row["adj_" + l.k] = l.v;
    return row;
  });
}

/** Street View for a point (opens the browser). */
export async function openStreet(lat, lon) {
  if (!f.ok(lat) || !f.ok(lon)) { toast("No coordinates for this address, so Street View cannot be placed", "bad"); return; }
  try { const sv = await get(streetView(lat, lon)); openExternal(sv.link); } catch (e) { toast(String(e.message || e), "bad"); }
}

const median = a => { const s = a.filter(f.ok).slice().sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = a => { const s = a.filter(f.ok); return s.length ? s.reduce((t, v) => t + v, 0) / s.length : null; };
const sdev = a => { const s = a.filter(f.ok), m = mean(s); return s.length > 1 ? Math.sqrt(s.reduce((t, v) => t + (v - m) ** 2, 0) / (s.length - 1)) : null; };

/* ---------- page ---------- */

let tab = "sale", gv = "facts", selId = null, map = null, mapEl = null, mapPid = null, mapP = null, lastKind = null;
const LINES = ["Size", "Beds", "Baths", "Age", "Lot"];

async function ensureMap(slot, pts, fit) {
  if (!mapEl) {
    mapEl = document.createElement("div");
    mapEl.className = "cp-map";
    slot.replaceWith(mapEl);
    const mine = mapP = mapView(mapEl, { points: pts, labels: true, selected: selId, onClick: id => pickRow(+id) });
    const m = await mine;
    if (mapP !== mine) { m.destroy(); return; }   // page left while the map was loading
    map = m;
    map.setPoints(pts, { fit: true });
    return;
  }
  slot.replaceWith(mapEl);
  if (!map) { const mine = mapP, m = await mine; if (mapP !== mine) return; map = m; }
  map.setPoints(pts, { fit });
  map.select(selId);
}

let rowsNow = [], tblH = null;
function pickRow(id) {
  const r = rowsNow.find(x => x.id === id);
  if (!r) return;
  selId = id;
  tblH?.setSel(id);
  map?.select(id);
  select({ kind: "comp", id, row: r });
}

export default {
  id: "comps",
  async render(root, ctx) {
    const P = S.prop, p = P.property, pid = p.id;
    let cmp = null, err = "";
    try { cmp = await get(`/api/comps/${pid}`); } catch (e) { err = String(e.message || e); }
    if (S.prop !== P) return;
    const sale = mergedComps(P, cmp, "sale"), rent = mergedComps(P, cmp, "rent");
    const isSale = tab === "sale", rows = isSale ? sale : rent;
    rowsNow = rows;
    const inc = rows.filter(r => r.included && r.adjusted);
    const wsum = inc.reduce((t, r) => t + r.w, 0);
    for (const r of rows) r.wt = r.included && wsum ? r.w / wsum : null;
    const rec = isSale ? cmp?.value : cmp?.rent_value;
    const avm = isSale ? P.value : P.rent;
    const mine = /your|manual/i.test(avm?.source || "");
    const fr = isSale ? f.cusd : (v => f.usd(v));
    const avmSub = avm ? (f.ok(avm.low) ? `${fr(avm.low)}–${fr(avm.high)}` : mine ? "your figure" : "no range") + ` · ${esc(String(avm.source || "").replace(/ \(your figure\)$/, ""))}${avm.as_of ? " " + esc(avm.as_of) : ""}` : "none yet";
    const ask0 = P.listing?.price ?? p.price ?? null;
    const paid = !f.ok(ask0) && f.ok(P.owned?.purchase_price) ? P.owned.purchase_price : null;
    const ask = ask0 ?? paid, bl = paid != null ? "paid" : "asking", BL = paid != null ? "Paid" : "Asking";   // owned and unlisted: compare with the purchase price
    const units = p.units || 1;
    const money = v => f.usd(v);

    /* command bar */
    ctx.sub.innerHTML = chips("tab", [{ v: "sale", label: "Sale comps", sub: String(sale.length) }, { v: "rent", label: "Rent comps", sub: String(rent.length) }], tab)
      + sep() + btn("add", "+ Add comp", { title: "Enter a comparable sale or rental by hand" })
      + btn("sv", "Street View", { title: "Open Google Street View at the subject" });
    ctx.bar.innerHTML = btn("csv", "CSV", { title: "Export the adjustment grid" });
    bind(ctx.sub, {
      "chip:tab": v => { tab = v; selId = null; this.render(root, ctx); },
      "act:add": () => addComp(pid, tab),
      "act:sv": () => openStreet(p.lat, p.lon),
    });
    bind(ctx.bar, { "act:csv": () => csv(`valora-${tab}-comps-${pid}.csv`, csvCols(rows), rows) });

    /* figures */
    const cut = v => (f.ok(v) && f.ok(ask) && ask ? v / ask - 1 : null);
    const ppsfs = inc.map(r => r.ppsf);
    const head = isSale ? kv([
      { k: "Comps value", v: money(rec?.value), sub: rec ? `${fr(rec.low)}–${fr(rec.high)} · ${rec.n} comp${rec.n === 1 ? "" : "s"}` : "include a comp", title: "Weighted reconciliation of the included adjusted comps" },
      { k: mine ? "Your value" : "AVM", v: money(avm?.value), sub: avmSub, title: avm ? `${avm.source} ${avm.as_of || ""}` : "" },
      { k: BL, v: money(ask), sub: paid != null ? f.dateY(P.owned.purchase_date) : P.listing ? `${esc(P.listing.status || "")} · ${f.days(P.listing.dom)}` : "not listed" },
      { k: `Comps vs ${bl}`, v: f.spct(cut(rec?.value)), cls: f.cls(cut(rec?.value)), title: `Reconciled comps value ÷ ${bl} − 1 (positive: ${bl} is below the comps)` },
      { k: `${mine ? "Yours" : "AVM"} vs ${bl}`, v: f.spct(cut(avm?.value)), cls: f.cls(cut(avm?.value)) },
      { k: "Median $/sf", v: f.usd(median(ppsfs)), sub: "included, as sold" },
      { k: "Subject $/sf", v: f.usd(f.ok(ask) && p.sqft ? ask / p.sqft : null), sub: `at ${bl}` },
      { k: "Included", v: `${inc.length} / ${rows.length}`, sub: inc.length ? `avg gross adj ${f.pct(mean(inc.map(r => r.gross_adj)))}` : "" },
    ], { cls: "cp-kv" }) : kv([
      { k: "Comps rent", v: money(rec?.value), sub: rec ? `${fr(rec.low)}–${fr(rec.high)} · ${rec.n} comp${rec.n === 1 ? "" : "s"}` : "include a comp" },
      { k: mine ? "Your rent" : "Rent AVM", v: money(avm?.value), sub: avmSub, title: avm ? `${avm.source} ${avm.as_of || ""}` : "" },
      { k: mine ? "Comps vs yours" : "Comps vs AVM", v: f.spct(f.ok(rec?.value) && f.ok(avm?.value) ? rec.value / avm.value - 1 : null), cls: f.cls(f.ok(rec?.value) && f.ok(avm?.value) ? rec.value / avm.value - 1 : null) },
      { k: "Per unit", v: money(f.ok(rec?.value) ? rec.value / units : null), sub: `${units} unit${units > 1 ? "s" : ""}` },
      { k: "Rent / sf", v: f.usd(f.ok(rec?.value) && p.sqft ? rec.value / p.sqft : null, 2), sub: "per month" },
      { k: `GRM at ${bl}`, v: f.num(f.ok(ask) && f.ok(rec?.value) ? ask / (rec.value * 12) : null, 1), title: `${BL} ÷ annual comps rent` },
      { k: "1% rule", v: f.pct(f.ok(ask) && f.ok(rec?.value) ? rec.value / ask : null, 2), title: `Monthly comps rent ÷ ${bl}` },
      { k: "Included", v: `${inc.length} / ${rows.length}`, sub: inc.length ? `avg gross adj ${f.pct(mean(inc.map(r => r.gross_adj)))}` : "" },
    ], { cls: "cp-kv" });

    const noFacts = [["living area", p.sqft], ["Beds", p.beds], ["Baths", p.baths], ["year built", p.year_built], ...(isSale ? [["lot", p.lot]] : [])].filter(([k, v]) => !f.ok(v) || (v === 0 && k !== "Beds" && k !== "Baths")).map(([k]) => k);
    const subj = `Subject ${esc(f.street(p.address))} · ${f.bb(p)} · ${f.sqft(p.sqft)} · built ${p.year_built ?? f.DASH} · lot ${f.sqft(p.lot)}`;
    root.innerHTML = `${panel({ title: isSale ? "Sale comps" : "Rent comps", sub: subj + (P.property.source === "DEMO" ? " · demo data" : ""), flush: true, body: head })}
      ${rows.length && noFacts.length ? `<div class="strip warn"><b>Some lines not adjusted.</b> The subject has no ${noFacts.join(", ").toLowerCase()} on file, so the ${noFacts.map(k => ({ "living area": "size", "year built": "age" })[k] || k.toLowerCase()).join(", ")} adjustment${noFacts.length > 1 ? "s are" : " is"} left out. Add them with Edit facts on <a class="link" data-go="property">Property</a>.</div>` : ""}
      ${err ? `<div class="strip warn"><b>Comps did not load.</b> ${esc(err)}</div>` : ""}
      ${panel({ title: "Adjustment grid", sub: gv === "facts" ? "comp facts and adjusted figure · tick to include in the reconciliation" : "each line moves the comp toward the subject · adjusted = price + net", right: chips("gv", [{ v: "facts", label: "Facts" }, { v: "adj", label: "Adjustments", title: "Per-line adjustments: size, beds, baths, age, lot" }], gv), flush: true, body: `<div id="cp-grid"></div>` })}
      ${!rows.length ? (f.ok(p.lat) && f.ok(p.lon) ? panel({ title: "Map", sub: `<span class="gold">●</span> subject · comps appear here once added · 3D for buildings`, flush: true, cls: "cp-mappnl", body: `<div id="cp-map-slot" class="cp-map"></div><div class="note" id="cp-mapnote"></div>` }) : "") : `<div class="cols2 stretch">
        ${panel({ title: "Map", sub: `<span class="gold">●</span> subject · <span class="acc">●</span> included · <span class="down">●</span> excluded · 3D for buildings`, flush: true, cls: "cp-mappnl", body: `<div id="cp-map-slot" class="cp-map"></div><div class="note" id="cp-mapnote"></div>` })}
        ${panel({ title: isSale ? "$ per square foot" : "Rent per square foot", sub: isSale ? "as sold vs adjusted to the subject's size" : "as listed vs adjusted to the subject's size", body: `<div id="cp-ppsf"></div>` })}
      </div>
      ${panel({ title: "Reconciliation", sub: isSale ? `comps vs ${mine ? "your value" : "AVM"} vs ${bl}` : `comps vs ${mine ? "your rent" : "AVM"}`, body: `<div class="cp-rec"><div id="cp-ldr"></div><div id="cp-stats"></div></div><div class="note">Weight = 1 ÷ (0.05 + gross adjustment + 0.1 × miles), normalised over the included comps. Range = lowest to highest included adjusted ${isSale ? "price" : "rent"}. Adjustments: ${isSale ? "size at half the comp's $/sf, $7,500 a bedroom, $5,000 a bath, $400 a year of age, $2/sf of lot (capped ±$50K)" : "size at half the comp's rent/sf, $150 a bedroom, $75 a bath, $3 a year of age"}. Paired-sales style; not an appraisal.</div>` })}`}`;

    /* grid */
    const present = LINES.filter(k => rows.some(r => r["adj_" + k] != null));
    const pf = isSale ? (v => f.usd(v)) : (v => f.usd(v, 2));
    const F = gv === "facts", A = !F;
    const cols = [
      { k: "included", label: "Inc", c: true, w: 34, title: "Include in the reconciliation", val: r => (r.included ? 1 : 0),
        fmt: (v, r) => `<input type="checkbox" class="cp-inc" data-act="inc" data-id="${r.id}"${v ? " checked" : ""} title="Include in the reconciliation">` },
      { k: "address", label: "Address", l: true, fmt: (v, r) => `<span title="${esc(v || "")}">${esc(f.street(v))}</span>${r.source === "manual" ? ` <span class="tag acc" title="Entered by you">You</span>` : ""}${f.ok(r.lat) ? `<button class="btn ghost cp-sv" data-act="sv1" data-id="${r.id}" title="Open Google Street View at this comp">SV ↗</button>` : ""}` },
      { k: "date", label: isSale ? "Sold" : "Listed", l: true, hide: A, fmt: v => f.dateY(v) },
      { k: "dist_mi", label: "Mi", hide: A, fmt: v => f.num(v, 2) },
      { k: "beds", label: "Bd/Ba", c: true, hide: A, fmt: (v, r) => `${f.ok(r.beds) ? +r.beds : f.DASH}/${f.ok(r.baths) ? +r.baths : f.DASH}` },
      { k: "sqft", label: "Sqft", hide: A, fmt: v => f.int(v) },
      { k: "year_built", label: "Built", hide: A, fmt: v => (v ? String(v) : f.DASH) },
      { k: "price", label: isSale ? "Price" : "Rent", fmt: v => `<b>${f.usd(v)}</b>` },
      { k: "ppsf", label: isSale ? "$/sf" : "$/sf/mo", hide: A, fmt: v => pf(v) },
      ...present.map(k => ({ k: "adj_" + k, label: k, hide: F, title: `${k} adjustment toward the subject`, fmt: v => (v == null ? `<span class="faint">${f.DASH}</span>` : f.susd(v)), cls: v => f.cls(v) })),
      { k: "net", label: "Net adj", hide: F, fmt: v => f.susd(v), cls: v => f.cls(v) },
      { k: "adjusted", label: "Adjusted", fmt: v => `<b class="gold">${f.usd(v)}</b>`, title: "Comp price plus all adjustments" },
      { k: "gross_adj", label: "Gross", title: "Sum of absolute adjustments ÷ comp price (above 25% the comp is weak)", fmt: v => f.pct(v), cls: v => (f.ok(v) && v > 0.25 ? "amb" : "") },
      { k: "wt", label: "Weight", hide: A, title: "Share of the reconciled figure", fmt: v => (f.ok(v) ? f.pct(v) : `<span class="faint">${f.DASH}</span>`) },
    ];
    tblH = table(root.querySelector("#cp-grid"), {
      id: "cp-" + tab, rows, cols, key: r => r.id, sel: selId, sort: { k: "dist_mi", dir: 1 },
      rowCls: r => (r.included ? "" : "dim"), onRow: r => pickRow(r.id), maxH: 400,
      empty: isSale ? "No sale comps yet. Use + Add comp, or with a RentCast key run Refresh AVM on Property to pull comparables."
        : "No rent comps yet. Use + Add comp (kind: rent), or with a RentCast key run Refresh AVM on Property.",
      foot: rows.length ? `${f.int(inc.length)} included of ${f.int(rows.length)} · adjusted ${isSale ? "price" : "rent"} = comp + Σ adjustments` : "",
    });
    bind(root, {
      "chip:gv": v => { gv = v; this.render(root, ctx); },
      "act:inc": async el => {
        const r = await post("/api/comp", { act: "toggle", id: +el.dataset.id, included: el.checked });
        if (r.error) toast(r.error, "bad"); else toast(el.checked ? "Comp included" : "Comp excluded");
      },
      "act:sv1": el => { const r = rows.find(x => x.id === +el.dataset.id); if (r) openStreet(r.lat, r.lon); },
    });

    /* map */
    const pts = [{ id: "s" + pid, lat: p.lat, lon: p.lon, kind: "subject", label: "Subject", html: `<b>${esc(f.street(p.address))}</b><br>Subject · ${f.usd(ask)} ${bl}` }]
      .concat(rows.map(r => ({ id: r.id, lat: r.lat, lon: r.lon, v: r.included ? null : 0, label: f.cusd(r.price),
        html: `<b>${esc(f.street(r.address))}</b><br>${f.usd(r.price)} → ${f.usd(r.adjusted)}<br>${f.bb(r)} · ${f.sqft(r.sqft)} · ${f.num(r.dist_mi, 2)} mi · ${f.dateY(r.date)}${r.included ? "" : "<br>excluded"}` })));
    const unplaced = rows.filter(r => !f.ok(r.lat)).length;
    const noteEl = root.querySelector("#cp-mapnote");
    if (noteEl) {
    noteEl.textContent = !f.ok(p.lat) ? (rows.some(r => f.ok(r.lat)) ? "The subject has no coordinates yet; comps with coordinates still show." : "")
      : unplaced ? `${unplaced} comp${unplaced > 1 ? "s" : ""} entered without coordinates ${unplaced > 1 ? "are" : "is"} not on the map.` : "";
    if (!noteEl.textContent) noteEl.remove();
    const placed = pts.filter(x => f.ok(x.lat) && f.ok(x.lon));
    if (!placed.length && !mapEl) {
      const slot = root.querySelector("#cp-map-slot");
      slot.classList.add("map");
      slot.innerHTML = `<div class="map-off">Nothing to map: neither the subject nor any ${isSale ? "sale" : "rent"} comp has coordinates.</div>`;
    } else {
      const fit = mapPid !== pid || lastKind !== tab;
      mapPid = pid; lastKind = tab;
      ensureMap(root.querySelector("#cp-map-slot"), placed, fit).catch(e => console.error(e));
    }
    }
    if (!rows.length) return;   // nothing to reconcile or chart

    /* reconciliation */
    const adj = inc.map(r => r.adjusted);
    root.querySelector("#cp-ldr").innerHTML = !rows.length ? `<div class="note">Add or pull ${isSale ? "sale" : "rent"} comps to reconcile a figure.</div>` : ladder({
      band: rec ? { lo: rec.low, hi: rec.high, label: "comps range" } : null,
      ticks: rows.map(r => ({ v: r.adjusted, dim: !r.included, title: `${f.street(r.address)} · adjusted ${f.usd(r.adjusted)}${r.included ? "" : " · excluded"}` })),
      pins: [{ v: rec?.value, label: "Comps", cls: "acc" }, { v: avm?.value, label: mine ? "Yours" : "AVM", cls: "mut" }, ...(isSale ? [{ v: ask, label: BL, cls: "gold" }] : [])],
      fmt: isSale ? f.cusd : (v => f.usd(v)),
    });
    root.querySelector("#cp-stats").innerHTML = kv([
      { k: "Weighted", v: money(rec?.value) }, { k: "Mean", v: money(mean(adj)) }, { k: "Median", v: money(median(adj)) },
      { k: "Std dev", v: money(sdev(adj)), sub: f.ok(sdev(adj)) && mean(adj) ? f.pct(sdev(adj) / mean(adj)) : "" },
      { k: "Low", v: money(rec?.low) }, { k: "High", v: money(rec?.high) },
    ], { cls: "tight cp-st" });

    /* $/sf chart */
    const withSf = rows.filter(r => f.ok(r.ppsf) || f.ok(r.appsf));
    const ppEl = root.querySelector("#cp-ppsf");
    if (!withSf.length) ppEl.innerHTML = `<div class="empty"><span>${p.sqft ? "No comps with a living area to compare." : "The subject has no living area. Use Edit facts on Property to add it."}</span></div>`;
    else {
      const cats = withSf.map(r => f.street(r.address) + (r.included ? "" : " (excl)"));
      const subjAsk = isSale && f.ok(ask) && p.sqft ? ask / p.sqft : null, subjRec = f.ok(rec?.value) && p.sqft ? rec.value / p.sqft : null;
      cats.push("Subject");
      C.bars(ppEl, {
        horizontal: true, cats, legend: true,
        series: [{ name: isSale ? `As sold (subject: ${bl})` : "As listed", vals: [...withSf.map(r => r.ppsf), subjAsk], color: "mut" },
          { name: isSale ? "Adjusted (subject: comps value)" : "Adjusted (subject: comps rent)", vals: [...withSf.map(r => r.appsf), subjRec], color: "acc" }],
        y: { fmt: v => (isSale ? f.usd(v) : f.usd(v, 2)) },
        onClick: (c, j) => { if (withSf[j]) pickRow(withSf[j].id); },
      });
    }
  },
  leave() { map?.destroy(); map = null; mapEl = null; mapP = null; mapPid = null; },
};

function csvCols(rows) {
  const ks = LINES.filter(k => rows.some(r => r["adj_" + k] != null));
  return [{ k: "id" }, { k: "address" }, { k: "date" }, { k: "dist_mi" }, { k: "beds" }, { k: "baths" }, { k: "sqft" }, { k: "year_built" }, { k: "price" }, { k: "ppsf" },
    ...ks.map(k => ({ k: "adj_" + k, csv: "adj_" + k.toLowerCase() })), { k: "net" }, { k: "adjusted" }, { k: "gross_adj" }, { k: "included" }, { k: "wt", csv: "weight" }, { k: "source" }];
}

async function addComp(pid, kind) {
  const v = await formModal("Add a comp", [
    { k: "kind", label: "Kind", type: "select", value: kind, options: [{ v: "sale", label: "Sale (sold price)" }, { v: "rent", label: "Rent (per month)" }] },
    { k: "address", label: "Address", full: true, req: true, ph: "123 Main St, Columbus, OH 43201" },
    { k: "price", label: "Price or monthly rent", type: "number", req: true },
    { k: "date", label: "Sale / listing date", type: "date" },
    { k: "beds", label: "Beds", type: "number" }, { k: "baths", label: "Baths", type: "number" },
    { k: "sqft", label: "Living area (sf)", type: "number" }, { k: "year_built", label: "Year built", type: "number" },
    { k: "distance", label: "Distance (miles)", type: "number" },
  ], { ok: "Add comp", note: "From an MLS printout, a broker's sheet or a listing you trust. It is adjusted like the others; it is placed on the map only once it has coordinates." });
  if (!v) return;
  if (!f.ok(v.price) || v.price <= 0) { toast("A positive price (or monthly rent) is needed", "bad"); return; }
  if (f.ok(v.distance) && v.distance < 0) { toast("Distance is in miles from the subject and cannot be negative", "bad"); return; }
  const body = { act: "add", subject_id: pid, kind: v.kind, address: v.address, price: v.price };
  for (const k of ["beds", "baths", "sqft", "year_built", "distance"]) if (f.ok(v[k])) body[k] = v[k];
  if (v.date) body.date = v.date;
  const r = await post("/api/comp", body);
  if (r.error) toast(r.error, "bad"); else { tab = v.kind; toast(`Added ${v.kind} comp ${f.street(v.address)}`); }
}
