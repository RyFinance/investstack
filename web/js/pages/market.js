// Market — ZIP / metro explorer: Zillow home value (ZHVI) and rent (ZORI) indexes for a ZIP against its metro,
// gross yield and price-to-rent, FRED mortgage and 10-year rates, peer ZIPs in the same metro or state, and the
// listings in the ZIP on a map (with the shared 3D button). Every index here is ZIP-level, not property-level.
import { S, f, get, post, pref, select, esc } from "../core.js";
import { table, panel, kv, chips, field, btn, sep, bind, toast, csv, heat, useCss } from "../ui.js";
import * as C from "../charts.js";
import { mapView } from "../map.js";

useCss("market");

let peers = pref("mk.peers") || "metro";
let span = pref("mk.span") || "10y";
let map = null, mapEl = null, mapZip = null, seq = 0;

const curZip = () => {
  const z = pref("zip") || S.prop?.property?.zip || S.state?.config?.home_zip || "43201";
  return /^\d{5}$/.test(String(z)) ? String(z) : "43201";
};
const ok = f.ok;
/** Signed percent that never prints "−0.0%": rounds to the shown precision before choosing the sign. */
const sp = (v, dp = 1) => (ok(v) ? f.spct(+(v * 100).toFixed(dp) / 100 || 0, dp) : f.DASH);
const last = a => (a && a.length ? a[a.length - 1] : null);
const pts = (a, from) => (a || []).filter(p => ok(p.value) && (!from || p.date >= from)).map(p => [p.date, p.value]);
const fromDate = () => {
  if (span === "all") return null;
  const y = +String(S.state?.today || new Date().toISOString()).slice(0, 4) - (span === "5y" ? 5 : 10);
  return `${y}${String(S.state?.today || "-01-01").slice(4, 10)}`;
};
const ptr = (v, r) => (ok(v) && ok(r) && r > 0 ? v / (r * 12) : null);
const yld = (v, r) => (ok(v) && ok(r) && v > 0 ? (r * 12) / v : null);

/** Gross-yield history: rent × 12 / value on months where both indexes exist. */
function yieldSeries(zhvi, zori, from) {
  const v = new Map((zhvi || []).map(p => [String(p.date).slice(0, 7), p.value]));
  return (zori || []).filter(p => (!from || p.date >= from) && ok(p.value) && ok(v.get(String(p.date).slice(0, 7))))
    .map(p => [p.date, yld(v.get(String(p.date).slice(0, 7)), p.value)]);
}

function notDownloaded(root, ctx) {
  const job = S.state?.job || {};
  ctx.sub.innerHTML = "";
  ctx.bar.innerHTML = "";
  root.innerHTML = panel({ title: "Market data", sub: "not downloaded", body: `<div class="empty">
      <b>${job.busy ? "Downloading market data" : "Market indexes are not on this computer yet"}</b>
      <span>${job.busy ? `${esc(job.step || "Working")}… This takes a minute or two; the page fills in when it finishes.`
        : "One download (free, no key) brings in Zillow's ZIP and metro home value and rent indexes for every US ZIP and the FRED mortgage and Treasury rates. It refreshes monthly from Settings."}</span>
      ${job.busy ? `<span class="spin"></span>` : btn("dl", "Download market data", { cls: "pri" })}
      ${job.error ? `<span class="down">${esc(job.error)}</span>` : ""}
    </div><div class="note">Sources: Zillow Research (ZHVI, ZORI), Federal Reserve Bank of St. Louis (FRED). Indexes are ZIP-level and smoothed; they describe a neighbourhood, not a house.</div>` });
  bind(root, {
    "act:dl": async () => {
      const r = await post("/api/market/refresh", { force: false });
      if (r.error) toast(r.error, "bad"); else toast(r.started === false ? "The download did not start here; use Settings → Market data" : "Market data download started");
    },
  });
}

