// Screen — the sale listings ranked by score: factor contributions as heat-shaded columns, a weight editor with
// presets (POST /api/weights, which also ranks Search and the Property page), threshold filters, cap rate vs price.
import { S, f, get, post, go, select, esc, load, save } from "../core.js";
import { table, panel, kv, chips, field, selectBox, btn, sep, bind, toast, csv, heat, parseNum, debounce, useCss } from "../ui.js";
import * as C from "../charts.js";
import { scoreColor } from "../map.js";

useCss("screen");

const FACTORS = [
  { k: "cashflow", label: "Cash flow", ab: "CF", scale: "CoC −5% → 12%", raw: r => `CoC ${f.pct(r.coc)}` },
  { k: "cap", label: "Cap rate", ab: "Cap", scale: "cap 3% → 10%", raw: r => `cap ${f.pct(r.cap)}` },
  { k: "discount", label: "Discount", ab: "Disc", scale: "AVM/ask −10% → +15%", raw: r => `value vs ask ${f.spct(r.discount)}` },
  { k: "momentum", label: "Momentum", ab: "Mom", scale: "ZIP 1y −4% → 8%", raw: r => `ZIP value+rent 1y ${f.spct(r.momentum)}` },
  { k: "negotiable", label: "Negotiable", ab: "Neg", scale: "DOM 0 → 120 d", raw: r => `${f.int(r.dom)} days on market` },
  { k: "risk", label: "Data quality", ab: "Risk", scale: "confidence 0 → 100", raw: () => "data confidence (AVM present, rent range, age)" },
];
const PRESETS = [
  { v: "default", label: "Default", w: { cashflow: 25, cap: 20, discount: 20, momentum: 15, negotiable: 10, risk: 10 } },
  { v: "cashflow", label: "Cash flow", w: { cashflow: 40, cap: 25, discount: 10, momentum: 5, negotiable: 10, risk: 10 } },
  { v: "valueadd", label: "Value add", w: { cashflow: 10, cap: 10, discount: 35, momentum: 10, negotiable: 25, risk: 10 } },
  { v: "appreciation", label: "Appreciation", w: { cashflow: 10, cap: 5, discount: 15, momentum: 45, negotiable: 10, risk: 15 } },
];
const TYPES = ["Single Family", "Multi-Family", "Townhouse", "Condo", "Manufactured", "Apartment"];
const DEFF = { min_coc: "", min_cap: "", max_price: "", min_dscr: "", type: "" };

let FS = { ...DEFF, ...load("screen.f", {}) };
let W = null, saved = null, dirty = false, mode = load("screen.mode", "pts");
let rows = [], ranked = [], tbl = null, chart = null, showTop = load("screen.top", true);

const selId = () => (S.sel?.kind === "property" ? +S.sel.id : null);
const median = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const num = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
const same = (a, b) => FACTORS.every(x => num(a?.[x.k]) === num(b?.[x.k]));
const presetOf = w => PRESETS.find(p => same(p.w, w))?.v || "";
const wsum = () => FACTORS.reduce((s, x) => s + num(W[x.k]), 0);

/** Same formula as the engine (valora/props.py quick): weighted mean over the factors that have data. */
function rescore(r) {
  const p = r.score_parts || {};
  let tw = 0, acc = 0;
  for (const x of FACTORS) if (f.ok(p[x.k])) { tw += num(W[x.k]); acc += p[x.k] * num(W[x.k]); }
  const pts = {};
  for (const x of FACTORS) pts[x.k] = f.ok(p[x.k]) && tw ? (p[x.k] * num(W[x.k])) / tw : null;
  return { ...r, s: tw ? acc / tw : null, pts, tw };
}

function pass(r) {
  const coc = parseNum(FS.min_coc), cap = parseNum(FS.min_cap), mp = parseNum(FS.max_price), ds = parseNum(FS.min_dscr);
  if (coc != null && !(f.ok(r.coc) && r.coc >= coc / 100)) return false;
  if (cap != null && !(f.ok(r.cap) && r.cap >= cap / 100)) return false;
  if (mp != null && !(f.ok(r.price) && r.price <= mp)) return false;
  if (ds != null && !(f.ok(r.dscr) && r.dscr >= ds)) return false;
  if (FS.type && r.type !== FS.type) return false;
  return true;
}

