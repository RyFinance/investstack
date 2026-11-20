// Search — the landing page: listings on a map coloured by score, a dense sortable table, filters in the command bar.
// Selection is shared both ways: a row click selects the point, a point click selects (and scrolls to) the row.
import { S, f, get, post, go, select, esc, load, save, openExternal, streetView, upload } from "../core.js";
import { table, panel, kv, chips, field, selectBox, btn, sep, bind, toast, formModal, confirmModal, csv, scoreBar, parseNum, useCss, pickFiles } from "../ui.js";
import { mapView } from "../map.js";

useCss("search");

const TYPES = ["Single Family", "Multi-Family", "Townhouse", "Condo", "Manufactured", "Apartment", "Land"];
const TY = { "Single Family": "SF", "Multi-Family": "MF", Townhouse: "TH", Condo: "Condo", Manufactured: "Mfd", Apartment: "Apt", Land: "Land" };
const BEDS = [{ v: "", label: "Any" }, { v: "1", label: "1+" }, { v: "2", label: "2+" }, { v: "3", label: "3+" }, { v: "4", label: "4+" }];
const DEF = { kind: "sale", loc: "", min_price: "", max_price: "", beds: "", type: "", min_score: "" };

let F = { ...DEF, ...load("search.f", {}) };
let M = null, mapping = null, mapGen = 0, tbl = null, fitNext = true;
let data = { rows: [], notes: [], weights: {} }, view = [], saved = [], pulled = [], savedId = null, deals = new Map();
let pane = load("search.pane", "map") === "street" ? "street" : "map", svShown = null, svGen = 0, mapBlind = false;
const hasLL = r => !!r && f.ok(r.lat) && f.ok(r.lon);
const earth = (lat, lon) => `https://earth.google.com/web/@${+lat},${+lon},260a,420d,35y,0h,62t,0r`;

const median = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const selId = () => (S.sel?.kind === "property" ? +S.sel.id : null);
const isRent = () => F.kind === "rent";
const keep = () => save("search.f", F);

/** "43201" → zip; "Columbus" or "Columbus, OH" → city (+ state). */
function where() {
  const s = String(F.loc || "").trim();
  if (!s) return {};
  if (/^\d{5}$/.test(s)) return { zip: s };
  const [city, st] = s.split(",").map(x => x.trim());
  return st ? { city, state: st.toUpperCase().slice(0, 2) } : { city };
}

function path() {
  const q = new URLSearchParams({ kind: F.kind });
  const w = where();
  if (w.zip) q.set("zip", w.zip);
  if (w.city) q.set("city", w.city);
  for (const k of ["min_price", "max_price", "type"]) if (F[k] !== "" && F[k] != null) q.set(k, F[k]);
  if (F.beds) q.set("min_beds", F.beds);
  return "/api/listings?" + q.toString();
}

function filtered(rows) {
  const ms = parseNum(F.min_score);
  return ms == null || isRent() ? rows : rows.filter(r => f.ok(r.score) && r.score >= ms);
}

function rateLine() {
  const m = S.state?.rates?.MORTGAGE30US;
  return m && f.ok(m.value) ? { v: `${(m.value + 0.75).toFixed(2)}%`, src: `FRED 30y ${(+m.value).toFixed(2)}% + 0.75 investor` } : { v: "7.75%", src: "default rate (FRED not downloaded)" };
}

const srcKind = s => (!s ? "x" : /rough/i.test(s) ? "x" : /your/i.test(s) ? "m" : "e");
const srcShort = s => (!s ? "no estimate" : /rentcast/i.test(s) ? "RentCast AVM" : /zori/i.test(s) ? "Zillow ZORI (ZIP), rough" : /demo/i.test(s) ? "Demo estimate" : s);

/* ---------- command bar ---------- */

function drawSub(ctx) {
  ctx.sub.innerHTML = `<span data-sr-sub hidden></span>` + chips("kind", [{ v: "sale", label: "For sale" }, { v: "rent", label: "For rent" }], F.kind);
}