export default {
  id: "market",
  deps: ["prop"],
  async render(root, ctx) {
    if (!S.state?.market?.zips) { seq++; destroyMap(); return notDownloaded(root, ctx); }
    const zip = curZip();

    ctx.sub.innerHTML = field("zip", zip, { label: "ZIP", w: 52, title: "Type a ZIP and press Enter" })
      + (S.prop?.property?.zip && S.prop.property.zip !== zip ? btn("propzip", `Property ZIP ${S.prop.property.zip}`, { cls: "ghost", title: "Show the selected property's ZIP" }) : "")
      + sep() + chips("peers", [{ v: "metro", label: "Metro" }, { v: "state", label: "State" }], peers, { label: "Peers" })
      + sep() + chips("span", ["5y", "10y", "all"], span, { label: "Range" });
    ctx.bar.innerHTML = btn("csv", "CSV", { title: "Export the peer ZIP table" }) + `<span>Zillow · FRED · as of ${esc(f.mo(S.state.market.as_of))}</span>`;
    const setZip = z => { z = String(z || "").trim(); if (!/^\d{5}$/.test(z)) { toast("A ZIP is five digits", "bad"); const el = ctx.sub.querySelector("[data-input=zip]"); if (el) el.value = curZip(); return; } pref("zip", z); this.render(root, ctx); };
    bind(ctx.sub, {
      "enter:zip": v => setZip(v),
      "act:propzip": () => setZip(S.prop.property.zip),
      "chip:peers": v => { peers = v; pref("mk.peers", v); this.render(root, ctx); },
      "chip:span": v => { span = v; pref("mk.span", v); this.render(root, ctx); },
    });

    const my = ++seq;   // a newer render (ZIP typed again, chip clicked) wins; a slower older one stops at its next await
    let m;
    try { m = await get(`/api/market?zip=${zip}`); } catch (e) { root.innerHTML = panel({ title: "Market", body: `<div class="strip warn"><b>The engine did not answer.</b> ${esc(e.message || e)}</div>` }); return; }
    const snap = Object.fromEntries((m.zip_snap || []).map(r => [r.metric, r]));
    const msnap = Object.fromEntries((m.metro_snap || []).map(r => [r.metric, r]));
    const zv = snap.zhvi, zr = snap.zori, mv = msnap.zhvi, mr = msnap.zori;
    const state = zv?.state || zr?.state || S.prop?.property?.state || "";
    const metroName = zv?.metro || zr?.metro || "";
    let rows = [];
    const q = peers === "metro" && metroName ? `metro=${encodeURIComponent(metroName)}` : state ? `state=${encodeURIComponent(state)}` : "";
    if (my !== seq) return;
    if (q) { try { rows = await get(`/api/zips?${q}`); } catch (e) { rows = []; } }
    if (my !== seq) return;
    rows = (rows || []).map(r => ({ ...r, key: r.zip, ptr: ptr(r.value, r.rent) }));
    bind(ctx.bar, { "act:csv": () => csv(`valora-zips-${peers === "metro" ? "metro" : state.toLowerCase()}-${zip}.csv`,
      ["zip", "city", "state", "metro", "value", "value_1y", "value_5y", "rent", "rent_1y", "rent_5y", "yield", "ptr", "as_of"].map(k => ({ k })), rows) });

    if (!zv && !zr) {
      root.innerHTML = panel({ title: `ZIP ${zip}`, body: `<div class="empty"><b>Zillow publishes no index for ZIP ${esc(zip)}</b>
        <span>Small or non-residential ZIPs have no ZHVI or ZORI. ${rows.length ? "Try a neighbouring ZIP, or pick one from the table below." : "Try a neighbouring ZIP (for the demo market, 43201)."}</span></div>` })
        + ratesPanel(m) + (rows.length ? panel({ title: "ZIPs", flush: true, body: `<div id="mk-t"></div>` }) : "");
      drawRates(root, m);
      if (rows.length) drawTable(root, rows, zip, setZip);
      destroyMap();
      return;
    }

    const rank = (k, v) => { const xs = rows.map(r => r[k]).filter(ok); if (!ok(v) || xs.length < 5) return ""; const p = xs.filter(x => x <= v).length / xs.length; return `p${Math.round(p * 100)} of ${xs.length}`; };
    const yNow = yld(zv?.latest, zr?.latest), yMetro = yld(mv?.latest, mr?.latest);
    const r10 = last(m.rates?.DGS10);
    const from = fromDate();
    const zoriN = (m.zip?.zori || []).filter(p => ok(p.value)).length, thin = zoriN > 0 && zoriN < 24;

    root.innerHTML = `<section class="pnl">
        <div class="ph"><h3>ZIP ${esc(zip)}</h3><span class="s">${esc([zv?.name || zr?.name, state].filter(Boolean).join(", "))}${metroName ? ` · ${esc(metroName)} metro` : ""} · ZIP-level indexes, month-end ${esc(f.mo(zv?.as_of || zr?.as_of))}</span>
          <div class="r"><a class="link" data-act="tick" title="Show this ZIP in the right panel">Ticket</a></div></div>
        ${kv([
          { k: "Value (ZHVI)", v: f.usd(zv?.latest), sub: mv ? `metro ${f.cusd(mv.latest)}` : "", title: "Zillow Home Value Index: typical home value, smoothed, seasonally adjusted" },
          { k: "Value 1y", v: sp(zv?.chg1y), cls: f.cls(zv?.chg1y), sub: mv ? `metro ${sp(mv.chg1y)}` : "" },
          { k: "Value 5y", v: sp(zv?.chg5y), cls: f.cls(zv?.chg5y), sub: mv ? `metro ${sp(mv.chg5y)}` : "" },
          { k: "Rent (ZORI)", v: f.usd(zr?.latest), sub: mr ? `metro ${f.usd(mr.latest)}` : "", title: "Zillow Observed Rent Index: typical asking rent, all unit types" },
          { k: "Rent 1y", v: sp(zr?.chg1y), cls: f.cls(zr?.chg1y), sub: mr ? `metro ${sp(mr.chg1y)}` : "" },
          { k: "Gross yield", v: f.pct(yNow, 2), cls: thin ? "amb" : "", sub: thin ? `rent index only ${zoriN} mo — rough` : yMetro != null ? `metro ${f.pct(yMetro, 2)}` : rank("yield", yNow), title: "ZORI × 12 / ZHVI. Before vacancy, expenses and financing" + (thin ? ". Zillow has published this ZIP's rent index for under two years, from few listings: treat the yield as rough" : "") },
          { k: "Price / rent", v: ok(ptr(zv?.latest, zr?.latest)) ? f.num(ptr(zv?.latest, zr?.latest), 1) : f.DASH, sub: ok(ptr(mv?.latest, mr?.latest)) ? `metro ${f.num(ptr(mv.latest, mr.latest), 1)}` : "", title: "ZHVI / (ZORI × 12): years of gross rent to pay the price" },
        ])}
      </section>
      <div class="mk-g2">
        ${panel({ title: "Home value index", sub: `ZIP ${esc(zip)} vs ${esc(metroName || "metro")} · ZHVI`, body: `<div id="mk-v"></div>` })}
        ${panel({ title: "Rent index", sub: `ZIP ${esc(zip)} vs ${esc(metroName || "metro")} · ZORI`, body: `<div id="mk-r"></div>` })}
      </div>
      <div class="mk-g2">
        ${panel({ title: "Gross yield", sub: "ZORI × 12 / ZHVI, months where both exist", body: `<div id="mk-y"></div>` })}
        ${ratesPanel(m, yNow)}
      </div>
      ${localPanel(m, zip, zr)}
      <div class="mk-g2 mk-wide">
        ${panel({ title: peers === "metro" && metroName ? `ZIPs in ${metroName}` : `ZIPs in ${state || "the state"}`, sub: `${f.int(rows.length)} with a value index · click to select, double-click to open`, flush: true, body: `<div id="mk-t"></div>`, cls: "mk-tp" })}
        <div class="mk-stack">
          ${panel({ title: "Yield vs 1-year value change", sub: "peer ZIPs · gold = this ZIP · click a point to open it", body: `<div id="mk-s"></div>` })}
          ${panel({ title: "Listings in this ZIP", sub: `<span id="mk-ln">—</span>`, flush: true, body: `<div id="mk-map" class="mk-map"></div>` })}
        </div>
      </div>
      <div class="note">Source: Zillow Research (ZHVI, ZORI; ZIP and metro, smoothed, monthly), Federal Reserve Bank of St. Louis FRED (MORTGAGE30US, DGS10). Indexes describe the ZIP, not a particular property. Percentile ranks are among the peer ZIPs shown.</div>`;

    bind(root, { "act:tick": () => select({ kind: "zip", id: zip, row: rows.find(r => r.zip === zip) || { zip, city: zv?.name, state, metro: metroName, value: zv?.latest, value_1y: zv?.chg1y, value_5y: zv?.chg5y, rent: zr?.latest, rent_1y: zr?.chg1y, rent_5y: zr?.chg5y, yield: yNow } }) });

    const usdAx = { fmt: v => "$" + f.compact(v) };
    C.line(root.querySelector("#mk-v"), { h: 220, x: { type: "date" }, y: usdAx, empty: "No home value index for this ZIP",
      series: [{ name: `ZIP ${zip}`, pts: pts(m.zip?.zhvi, from), color: "acc", width: 1.8, dots: "last" }, { name: "Metro", pts: pts(m.metro?.zhvi, from), color: "mut", dash: true }] });
    C.line(root.querySelector("#mk-r"), { h: 220, x: { type: "date" }, y: { fmt: v => "$" + f.int(v) }, empty: "Zillow publishes no rent index for this ZIP",
      series: [{ name: `ZIP ${zip}`, pts: pts(m.zip?.zori, from), color: "amber", width: 1.8, dots: "last" }, { name: "Metro", pts: pts(m.metro?.zori, from), color: "mut", dash: true }] });
    C.line(root.querySelector("#mk-y"), { h: 236, x: { type: "date" }, y: { fmt: v => (v * 100).toFixed(1) + "%" }, empty: "Needs both a value and a rent index",
      series: [{ name: `ZIP ${zip}`, pts: yieldSeries(m.zip?.zhvi, m.zip?.zori, from), color: "acc", width: 1.8, dots: "last" }, { name: "Metro", pts: yieldSeries(m.metro?.zhvi, m.metro?.zori, from), color: "mut", dash: true }],
      hmarks: r10 ? [{ y: r10.value / 100, label: `10y ${f.num(r10.value, 2)}%`, color: "down" }] : [] });
    drawRates(root, m, from);
    drawTable(root, rows, zip, setZip);

    const spts = rows.filter(r => ok(r.yield) && ok(r.value_1y));
    C.scatter(root.querySelector("#mk-s"), { h: 230, x: { label: "Value 1y", fmt: v => sp(v, 0) }, y: { label: "Gross yield", fmt: v => f.pct(v, 1) }, labels: false,
      empty: "Peer ZIPs need both a value and a rent index",
      pts: spts.map(r => ({ x: r.value_1y, y: r.yield, label: `${r.zip} ${r.city || ""}`.trim(), color: r.zip === zip ? "--gold" : "acc", r: r.zip === zip ? 5.5 : 3, zip: r.zip })),
      onClick: p => setZip(p.zip) });

    drawMap(root, zip);
  },
  leave() { destroyMap(); },
};