function rank() {
  ranked = rows.filter(pass).map(rescore).sort((a, b) => (f.ok(b.s) ? b.s : -1) - (f.ok(a.s) ? a.s : -1));
  let i = 0;
  for (const r of ranked) r.rank = f.ok(r.s) ? ++i : null;
}

/* ---------- pieces ---------- */

function strip() {
  const sc = ranked.map(r => r.s).filter(f.ok), cf = ranked.filter(r => f.ok(r.cf));
  const pv = presetOf(W);
  return kv([
    { k: "Candidates", v: f.int(ranked.length), sub: ranked.length !== rows.length ? `of ${f.int(rows.length)}` : "" },
    { k: "Top score", v: f.score(sc.length ? Math.max(...sc) : null) },
    { k: "Median score", v: f.score(median(sc)) },
    { k: "Median CoC", v: f.pct(median(ranked.map(r => r.coc))), cls: f.cls(median(ranked.map(r => r.coc))) },
    { k: "Median cap", v: f.pct(median(ranked.map(r => r.cap))) },
    { k: "CF ≥ 0", v: cf.length ? f.int(cf.filter(r => r.cf >= 0).length) : null, sub: cf.length ? `of ${f.int(cf.length)}` : "" },
    { k: "Weights", v: esc(PRESETS.find(p => p.v === pv)?.label || "Custom"), sub: dirty ? `<span class="amb">unsaved</span>` : "" },
  ], { cls: "tight" });
}

function filters() {
  return `<div class="sc-fl">`
    + field("min_coc", FS.min_coc, { label: "Min CoC", suf: "%", w: 36, title: "Cash-on-cash at asking, 25% down" })
    + field("min_cap", FS.min_cap, { label: "Min cap", suf: "%", w: 36, title: "Year-1 NOI / asking price" })
    + field("max_price", FS.max_price, { label: "Max price", pre: "$", w: 62, title: "250k, 1.2m" })
    + field("min_dscr", FS.min_dscr, { label: "Min DSCR", suf: "×", w: 36, title: "NOI / annual debt service" }) + sep()
    + selectBox("type", [{ v: "", label: "All types" }, ...TYPES], FS.type)
    + `<span class="r">${JSON.stringify(FS) !== JSON.stringify(DEFF) ? btn("clear", "Clear filters", { cls: "ghost" }) : ""}</span></div>`;
}

function weightsBody() {
  const tw = wsum();
  return `<div class="sc-w"><span class="h">Factor</span><span class="h">Weight</span><span class="h n">Wt</span><span class="h n">Share</span>`
    + FACTORS.map(x => `<label title="${esc(x.label)}: ${esc(x.scale)} maps to 0–100">${esc(x.label)}<small>${esc(x.scale)}</small></label>`
      + `<input type="range" min="0" max="50" step="1" value="${num(W[x.k])}" data-input="w:${x.k}">`
      + `<input type="text" value="${num(W[x.k])}" data-input="n:${x.k}" inputmode="decimal" autocomplete="off" spellcheck="false">`
      + `<span class="sh" data-sh="${x.k}">${tw ? f.pct(num(W[x.k]) / tw, 0) : f.DASH}</span>`).join("")
    + `</div><div class="sc-wf"><span>${dirty ? `<span class="amb">Unsaved.</span> Ranking shown with these weights.` : "Saved weights also rank Search."}</span>`
    + `<span class="r">${btn("revert", "Revert", { cls: "ghost", dis: !dirty })}${btn("save-w", "Save weights", { cls: dirty ? "pri" : "", dis: !dirty, title: "POST /api/weights" })}</span></div>`;
}