/** The filter row at the top of the page (the command bar is too narrow for all of them). */
function drawFilters(root, saved) {
  const items = [{ v: "", label: saved.length ? `Saved searches (${saved.length})` : "No saved searches" }, ...saved.map(s => ({ v: s.id, label: s.name }))];
  root.querySelector("#sr-f").innerHTML = `<div class="sr-fl">`
    + field("loc", F.loc, { label: "ZIP / city", w: 120, title: "A 5-digit ZIP, a city, or City, ST — also where Pull live listings looks" }) + sep()
    + field("min_price", F.min_price, { label: isRent() ? "Rent" : "Price", pre: "$", w: 58, title: "Minimum (1.5k, 200k)" })
    + `<span class="faint" style="margin:0 4px">–</span>` + field("max_price", F.max_price, { pre: "$", w: 58, title: "Maximum (1.5k, 400k)" }) + sep()
    + chips("beds", BEDS, F.beds, { label: "Beds" }) + sep()
    + selectBox("type", [{ v: "", label: "All types" }, ...TYPES], F.type) + sep()
    + (isRent() ? "" : field("min_score", F.min_score, { label: "Score ≥", w: 32, title: "Hide listings scoring below this (0–100)" }) + sep())
    + `<span class="sr-sv">` + selectBox("saved", items, savedId ?? "", { title: "Load a saved search" })
    + btn("save-search", "Save search", { cls: "ghost", title: "Save these filters as a named search" })
    + (savedId != null ? btn("del-search", "Delete", { cls: "ghost", title: "Delete the loaded saved search" }) : "")
    + (JSON.stringify({ ...F, kind: "sale" }) !== JSON.stringify(DEF) ? btn("clear", "Clear filters", { cls: "ghost", title: "Reset every filter" }) : "")
    + `</span></div>`;
}

function drawBar(ctx) {
  const key = !!S.state?.rentcast?.has_key;
  ctx.bar.innerHTML = btn("pull", "Pull live listings", { cls: key ? "pri" : "", title: key ? "Download active listings for the ZIP or city from RentCast (1 call)" : "Needs a RentCast API key (Settings)" })
    + btn("import", "Import listings", { title: "A listings CSV (e.g. Redfin's Download All export), a saved alert email (.eml) or a text file of addresses" })
    + btn("paste", "Paste addresses", { title: "Paste addresses, listing text or alert-email text; each address becomes a listing (geocoded free)" })
    + btn("add", "Add property", { title: "Enter a property by hand" });
}

function setF(k, v, ctx, root) {
  F[k] = v; savedId = null; fitNext = true; keep();
  refresh(root, ctx, true);
}

function wire(root, ctx) {
  const num = k => v => setF(k, v === "" ? "" : String(parseNum(v) ?? ""), ctx, root);
  const map = {
    "chip:kind": v => { F.kind = v; savedId = null; fitNext = true; keep(); refresh(root, ctx, true); },
    "chip:beds": v => setF("beds", v, ctx, root),
    "change:loc": v => setF("loc", v.trim(), ctx, root),
    "change:min_price": num("min_price"), "change:max_price": num("max_price"),
    "change:min_score": num("min_score"),
    "change:type": v => setF("type", v, ctx, root),
    "change:saved": v => {
      const s = saved.find(x => String(x.id) === String(v));
      if (!s) { savedId = null; return; }
      let q = {};
      try { q = JSON.parse(s.query || "{}"); } catch (e) { q = {}; }
      F = { ...DEF, ...q }; savedId = s.id; fitNext = true; keep();
      refresh(root, ctx, true);
    },
    "act:save-search": async () => {
      const v = await formModal("Save search", [{ k: "name", label: "Name", value: describe(), full: true, req: true }], { ok: "Save" });
      if (!v || !v.name) return;
      const r = await post("/api/searches", { name: v.name, query: F });
      if (r.error) toast(r.error, "bad"); else toast(`Saved “${v.name}”`);
    },
    "act:del-search": async () => {
      const s = saved.find(x => x.id === savedId);
      if (!s || !(await confirmModal("Delete saved search", `Delete “${esc(s.name)}”? The listings themselves are not touched.`, "Delete"))) return;
      savedId = null;
      const r = await post("/api/searches", { delete: s.id });
      if (r.error) toast(r.error, "bad");
    },
    "act:clear": () => { F = { ...DEF, kind: F.kind }; savedId = null; fitNext = true; keep(); refresh(root, ctx, true); },
    "act:pull": el => pull(el),
    "act:add": () => addProp(),
    "act:import": () => importListings(),
    "act:paste": () => pasteAddresses(),
    "chip:pane": v => { pane = v === "street" ? "street" : "map"; save("search.pane", pane); drawPane(root); drawHead(root); if (pane === "map") refit(); },
    "act:earth": () => { const r = cur(); if (hasLL(r)) openExternal(earth(r.lat, r.lon)); },
    "act:gmap": async () => { const r = cur(); if (!hasLL(r)) return; const sv = await svFor(r); if (sv?.maps) openExternal(sv.maps); },
    "act:csv": () => csv(`valora-${F.kind}-listings.csv`, csvCols(), tbl?.view() || view),
    "act:open": () => { const id = selId(); if (id != null) go("property", id); },
    "act:uw": () => { const id = selId(); if (id != null) go("underwrite", id); },
    "act:pipe": el => addPipe(el),
    "act:sv": async () => {
      const r = cur();
      if (!hasLL(r)) return;
      const sv = await svFor(r);
      if (sv?.link) openExternal(sv.link); else toast("Street View could not be opened", "bad");
    },
    "act:3d": () => {
      const r = cur();
      if (!hasLL(r) || !M || M.off) return;
      if (pane !== "map") { pane = "map"; save("search.pane", pane); drawPane(root); drawHead(root); mapBlind = false; }
      M.flyTo(r.lat, r.lon, 16.6);
      setTimeout(() => M?.set3d?.(true), 450);
    },
  };
  bind(ctx.sub, map);
  bind(ctx.bar, map);
  bind(root, map);
}