function ratesPanel(m, yNow) {
  const has = (m.rates?.MORTGAGE30US || []).length || (m.rates?.DGS10 || []).length;
  const r30 = last(m.rates?.MORTGAGE30US), r10 = last(m.rates?.DGS10), r30y = (m.rates?.MORTGAGE30US || []).find(p => p.date >= shiftY(r30?.date, -1));
  const strip = has ? kv([
    { k: "30-yr mtg", v: r30 ? f.num(r30.value, 2) + "%" : f.DASH, sub: r30 ? f.date(r30.date) : "", title: "Freddie Mac PMMS via FRED (MORTGAGE30US); investor loans usually price 0.5–1 point higher" },
    { k: "1-yr chg", v: r30 && r30y ? bp((r30.value - r30y.value) * 100) : f.DASH, cls: r30 && r30y ? f.cls(r30y.value - r30.value) : "", title: "Lower rates shown green" },
    { k: "10-yr UST", v: r10 ? f.num(r10.value, 2) + "%" : f.DASH, sub: r10 ? f.date(r10.date) : "", title: "FRED DGS10" },
    { k: "Yield − 10y", v: ok(yNow) && r10 ? bp((yNow * 100 - r10.value) * 100) : f.DASH, cls: ok(yNow) && r10 ? f.cls(yNow * 100 - r10.value) : "", title: "This ZIP's gross yield over the 10-year Treasury" },
  ], { cls: "tight mk-k4" }) : "";
  return panel({ title: "Rates", sub: has ? "Freddie Mac PMMS 30-yr, 10-yr Treasury · FRED" : "not downloaded", flush: true, body: `${strip}<div id="mk-rt" class="pb">${has ? "" : `<div class="empty"><b>FRED rates are not on this computer</b><span>Settings → Market data → Update brings in MORTGAGE30US and DGS10 (free, no key).</span></div>`}</div>` });
}