function updateShares(root) {
  const tw = wsum();
  for (const x of FACTORS) {
    const el = root.querySelector(`[data-sh="${x.k}"]`);
    if (el) el.textContent = tw ? f.pct(num(W[x.k]) / tw, 0) : f.DASH;
  }
}

const tipRow = (k, v, cls = "") => `<div class="ch-tr"><i></i><span>${esc(k)}</span><b${cls ? ` class="${cls}"` : ""}>${v}</b></div>`;

function drawScatter(root) {
  const id = selId();
  const pts = ranked.filter(r => f.ok(r.cap) && f.ok(r.price)).map(r => ({
    x: r.price, y: r.cap, id: r.id, row: r, label: f.street(r.address),
    color: scoreColor(r.s), r: r.id === id ? 6 : 3.4,
  }));
  if (id != null) { const i = pts.findIndex(p => p.id === id); if (i >= 0) pts.push(pts.splice(i, 1)[0]); }
  chart = C.scatter(root.querySelector("#sc-sc"), {
    h: 196, pts, labels: false,
    x: { label: "Asking price", fmt: v => f.cusd(v) }, y: { label: "Cap rate", fmt: v => f.pct(v, 1) },
    empty: rows.length ? "No listing passes the filters" : "No sale listings stored",
    hover: p => `<div class="ch-th">${esc(f.street(p.row.address))} · ${esc(p.row.zip || "")}</div>`
      + tipRow("Price", f.usd(p.row.price)) + tipRow("Cap", f.pct(p.row.cap)) + tipRow("CoC", f.pct(p.row.coc), f.cls(p.row.coc))
      + tipRow("CF/mo", f.susd(p.row.cf), f.cls(p.row.cf)) + tipRow("Score", f.score(p.row.s)),
    onClick: p => select({ kind: "property", id: p.id, row: p.row }),
  });
}

function factorCol(x) {
  const tw = wsum();
  return {
    k: x.k, label: `${x.ab}<small class="faint" style="margin-left:3px">${num(W[x.k])}</small>`, cls: "fx",
    title: `${x.label} (${x.scale}) · weight ${num(W[x.k])}${mode === "pts" ? " · points this factor adds to the score" : " · factor score 0–100"}`,
    val: r => (mode === "pts" ? r.pts[x.k] : r.score_parts?.[x.k]),
    fmt: (v, r) => (f.ok(v) ? `<span title="${esc(x.raw(r))} → ${f.int(r.score_parts?.[x.k])}/100 × weight ${num(W[x.k])}">${mode === "pts" ? f.num(v, 1) : f.int(v)}</span>` : f.DASH),
    heat: v => (mode === "pts" ? heat(v, 0, tw ? (num(W[x.k]) / tw) * 100 : 1, { color: "--gold", max: 40 }) : heat(v, 0, 100, { color: "--gold", max: 40 })),
  };
}

function cols() {
  return [
    { k: "rank", label: "#", w: 26, fmt: v => `<span class="sc-rk">${v ?? f.DASH}</span>`, title: "Rank by score with the weights shown" },
    { k: "address", label: "Address", l: true, fmt: (v, r) => `<span class="sc-addr" title="${esc(r.address)}">${esc(f.street(r.address))}</span><span class="sc-zip">${esc(r.zip || "")}</span>` },
    { k: "price", label: "Price", fmt: v => f.usd(v) },
    { k: "s", label: "Score", fmt: v => (f.ok(v) ? `<b>${f.score(v)}</b>` : f.DASH), heat: v => heat(v, 20, 85, { max: 22 }), title: "Weighted mean of the six factor scores (factors without data are left out)" },
    ...FACTORS.map(factorCol),
    { k: "coc", label: "CoC", fmt: (v, r) => (f.ok(v) ? `<span title="Rent ${esc(f.usd(r.rent_est))}/mo · ${esc(r.rent_src || "no rent estimate")}">${f.pct(v)}</span>` : f.DASH), cls: v => f.cls(v), title: "Cash-on-cash at asking, 25% down; hover a cell for the rent estimate and its source" },
    { k: "cap", label: "Cap", fmt: v => f.pct(v), title: "Year-1 NOI / asking price" },
    { k: "cf", label: "CF/mo", fmt: v => f.susd(v), cls: v => f.cls(v), title: "Monthly cash flow after debt service and capex reserve" },
    { k: "dscr", label: "DSCR", fmt: v => f.x(v), cls: v => (f.ok(v) ? (v >= 1.25 ? "up" : v < 1 ? "down" : "") : ""), title: "NOI / annual P&I" },
  ];
}