const describe = () => {
  const w = where(), p = [F.kind === "rent" ? "Rentals" : "For sale", w.zip || w.city || "all areas"];
  if (F.min_price || F.max_price) p.push(`${F.min_price ? f.cusd(+F.min_price) : "$0"}–${F.max_price ? f.cusd(+F.max_price) : "any"}`);
  if (F.beds) p.push(`${F.beds}+ bd`);
  if (F.type) p.push(F.type);
  if (F.min_score) p.push(`score ≥ ${F.min_score}`);
  return p.join(" · ");
};

/* ---------- actions ---------- */

async function pull(el) {
  if (!S.state?.rentcast?.has_key) { toast("Pulling live listings needs a RentCast API key. Add it in Settings (the free plan includes 50 calls a month).", "bad"); return; }
  const w = where();
  if (!w.zip && !w.city) { toast("Type a ZIP or a city in the ZIP / city field first", "bad"); return; }
  el.disabled = true; el.textContent = "Pulling…";
  const r = await post("/api/listings", { kind: F.kind, ...w });
  el.disabled = false; el.textContent = "Pull live listings";
  if (r.error) { toast(r.error, "bad"); return; }
  pulled = (r.notes || []).map(n => `${new Date().toTimeString().slice(0, 5)} · ${w.zip || w.city}: ${n}`);
  fitNext = true;
  toast(r.notes?.[0] || `${f.int(r.rows?.length)} listings`);
}

async function addProp() {
  const v = await formModal("Add a property", [
    { k: "address", label: "Street address", full: true, req: true, ph: "123 Main St" },
    { k: "city", label: "City" }, { k: "state", label: "State", ph: "OH" }, { k: "zip", label: "ZIP" },
    { k: "type", label: "Type", type: "select", value: "Single Family", options: TYPES },
    { k: "beds", label: "Beds", type: "number" }, { k: "baths", label: "Baths", type: "number" },
    { k: "sqft", label: "Square feet", type: "number" }, { k: "year_built", label: "Year built", type: "number" },
    { k: "units", label: "Units", type: "number", value: 1 }, { k: "price", label: "Asking price", type: "number", ph: "optional; lists it for sale" },
  ], { ok: "Add", note: "Only the address is required. With an asking price the property appears in Search as a manual listing." });
  if (!v || !v.address) return;
  const body = { ...v, state: (v.state || "").toUpperCase() };
  for (const k of Object.keys(body)) if (body[k] === "" || body[k] == null) delete body[k];
  const r = await post("/api/property/add", body);
  if (r.error || r.id == null) { toast(r.error || "The property was not added", "bad"); return; }
  toast("Property added");
  go("property", r.id);
}