function drawRates(root, m, from) {
  const el = root.querySelector("#mk-rt");
  if (!el || !((m.rates?.MORTGAGE30US || []).length || (m.rates?.DGS10 || []).length)) return;
  C.line(el, { h: 176, x: { type: "date" }, y: { fmt: v => v.toFixed(1) + "%", ticks: 4 },
    series: [{ name: "30-yr mortgage", pts: pts(m.rates.MORTGAGE30US, from), color: "violet", width: 1.6, dots: "last" }, { name: "10-yr Treasury", pts: pts(m.rates.DGS10, from), color: "cyan", width: 1.4, dots: "last" }] });
}

function drawTable(root, rows, zip, setZip) {
  const el = root.querySelector("#mk-t");
  if (!el) return;
  const ys = rows.map(r => r.yield).filter(ok).sort((a, b) => a - b), yLo = ys[Math.floor(ys.length * 0.1)] ?? 0.04, yHi = ys[Math.floor(ys.length * 0.9)] ?? 0.1;
  table(el, {
    id: "mk-zips", rows, key: r => r.zip, sel: S.sel?.kind === "zip" ? S.sel.id : zip, maxH: 520, sort: { k: "yield", dir: -1 },
    rowCls: r => (r.zip === zip ? "mk-cur" : ""),
    empty: "No peer ZIPs with a value index",
    onRow: r => select({ kind: "zip", id: r.zip, row: r }),
    onDbl: r => setZip(r.zip),
    cols: [
      { k: "zip", label: "ZIP", l: true, fmt: (v, r) => `<b>${esc(v)}</b>` },
      { k: "city", label: "Place", l: true, fmt: v => `<span class="mk-city">${esc(v || "—")}</span>` },
      { k: "value", label: "Value", title: "ZHVI, latest month", fmt: v => f.cusd(v) },
      { k: "value_1y", label: "1y", title: "ZHVI change over 1 year", fmt: v => sp(v), cls: v => f.cls(v), heat: v => heat(v, -0.08, 0.08, { mid: 0 }) },
      { k: "value_5y", label: "5y", title: "ZHVI change over 5 years", fmt: v => sp(v, 0), cls: v => f.cls(v) },
      { k: "rent", label: "Rent", title: "ZORI, latest month", fmt: v => f.usd(v) },
      { k: "rent_1y", label: "Rent 1y", fmt: v => sp(v), cls: v => f.cls(v) },
      { k: "yield", label: "Yield", title: "Gross: ZORI × 12 / ZHVI", fmt: v => f.pct(v, 2), heat: v => heat(v, yLo, yHi, { color: "--gold", max: 26 }) },
      { k: "ptr", label: "P/R", title: "Price-to-rent: ZHVI / (ZORI × 12)", fmt: v => (ok(v) ? f.num(v, 1) : f.DASH) },
    ],
  });
}