function drawTable(root) {
  tbl = table(root.querySelector("#sc-tbl"), {
    id: "screen-rank", rows: ranked, cols: cols(), key: r => r.id, sel: selId(), cls: "sc-t",
    sort: { k: "rank", dir: 1 }, limit: 300,
    head: `<tr class="sc-grp"><th colspan="4"></th><th colspan="6" class="c g">${mode === "pts" ? "Contribution to score, points" : "Factor scores, 0–100"} · weight in grey</th><th colspan="4" class="c g">At asking · 25% down</th></tr>`,
    rowCls: r => (f.ok(r.s) ? "" : "dim"),
    empty: rows.length ? "No listing passes the filters. Lower Min CoC, Min cap or Min DSCR, raise Max price, or press Clear filters."
      : "No sale listings yet. On Search: Import listings, Paste addresses, Pull live listings (RentCast key) or Add property.",
    onRow: r => select({ kind: "property", id: r.id, row: r }),
    onDbl: r => go("property", r.id),
  });
}

function redraw(root) {
  rank();
  root.querySelector("#sc-kv").innerHTML = strip();
  drawTable(root);
  drawScatter(root);
  root.querySelector("#sc-cnt").textContent = `${f.int(ranked.filter(r => f.ok(r.cap) && f.ok(r.price)).length)} plotted · colour = score`;
}
const redrawSoon = debounce(root => redraw(root), 60);

function drawWeights(root, ctx) {
  root.querySelector("#sc-wb").innerHTML = weightsBody();
  ctx.sub.innerHTML = `<span data-sc-sub hidden></span>` + chips("preset", PRESETS.map(p => ({ v: p.v, label: p.label })), presetOf(W), { label: "Weights" });
}

function applyTop(root) {
  root.querySelector(".sc-top").hidden = !showTop;
  root.querySelector("#sc-tog").innerHTML = btn("tog", showTop ? "Hide weights & chart" : "Show weights & chart", { cls: "ghost", title: "More room for the ranked table" });
  if (showTop) drawScatter(root);
}

async function saveWeights(w) {
  const r = await post("/api/weights", w);
  if (r.error) { toast(r.error, "bad"); return false; }
  dirty = false; saved = { ...w };
  return true;
}