/** Import result → one toast line. */
function importLine(r, what) {
  if (!r || r.error) return null;
  const n = +r.rows || 0, parts = [`${f.int(n)} listing${n === 1 ? "" : "s"} read`];
  if (f.ok(r.new)) parts.push(`${f.int(r.new)} new`);
  if (f.ok(r.updated) && +r.updated) parts.push(`${f.int(r.updated)} updated`);
  if (f.ok(r.sold) && +r.sold) parts.push(`${f.int(r.sold)} marked sold`);
  return `${what}: ${parts.join(", ")}`;
}

async function importListings() {
  const files = await pickFiles(".csv,.eml,.txt");
  if (!files?.length) return;
  toast(`Reading ${files.length} file${files.length > 1 ? "s" : ""}…`);
  const res = await upload(files, { kind: "listings" });
  const bad = res.find(r => r.error), lines = res.map(r => importLine(r, r.name)).filter(Boolean);
  const notListings = res.filter(r => !r.error && r.kind !== "listings");
  if (bad) toast(`${bad.name}: ${bad.error}`, "bad");
  else if (notListings.length && !lines.length) toast(`${notListings[0].name} is not a listings file; it was filed in the Inbox instead`);
  else toast(lines.join(" · ") || "Nothing imported");
  pulled = [...lines.map(l => `${new Date().toTimeString().slice(0, 5)} · ${l}`), ...pulled].slice(0, 4);
  fitNext = true;
}

async function pasteAddresses() {
  const v = await formModal("Paste addresses", [
    { k: "text", label: "Addresses or listing text", type: "textarea", full: true, req: true, ph: "1234 Oak St, Columbus, OH 43201  $215,000  3 bd 2 ba\n…" },
  ], { ok: "Import", note: "One address per line, or paste a listing page or alert email as text. Each address found becomes a listing; prices, beds, baths and square feet are read when present. Addresses are geocoded free (US Census)." });
  if (!v || !String(v.text || "").trim()) return;
  const r = await post("/api/import/text", { text: v.text, source: "pasted" });
  if (r.error) { toast(r.error, "bad"); return; }
  const line = importLine(r, "Pasted");
  if (!+r.rows) { toast("No street addresses were found in the pasted text", "bad"); return; }
  pulled = [`${new Date().toTimeString().slice(0, 5)} · ${line}`, ...pulled].slice(0, 4);
  fitNext = true;
  toast(line);
}

async function addPipe(el) {
  const r = cur();
  if (!r) return;
  if (deals.has(r.id)) { go("pipeline"); return; }
  el.disabled = true;
  const x = await post("/api/pipeline", { act: "add", property_id: r.id, ask: r.price ?? null, strategy: "rental", score: f.ok(r.score) ? Math.round(r.score) : null });
  el.disabled = false;
  if (x.error) toast(x.error, "bad"); else toast(`${f.street(r.address)} added to the pipeline (Discovered)`);
}

const cur = () => { const id = selId(); return id == null ? null : data.rows.find(r => r.id === id) || (S.sel?.row?.id === id ? S.sel.row : null); };

/* ---------- table ---------- */

const addrCell = (v, r) => {
  const d = deals.get(r.id);
  return `<span class="sr-addr" title="${esc(r.address)}">${esc(f.street(r.address))}</span><span class="sr-zip">${esc(r.zip || "")}</span>`
    + (r.type && r.type !== "Single Family" ? `<span class="sr-ty" title="${esc(r.type)}${(r.units || 1) > 1 ? ", " + r.units + " units" : ""}">${esc(TY[r.type] || r.type)}${(r.units || 1) > 1 ? "·" + r.units : ""}</span>` : "")
    + (d ? ` <span class="tag ${/reject/i.test(d) ? "mut" : "acc"}" title="In the pipeline: ${esc(d)}">${/reject/i.test(d) ? "rejected" : "deal"}</span>` : "")
    + (r.l_source === "manual" ? ` <span class="tag mut" title="Entered by hand">manual</span>` : "");
};
const bbCell = (v, r) => `${f.ok(r.beds) ? +r.beds : f.DASH}/${f.ok(r.baths) ? +r.baths : f.DASH}`;
const rentCell = (v, r) => (f.ok(v) ? `<span title="${esc(r.rent_src || "")}">${f.usd(v)}</span><i class="src-dot ${srcKind(r.rent_src)}" title="${esc(r.rent_src || "")}"></i>` : f.DASH);