async function drawMap(root, zip) {
  const holder = root.querySelector("#mk-map"), note = root.querySelector("#mk-ln");
  let L = [];
  try { L = (await get(`/api/listings?kind=sale&zip=${zip}`))?.rows || []; } catch (e) { L = []; }
  if (!root.contains(holder)) return;
  const P = L.filter(r => ok(r.lat) && ok(r.lon)).map(r => ({
    id: r.id, lat: r.lat, lon: r.lon, v: r.score, label: f.cusd(r.price),
    html: `<b>${esc(f.street(r.address))}</b><br>${f.usd(r.price)} · ${f.bb(r)} · ${f.sqft(r.sqft)}<br>cap ${f.pct(r.cap, 1)} · CoC ${f.pct(r.coc, 1)} · score ${f.score(r.score)}`,
  }));
  if (note) note.textContent = L.length ? `${f.int(L.length)} for sale · median ${f.usd(median(L.map(r => r.price)))} · colour = score · 3D for buildings` : "none on file";
  if (!P.length) {
    destroyMap();
    holder.innerHTML = `<div class="empty"><span>No listings on file in ${esc(zip)}. Pull live listings on Search (RentCast key in Settings).</span></div>`;
    holder.classList.remove("mk-map");
    return;
  }
  // keep one map instance: move the live element into the new layout instead of rebuilding it
  if (map && !map.off && mapEl) {
    holder.replaceWith(mapEl);
    mapEl.id = "mk-map";
    map.setPoints(P, { fit: mapZip !== zip });
    mapZip = zip;
    return;
  }
  const mv = await mapView(holder, { points: P, labels: true, tilt3d: true, legend: ["low score", "high score"], onClick: id => select({ kind: "property", id: +id, row: L.find(r => r.id === +id) }) });
  if (!root.contains(holder)) { try { mv.destroy(); } catch (e) { /* gone */ } return; }   // a newer render replaced the layout meanwhile
  if (map && map !== mv) { try { map.destroy(); } catch (e) { /* gone */ } }
  map = mv; mapEl = holder; mapZip = zip;
  map.setPoints(P, { fit: true });
}