export default {
  id: "screen",
  deps: ["sel"],
  async render(root, ctx) {
    if (!root.querySelector("#sc-tbl")) {
      root.classList.add("fill");
      root.innerHTML = `<section class="pnl" id="sc-kv"></section><section class="pnl" id="sc-f"></section>
        <div class="sc-top">
          ${panel({ title: "Weights", sub: "score = Σ factor × weight ÷ Σ weight", flush: true, body: `<div id="sc-wb"></div>` })}
          ${panel({ title: "Cap rate vs price", sub: `<span id="sc-cnt"></span>`, flush: true, body: `<div id="sc-sc" class="sc-sc"></div>` })}
        </div>
        ${panel({ title: "Ranked", sub: `<span id="sc-tsub"></span>`, right: `<span id="sc-mode"></span><span id="sc-tog"></span>`, cls: "sc-tblp", flush: true, body: `<div id="sc-tbl"></div>` })}`;
    }
    const map = {
      "chip:preset": async v => {
        const p = PRESETS.find(x => x.v === v);
        if (!p) return;
        W = { ...p.w };
        if (await saveWeights(W)) toast(`Weights set to ${p.label}`);
      },
      "act:tog": () => { showTop = !showTop; save("screen.top", showTop); applyTop(root); },
      "chip:mode": v => { mode = v; save("screen.mode", v); root.querySelector("#sc-mode").innerHTML = modeChips(); redraw(root); },
      "act:save-w": async () => { if (await saveWeights({ ...W })) toast("Weights saved"); },
      "act:revert": () => { W = { ...saved }; dirty = false; drawWeights(root, ctx); redraw(root); },
      "act:clear": () => { FS = { ...DEFF }; save("screen.f", FS); root.querySelector("#sc-f").innerHTML = filters(); redraw(root); },
      "act:csv": () => csv("valora-screen.csv", [
        { k: "rank" }, { k: "address" }, { k: "zip" }, { k: "type" }, { k: "price" }, { k: "s", csv: "score" },
        ...FACTORS.map(x => ({ k: x.k, csv: x.k + "_score", val: r => r.score_parts?.[x.k] })),
        ...FACTORS.map(x => ({ k: x.k + "_pts", val: r => r.pts[x.k] })),
        { k: "coc" }, { k: "cap" }, { k: "cf", csv: "cash_flow_month" }, { k: "dscr" }, { k: "discount" }, { k: "momentum" }, { k: "dom" }, { k: "rent_est" }, { k: "rent_src" },
      ], tbl?.view() || ranked),
      "change:type": v => { FS.type = v; save("screen.f", FS); root.querySelector("#sc-f").innerHTML = filters(); redraw(root); },
    };
    for (const k of ["min_coc", "min_cap", "max_price", "min_dscr"]) {
      map["change:" + k] = v => { const n = parseNum(v); FS[k] = n == null ? "" : String(n); save("screen.f", FS); root.querySelector("#sc-f").innerHTML = filters(); redraw(root); };
    }
    for (const x of FACTORS) {
      const set = (v, el, final) => {
        const n = Math.max(0, Math.min(100, parseNum(v) ?? 0));
        W[x.k] = n; dirty = !same(W, saved);
        const sl = root.querySelector(`[data-input="w:${x.k}"]`), nb = root.querySelector(`[data-input="n:${x.k}"]`);
        if (sl && sl !== el) sl.value = n;
        if (nb && nb !== el) nb.value = n;
        updateShares(root);
        if (final) drawWeights(root, ctx);
        redrawSoon(root);
      };
      map[`input:w:${x.k}`] = (v, el) => set(v, el, false);
      map[`change:w:${x.k}`] = (v, el) => set(v, el, true);
      map[`change:n:${x.k}`] = (v, el) => set(v, el, true);
    }
    bind(root, map);
    bind(ctx.sub, map);
    bind(ctx.bar, map);
    const modeChips = () => chips("mode", [{ v: "pts", label: "Points" }, { v: "raw", label: "0–100" }], mode);

    if (ctx.reason === "sel" && root.querySelector("#sc-tbl").__tbl) {
      tbl?.setSel(selId());
      drawScatter(root);
      return;
    }

    let data;
    try { data = await get("/api/listings?kind=sale"); } catch (e) { data = { rows: [], weights: null, notes: [String(e.message || e)] }; }
    rows = data.rows || [];
    const sw = { ...PRESETS[0].w, ...(data.weights || {}) };
    if (!saved || !dirty) { saved = { ...sw }; W = { ...sw }; dirty = false; } else saved = { ...sw };

    ctx.bar.innerHTML = btn("csv", "CSV", { title: "Export the ranked rows, in this order" });
    root.querySelector("#sc-f").innerHTML = filters();
    root.querySelector("#sc-mode").innerHTML = modeChips();
    applyTop(root);
    const demo = rows.some(r => r.l_source === "DEMO" || r.source === "DEMO");
    root.querySelector("#sc-tsub").innerHTML = `sale listings · factor inputs from the listing, ZIP indexes and estimates`
      + (demo ? ` · <span class="tag amb">Demo data</span>` : "");
    drawWeights(root, ctx);
    redraw(root);
  },
  key(e) {
    if (e.key === "Enter" && selId() != null) { go("property", selId()); return true; }
    return false;
  },
};