function cols() {
  const base = [
    { k: "address", label: "Address", l: true, val: r => r.address, fmt: addrCell, title: "Street, ZIP, and type when not single-family (MF·4 = 4 units)" },
  ];
  if (isRent()) return base.concat([
    { k: "price", label: "Rent/mo", fmt: v => f.usd(v), title: "Asking rent per month" },
    { k: "ppsf_m", label: "$/sf/mo", val: r => (f.ok(r.price) && r.sqft ? r.price / r.sqft : null), fmt: v => f.num(v, 2) },
    { k: "beds", label: "Bd/Ba", fmt: bbCell },
    { k: "sqft", label: "Sq ft", fmt: v => f.int(v) },
    { k: "year_built", label: "Built", fmt: v => (f.ok(v) ? String(v) : f.DASH) },
    { k: "dom", label: "DOM", fmt: v => f.int(v), title: "Days on market" },
    { k: "rent_est", label: "Rent est", fmt: rentCell, title: "Modelled market rent; the dot's tooltip names the source" },
    { k: "vs", label: "Ask vs est", val: r => (f.ok(r.price) && f.ok(r.rent_est) && r.rent_est ? r.price / r.rent_est - 1 : null), fmt: v => f.spct(v), cls: v => f.cls(-v), title: "Asking rent over the estimate (negative = asking below market)" },
  ]);
  return base.concat([
    { k: "price", label: "Price", fmt: v => f.usd(v), title: "Asking price" },
    { k: "ppsf", label: "$/sf", fmt: v => f.usd(v) },
    { k: "beds", label: "Bd/Ba", fmt: bbCell },
    { k: "sqft", label: "Sq ft", fmt: v => f.int(v) },
    { k: "year_built", label: "Built", fmt: v => (f.ok(v) ? String(v) : f.DASH) },
    { k: "dom", label: "DOM", fmt: v => f.int(v), title: "Days on market" },
    { k: "rent_est", label: "Rent est", fmt: rentCell, title: "Monthly rent estimate; the dot's tooltip names the source" },
    { k: "cap", label: "Cap", fmt: v => f.pct(v, 1), title: "Year-1 NOI / asking price" },
    { k: "coc", label: "CoC", fmt: v => f.pct(v, 1), cls: v => f.cls(v), title: "Cash-on-cash: 25% down at the investor rate" },
    { k: "cf", label: "CF/mo", fmt: v => f.susd(v), cls: v => f.cls(v), title: "Cash flow per month after debt service and reserves" },
    { k: "score", label: "Score", fmt: v => scoreBar(v), title: "0–100 weighted score (weights on Screen)" },
  ]);
}

function csvCols() {
  const c = [{ k: "address" }, { k: "zip" }, { k: "type" }, { k: "units" }, { k: "price", csv: isRent() ? "rent_month" : "price" },
    { k: "beds" }, { k: "baths" }, { k: "sqft" }, { k: "year_built" }, { k: "dom" }, { k: "rent_est" }, { k: "rent_src" }];
  if (!isRent()) c.push({ k: "ppsf" }, { k: "value_est" }, { k: "cap" }, { k: "coc" }, { k: "cf", csv: "cash_flow_month" }, { k: "dscr" }, { k: "grm" }, { k: "score" });
  c.push({ k: "listed" }, { k: "l_source", csv: "source" }, { k: "lat" }, { k: "lon" });
  return c;
}

/* ---------- map ---------- */

const popup = r => `<b style="font-family:var(--sans)">${esc(f.street(r.address))}</b><br>`
  + `<span class="mut">${esc(f.city(r.address))}</span><br>`
  + `${f.usd(r.price)}${isRent() ? "/mo" : ""} · ${f.bb(r)} · ${f.sqft(r.sqft)}<br>`
  + (isRent() ? `Rent est ${f.usd(r.rent_est)}` : `Cap ${f.pct(r.cap)} · CoC <span class="${f.cls(r.coc)}">${f.pct(r.coc)}</span> · CF <span class="${f.cls(r.cf)}">${f.susd(r.cf)}</span><br>Score <b>${f.score(r.score)}</b>`);
const points = rows => rows.filter(r => f.ok(r.lat) && f.ok(r.lon)).map(r => ({ id: r.id, lat: r.lat, lon: r.lon, v: isRent() ? null : r.score, label: f.cusd(r.price), html: popup(r) }));