function destroyMap() {
  try { map?.destroy(); } catch (e) { /* already gone */ }
  map = null; mapEl = null; mapZip = null;
}

/** Census ACS (ZCTA) and HUD Fair Market Rents: optional, need free keys in Settings; null fields show a dash. */
function localPanel(m, zip, zr) {
  const a = m.acs, h = m.fmr, hasA = a && a.year != null, hasH = h && h.rents;
  const keys = S.state?.config || {};
  if (!hasA && !hasH) {
    const need = [!keys.has_census_key && "a Census key (median rent, income, vacancy by ZIP)", !keys.has_hud_token && "a HUD token (Fair Market Rents by bedroom)"].filter(Boolean);
    return `<div class="note mk-ln">${need.length ? `Add ${need.join(" and ")} in Settings to show them for ${esc(zip)}. Both are free.` : `Census ACS and HUD FMR returned nothing for ${esc(zip)} (no ZCTA match or the service did not answer).`}</div>`;
  }
  const beds = ["0", "1", "2", "3", "4"];
  const fmrCells = hasH ? `<table class="t mk-fmr"><thead><tr><th class="l">Bedrooms</th>${beds.map(b => `<th>${b === "0" ? "Studio" : b}</th>`).join("")}</tr></thead>
      <tbody><tr><td class="l">Fair Market Rent</td>${beds.map(b => `<td>${f.usd(h.rents[b])}</td>`).join("")}</tr>
      ${ok(zr?.latest) ? `<tr><td class="l">ZORI ÷ FMR (2 bd)</td><td colspan="5" class="l mut">${ok(h.rents["2"]) ? f.num(zr.latest / h.rents["2"], 2) + "× — ZORI is all unit types, so this is a rough read" : f.DASH}</td></tr>` : ""}</tbody></table>` : "";
  return `<div class="mk-g2">
    ${panel({ title: "Census ACS", sub: hasA ? esc(a.source) : "add a Census key in Settings", flush: true, body: hasA ? kv([
      { k: "Median gross rent", v: f.usd(a.median_rent), sub: ok(zr?.latest) && ok(a.median_rent) ? `ZORI ${sp(zr.latest / a.median_rent - 1, 0)}` : "", title: "B25064: all renter units incl. long-tenure leases; ZORI is asking rent for new leases" },
      { k: "Median income", v: f.usd(a.median_income), sub: ok(a.median_income) && ok(zr?.latest) ? `rent ${f.pct(zr.latest * 12 / a.median_income, 0)} of income` : "", title: "B19013 household income" },
      { k: "Housing units", v: ok(a.housing_units) ? f.int(a.housing_units) : f.DASH, title: "B25002" },
      { k: "Vacancy", v: f.pct(a.vacancy_rate, 1), title: "B25002 vacant / total units (all vacancy types, incl. seasonal)" },
    ], { cls: "tight" }) : `<div class="note">Not available for ${esc(zip)}.</div>` })}
    ${panel({ title: "HUD Fair Market Rents", sub: hasH ? esc(h.source) : "add a HUD token in Settings", flush: true, body: hasH ? fmrCells : `<div class="note">Not available for ${esc(zip)}.</div>` })}
  </div>`;
}

const bp = v => `${v > 0.5 ? "+" : v < -0.5 ? "−" : ""}${f.num(Math.abs(v), 0)} bp`;
const shiftY = (d, n) => (d ? `${+String(d).slice(0, 4) + n}${String(d).slice(4)}` : "9999");
const median = a => { const b = a.filter(ok).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; };