async function ensureMap(root, ctx) {
  if (M || mapping) return mapping;
  const el = root.querySelector("#sr-map");
  if (!el) return null;
  const gen = mapGen;
  mapBlind = pane === "street";   // created inside a hidden panel: fit the points again when the map is shown
  mapping = mapView(el, {
    points: points(view), labels: true, selected: selId(), legend: ["score 0", "100"],
    onClick: id => {
      const r = data.rows.find(x => String(x.id) === String(id));
      if (!r) return;
      select({ kind: "property", id: r.id, row: r });
      scrollTo(root);
    },
  }).then(m => { if (gen !== mapGen) { m.destroy(); return null; } M = m; mapping = null; return m; });
  return mapping;
}

/* ---------- street view ---------- */

/** get() caches per coordinate until the next write, so a Google key saved in Settings takes effect at once. */
async function svFor(r) {
  if (!hasLL(r)) return null;
  try { return await get(streetView(r.lat, r.lon)); } catch (e) { return null; }
}

/** The map panel shows either the map or Google Street View of the selected listing (live imagery, Embed API). */
async function drawPane(root) {
  const host = root.querySelector("#sr-sv"), mapEl = root.querySelector("#sr-map"), tabs = root.querySelector("#sr-pane");
  if (!host || !mapEl) return;
  if (tabs) tabs.innerHTML = chips("pane", [{ v: "map", label: "Map", title: "Listings on the map; 3D tilts it with building heights" }, { v: "street", label: "Street view", title: "Google Street View at the selected listing" }], pane);
  const street = pane === "street";
  mapEl.hidden = street;
  host.hidden = !street;
  if (!street) { host.innerHTML = ""; svShown = null; return; }
  const r = cur(), gen = ++svGen;
  const msg = (title, sub, acts = "") => { svShown = null; host.innerHTML = `<div class="sr-svm"><b>${title}</b><span>${sub}</span>${acts ? `<div class="r">${acts}</div>` : ""}</div>`; };
  if (!r) return msg("No listing selected", "Click a row in the table to look at it from the street.");
  if (!hasLL(r)) return msg(esc(f.street(r.address)), "No coordinates for this address, so Street View cannot place it. Open the property and correct the address to geocode it.");
  const sv = await svFor(r);
  if (gen !== svGen) return;
  if (sv?.embed) {
    if (svShown === sv.embed) return;
    svShown = sv.embed;
    host.innerHTML = `<iframe class="sv sr-svf" src="${esc(sv.embed)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen title="Street View of ${esc(r.address)}"></iframe>`;
    return;
  }
  const links = btn("sv", "Street View ↗", { cls: "pri", title: "Google Street View at this address, in the browser" })
    + btn("earth", "Earth 3D ↗", { title: "Google Earth photorealistic 3D at this address, in the browser" })
    + (sv?.maps ? btn("gmap", "Google Maps ↗", { cls: "ghost" }) : "");
  msg(esc(f.street(r.address)), `${esc(f.city(r.address))} · <span class="m">${(+r.lat).toFixed(5)}, ${(+r.lon).toFixed(5)}</span><br>`
    + `<span class="faint">A Google Maps key in <a class="link" data-go="settings">Settings</a> shows live Street View here (the Embed API is free). Until then it opens in the browser.</span>`, links);
}

/** The map was laid out while Street view hid it (0×0), so its first fit is wrong: fit again once it is visible. */
function refit() {
  if (!mapBlind || !M) return;
  mapBlind = false;
  requestAnimationFrame(() => { if (M) { M.setPoints(points(view), { fit: true }); M.select(selId()); } });
}

function scrollTo(root) {
  const tr = root.querySelector("#sr-tbl tbody tr.on");
  if (tr) tr.scrollIntoView({ block: "nearest" });
}

/* ---------- drawing ---------- */

function strip(rows) {
  const n = rows.length, all = data.rows.length;
  if (isRent()) {
    const vs = rows.filter(r => f.ok(r.price) && f.ok(r.rent_est) && r.rent_est).map(r => r.price / r.rent_est - 1);
    return kv([
      { k: "Rentals", v: f.int(n) },
      { k: "Median rent", v: f.usd(median(rows.map(r => r.price))) },
      { k: "Median $/sf/mo", v: f.num(median(rows.map(r => (r.sqft ? r.price / r.sqft : null))), 2) },
      { k: "Median est.", v: f.usd(median(rows.map(r => r.rent_est))) },
      { k: "Ask vs est.", v: f.spct(median(vs)), sub: "median", cls: f.cls(-median(vs)) },
      { k: "Below estimate", v: vs.length ? f.int(vs.filter(x => x < 0).length) : null, sub: vs.length ? `of ${f.int(vs.length)}` : "" },
    ], { cls: "tight" });
  }
  const pos = rows.filter(r => f.ok(r.cf));
  return kv([
    { k: "Listings", v: f.int(n), sub: n !== all ? `of ${f.int(all)}` : "" },
    { k: "Median ask", v: f.usd(median(rows.map(r => r.price))) },
    { k: "Median $/sf", v: f.usd(median(rows.map(r => r.ppsf))) },
    { k: "Median cap", v: f.pct(median(rows.map(r => r.cap))) },
    { k: "Median CoC", v: f.pct(median(rows.map(r => r.coc))), cls: f.cls(median(rows.map(r => r.coc))) },
    { k: "CF ≥ 0", v: pos.length ? f.int(pos.filter(r => r.cf >= 0).length) : null, sub: pos.length ? `of ${f.int(pos.length)}` : "" },
    { k: "Med. score", v: f.score(median(rows.map(r => r.score))) },
  ], { cls: "tight" });
}

function selbar() {
  const r = cur();
  if (!r) return `<div class="sr-selbar none">Click a row or a point to select a listing · double-click a row (or Enter) to open the property · 3D tilts the map</div>`;
  const hasLL = f.ok(r.lat) && f.ok(r.lon), inPipe = deals.get(r.id);
  return `<div class="sr-selbar"><span class="a" title="${esc(r.address)}">${esc(f.street(r.address))}</span>`
    + `<span class="f"><b>${f.usd(r.price)}${isRent() ? "/mo" : ""}</b>`
    + (isRent() ? `<b><span>est</span>${f.usd(r.rent_est)}</b>` : `<b><span>cap</span>${f.pct(r.cap)}</b><b class="${f.cls(r.cf)}"><span>cf</span>${f.susd(r.cf)}</b><b><span>score</span>${f.score(r.score)}</b>`)
    + `</span><span class="r">`
    + btn("open", "Open", { title: "Open the Property page (Enter)" })
    + (isRent() ? "" : btn("uw", "Underwrite"))
    + btn("sv", "Street View ↗", { dis: !hasLL, title: hasLL ? "Open Google Street View at this address in your browser" : "No coordinates for this property" })
    + btn("3d", "3D", { dis: !hasLL || !M || M.off, title: "Fly to the property and tilt the map with buildings in 3D" })
    + btn("pipe", inPipe ? (/reject/i.test(inPipe) ? "Rejected" : "In pipeline") : "+ Pipeline", { cls: inPipe ? "ghost" : "pri", title: inPipe ? `Stage: ${esc(inPipe)} · open the Pipeline` : "Add to the acquisition pipeline as Discovered" })
    + `</span></div>`;
}

function drawTable(root) {
  const id = selId();
  tbl = table(root.querySelector("#sr-tbl"), {
    id: "search-" + F.kind, rows: view, cols: cols(), key: r => r.id, sel: id, cls: "sr-t",
    sort: isRent() ? { k: "dom", dir: 1 } : { k: "score", dir: -1 }, limit: 300,
    empty: data.rows.length ? "No listings pass the filters. Loosen the price, beds or score filters, or press Clear."
      : S.state?.rentcast?.has_key ? "Nothing stored for this search. Pull live listings for a ZIP or city, Import listings (Redfin CSV, alert email) or Paste addresses."
        : "Nothing stored yet. Import listings (Redfin CSV, alert email), Paste addresses, or add a RentCast key in Settings to pull them.",
    onRow: r => { select({ kind: "property", id: r.id, row: r }); },
    onDbl: r => go("property", r.id),
  });
}

function drawHead(root) {
  const demo = data.rows.some(r => r.l_source === "DEMO" || r.source === "DEMO");
  const nll = view.filter(r => !(f.ok(r.lat) && f.ok(r.lon))).length;
  const sr = cur(), h3 = root.querySelector(".sr-mapp .ph h3");
  if (h3) h3.textContent = pane === "street" ? "Street view" : "Map";
  root.querySelector("#sr-map-sub").innerHTML = pane === "street"
    ? (hasLL(sr) ? `Google · ${esc(f.street(sr.address))}` : "Google · the selected listing")
    : (isRent() ? "rentals · blue = no score" : "coloured by score")
    + (nll ? ` · ${f.int(nll)} without coordinates` : "") + (demo ? ` · <span class="tag amb">Demo data</span>` : "");
  root.querySelector("#sr-tbl-sub").innerHTML = esc(describe())
    + (isRent() ? "" : (r => ` · <span title="Quick underwriting at the asking price: 25% down, 30-year loan at ${esc(r.v)} (${esc(r.src)}); taxes from the latest bill or 1.2% of price; insurance 0.5% (min $900)">returns at asking · 25% down · ${esc(r.v)}</span>`)(rateLine())) + (demo ? ` · <span class="tag amb">Demo data</span>` : "");
  const notes = [...pulled, ...(data.notes || [])];
  const nb = root.querySelector("#sr-notes");
  nb.hidden = !notes.length;
  nb.innerHTML = notes.map(n => `<div class="strip">${esc(n)}</div>`).join("");
}

async function refresh(root, ctx, refetch) {
  if (refetch) {
    try { data = await get(path()); } catch (e) { data = { rows: [], notes: [String(e.message || e)], weights: {} }; }
    data.rows = data.rows || [];
    try {
      const pl = await get("/api/pipeline");
      const lab = Object.fromEntries((pl.stages || []).map(s => [s.id, s.label]));
      deals = new Map((pl.deals || []).map(d => [d.property_id, lab[d.stage] || d.stage]));
    } catch (e) { deals = new Map(); }
    drawFilters(root, saved);
    if (ctx) drawSub(ctx);
  }
  view = filtered(data.rows);
  root.querySelector("#sr-kv").innerHTML = strip(view);
  drawHead(root);
  drawTable(root);
  root.querySelector("#sr-sel").innerHTML = selbar();
  drawPane(root);
  await ensureMap(root, ctx);
  if (M) { M.setPoints(points(view), { fit: fitNext }); M.select(selId()); fitNext = false; }
  root.querySelector("#sr-sel").innerHTML = selbar();
}

export default {
  id: "search",
  deps: ["sel"],
  async render(root, ctx) {
    if (!root.querySelector("#sr-tbl")) {
      root.classList.add("fill");
      root.innerHTML = `<section class="pnl" id="sr-kv"></section><section class="pnl" id="sr-f"></section><div id="sr-notes" class="sr-notes" hidden></div>
        <div class="sr-body">
          ${panel({ title: "Map", sub: `<span id="sr-map-sub"></span>`, right: `<span id="sr-pane" class="sr-pane"></span>`, cls: "sr-mapp", flush: true, body: `<div id="sr-map" class="sr-map"></div><div id="sr-sv" class="sr-street" hidden></div><div id="sr-sel"></div>` })}
          ${panel({ title: "Listings", sub: `<span id="sr-tbl-sub"></span>`, right: btn("csv", "CSV", { cls: "ghost", title: "Export the rows shown, in this order" }), cls: "sr-tblp", flush: true, body: `<div id="sr-tbl"></div>` })}
        </div>`;
      fitNext = true;
    }
    wire(root, ctx);
    if (ctx.reason === "sel" && root.querySelector("#sr-tbl").__tbl) {
      const id = selId();
      tbl?.setSel(id);
      M?.select(id);
      root.querySelector("#sr-sel").innerHTML = selbar();
      drawHead(root);
      drawPane(root);
      if (id != null) scrollTo(root);
      return;
    }
    try { const r = await get("/api/searches"); saved = Array.isArray(r) ? r : []; } catch (e) { saved = []; }
    if (savedId != null && !saved.some(s => s.id === savedId)) savedId = null;
    drawSub(ctx);
    drawBar(ctx);
    await refresh(root, null, true);
  },
  leave() {
    mapGen++;
    if (M) M.destroy();
    M = null; mapping = null; svShown = null; svGen++;
  },
  key(e) {
    if (e.key === "Enter" && selId() != null) { go("property", selId()); return true; }
    return false;
  },
};
