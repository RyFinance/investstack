// ui.js — the building blocks every page uses, so the whole app reads as one tool:
// sortable tables, chips, fields, key-value strips, panels, heat shading, CSV, toasts.
// Functions that return markup return HTML strings; `table` and `bind` take elements.
import { f, esc, load, save, inApp } from "./core.js";

export { esc };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Load web/css/<id>.css once. Call at the top of a page module that has its own stylesheet. */
export function useCss(id) {
  const href = `css/${id}.css`;
  if (document.querySelector(`link[data-css="${id}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = href; l.dataset.css = id;
  document.head.append(l);
}

/* ---------- events: one delegated listener per root, handlers replaced on every call ---------- */

/** Wire the interactive elements inside `root`. Call it again any time (after re-rendering); it never stacks listeners.
 *  map keys:  "chip:<name>"  (value, el, event)   a click on  <button data-chip="name" data-v="value">
 *             "act:<name>"   (el, event)          a click on  <… data-act="name">
 *             "input:<name>" (value, el, event)   typing in   <input data-input="name">
 *             "change:<name>" / "enter:<name>"    committed value / Enter pressed in that input */
export function bind(root, map) {
  if (!root.__bound) {
    root.__bound = true;
    root.addEventListener("click", e => {
      const m = root.__map || {};
      const chip = e.target.closest("[data-chip]");
      if (chip && root.contains(chip)) {
        const fn = m["chip:" + chip.dataset.chip];
        if (fn && !chip.disabled) { fn(chip.dataset.v, chip, e); return; }
      }
      const act = e.target.closest("[data-act]");
      if (act && root.contains(act)) {
        const fn = m["act:" + act.dataset.act];
        if (fn && !act.disabled) fn(act, e);
      }
    });
    for (const evt of ["input", "change"]) {
      root.addEventListener(evt, e => {
        const el = e.target.closest?.("[data-input]");
        if (el) root.__map?.[`${evt}:${el.dataset.input}`]?.(el.value, el, e);
      });
    }
    root.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      const el = e.target.closest?.("[data-input]");
      if (!el) return;
      root.__map?.["enter:" + el.dataset.input]?.(el.value, el, e);
      if (el.tagName === "INPUT") el.blur();
    });
  }
  root.__map = map || {};
}

/* ---------- small pieces of markup ---------- */

/** A row of choice chips. items: values or { v, label, sub, title, dis, cls }. value: the chosen one (or an array). */
export function chips(name, items, value, o = {}) {
  const isOn = v => (Array.isArray(value) ? value.map(String).includes(String(v)) : String(value) === String(v));
  return (o.label ? `<span class="lbl">${esc(o.label)}</span>` : "") + items.map(it => {
    const c = it != null && typeof it === "object" ? it : { v: it };
    return `<button class="chip${isOn(c.v) ? " on" : ""}${c.cls ? " " + c.cls : ""}" data-chip="${esc(name)}" data-v="${esc(c.v)}"`
      + `${c.title ? ` title="${esc(c.title)}"` : ""}${c.dis ? " disabled" : ""}>${esc(c.label ?? c.v)}`
      + `${c.sub != null && c.sub !== "" ? `<small>${esc(c.sub)}</small>` : ""}</button>`;
  }).join("");
}
export const sep = () => `<span class="sep"></span>`;
export const lbl = t => `<span class="lbl">${esc(t)}</span>`;

/** A compact text field. o: { label, pre: "$", suf: "%", w: px, title } */
export function field(name, value, o = {}) {
  return `${o.label ? lbl(o.label) : ""}<label class="fld"${o.title ? ` title="${esc(o.title)}"` : ""}>`
    + `${o.pre ? `<span>${esc(o.pre)}</span>` : ""}<input data-input="${esc(name)}" value="${esc(value ?? "")}" inputmode="decimal" `
    + `autocomplete="off" spellcheck="false" style="width:${o.w || 64}px">${o.suf ? `<span>${esc(o.suf)}</span>` : ""}</label>`;
}

/** A dropdown. items: values or { v, label }. */
export function selectBox(name, items, value, o = {}) {
  return `${o.label ? lbl(o.label) : ""}<select class="sel" data-input="${esc(name)}"${o.title ? ` title="${esc(o.title)}"` : ""}>`
    + items.map(it => {
      const c = it != null && typeof it === "object" ? it : { v: it };
      return `<option value="${esc(c.v)}"${String(c.v) === String(value) ? " selected" : ""}>${esc(c.label ?? c.v)}</option>`;
    }).join("") + `</select>`;
}

/** A small button. o: { title, cls: "pri" | "warn" | "ghost", dis, attrs } */
export function btn(act, label, o = {}) {
  return `<button class="btn${o.cls ? " " + o.cls : ""}" data-act="${esc(act)}"${o.title ? ` title="${esc(o.title)}"` : ""}`
    + `${o.dis ? " disabled" : ""}${o.attrs ? " " + o.attrs : ""}>${esc(label)}</button>`;
}

/** A strip of labelled figures. items: { k: label, v: html, sub: html, cls, title } (falsy items are skipped). */
export function kv(items, o = {}) {
  return `<div class="kv${o.cls ? " " + o.cls : ""}">` + items.filter(Boolean).map(it =>
    `<div${it.title ? ` title="${esc(it.title)}"` : ""}><span>${esc(it.k)}</span><b class="${it.cls || ""}">${it.v ?? f.DASH}</b>`
    + `${it.sub != null && it.sub !== "" ? `<i>${it.sub}</i>` : ""}</div>`).join("") + `</div>`;
}

/** A titled panel. o: { title, sub (html), right (html), body (html), cls, id, flush (no body padding), attrs } */
export function panel(o) {
  return `<section class="pnl${o.cls ? " " + o.cls : ""}"${o.id ? ` id="${esc(o.id)}"` : ""}${o.attrs ? " " + o.attrs : ""}>`
    + (o.title != null ? `<div class="ph"><h3>${esc(o.title)}</h3>${o.sub ? `<span class="s">${o.sub}</span>` : ""}`
      + `${o.right ? `<div class="r">${o.right}</div>` : ""}</div>` : "")
    + (o.flush ? (o.body ?? "") : `<div class="pb">${o.body ?? ""}</div>`) + `</section>`;
}

export const empty = (title, sub) => `<div class="empty"><b>${esc(title)}</b>${sub ? `<span>${sub}</span>` : ""}</div>`;
export const loading = (what = "Loading") => `<div class="empty"><span class="spin"></span><span>${esc(what)}…</span></div>`;

/** A property address that opens the property when clicked (the shell handles the click).
 *  propLink({ id, address })  or  propLink(row, "underwrite").  Shows the street; the title has the full address. */
export const propLink = (p, page = "property") => `<a class="sym" data-prop="${esc(p.property_id ?? p.id)}" data-go="${esc(page)}" title="${esc(p.address)}">${esc(f.street(p.address))}</a>`;

/** A 0–100 score with a small bar: scoreBar(72) */
export const scoreBar = v => (f.ok(v) ? `<span class="sc"><i><b style="width:${Math.max(0, Math.min(100, v))}%"></b></i>${Math.round(v)}</span>` : f.DASH);

/** Where a number came from. kind: "v" verified record, "e" estimate, "m" entered by you, "x" assumed/missing */
export const src = (text, kind = "e") => `<span class="prov" title="${esc(text)}"><i class="src-dot ${kind}"></i>${esc(text)}</span>`;

/** A status pill: pill("Active", "up") — cls: "up" | "down" | "amb" | "" */
export const pill = (text, cls = "") => `<span class="pill ${cls}">${esc(text)}</span>`;

/* ---------- heat shading ---------- */

/** Background style for a table cell.
 *  Sequential:  heat(v, lo, hi)                       → more accent colour the closer v is to hi
 *  Diverging:   heat(v, lo, hi, { mid: 1 })           → green above mid, red below (swap with { flip: true })
 *  o: { mid, flip, max (strongest tint in %, default 34), color: "--amber" (sequential colour token) } */
export function heat(v, lo, hi, o = {}) {
  if (!f.ok(v)) return "";
  const max = o.max ?? 34;
  if (o.mid != null) {
    const up = v >= o.mid, span = (up ? hi - o.mid : o.mid - lo) || 1;
    const t = clamp(Math.abs(v - o.mid) / span, 0, 1);
    const tok = up !== !!o.flip ? "--up" : "--down";
    return t < 0.04 ? "" : `background:color-mix(in srgb, var(${tok}) ${Math.round(t * max)}%, transparent)`;
  }
  const t = clamp((v - lo) / ((hi - lo) || 1), 0, 1);
  return t < 0.04 ? "" : `background:color-mix(in srgb, var(${o.color || "--acc"}) ${Math.round(t * max)}%, transparent)`;
}

/* ---------- table ---------- */

const sorts = load("sorts", {});
const al = c => (c.l ? "l" : c.c ? "c" : "");

function cmp(a, b, dir) {
  const an = a == null || (typeof a === "number" && !Number.isFinite(a)), bn = b == null || (typeof b === "number" && !Number.isFinite(b));
  if (an || bn) return an === bn ? 0 : an ? 1 : -1;                  // empty values always last
  if (typeof a === "string" || typeof b === "string") return String(a).localeCompare(String(b)) * dir;
  return (a - b) * dir;
}

function drawTable(el, st) {
  const cfg = st.cfg, cols = cfg.cols.filter(c => c && !c.hide);
  const wrap = el.firstElementChild, tbl = wrap.firstElementChild, foot = el.lastElementChild;
  wrap.style.maxHeight = cfg.maxH ? (typeof cfg.maxH === "number" ? cfg.maxH + "px" : cfg.maxH) : "";
  let rows = cfg.rows || [];
  const s = st.sort, sc = s && cols.find(c => c.k === s.k);
  if (sc && sc.sort !== false) {
    const val = sc.val || (r => r[sc.k]);
    rows = rows.slice().sort((a, b) => cmp(val(a), val(b), s.dir));
  }
  st.view = rows;
  st.cols = cols;
  const key = cfg.key || (r => r.key);
  tbl.tHead.innerHTML = (cfg.head || "") + "<tr>" + cols.map(c => {
    const on = sc === c;
    return `<th class="${al(c)}${on ? " sorted" : ""}${c.sort === false ? " nosort" : ""}" data-k="${esc(c.k)}"`
      + `${c.title ? ` title="${esc(c.title)}"` : ""}${c.w ? ` style="width:${c.w}px"` : ""}>${c.label ?? ""}${on ? (s.dir < 0 ? " ▾" : " ▴") : ""}</th>`;
  }).join("") + "</tr>";
  const n = Math.min(rows.length, st.shown), out = [];
  for (let i = 0; i < n; i++) {
    const r = rows[i], k = key(r);
    const rc = cfg.rowCls ? cfg.rowCls(r) || "" : "";
    out.push(`<tr data-i="${i}" class="${k != null && k === cfg.sel ? "on " : ""}${rc}">`);
    for (const c of cols) {
      const v = c.val ? c.val(r) : r[c.k];
      const txt = c.fmt ? c.fmt(v, r, i) : v == null ? f.DASH : esc(v);
      const cl = c.cls ? (typeof c.cls === "function" ? c.cls(v, r) || "" : c.cls) : "";
      const stl = c.heat ? c.heat(v, r) || "" : "";
      out.push(`<td class="${al(c)}${cl ? " " + cl : ""}"${stl ? ` style="${stl}"` : ""}>${txt ?? f.DASH}</td>`);
    }
    out.push("</tr>");
  }
  if (!rows.length) out.push(`<tr class="none"><td colspan="${cols.length}">${esc(cfg.empty || "Nothing to show")}</td></tr>`);
  tbl.tBodies[0].innerHTML = out.join("");
  if (rows.length > n) {
    foot.hidden = false;
    foot.innerHTML = `<span>Showing ${f.int(n)} of ${f.int(rows.length)}</span><button data-more="1">Show ${f.int(Math.min(st.step, rows.length - n))} more</button><button data-more="all">Show all</button>`;
  } else if (cfg.foot) { foot.hidden = false; foot.innerHTML = `<span>${cfg.foot}</span>`; } else { foot.hidden = true; foot.innerHTML = ""; }
}

/** Draw (or redraw) a sortable table inside `el`. Call it again with new rows whenever data changes:
 *  the scroll position, the sort the user chose and the "show more" state are kept.
 *
 *  cfg: {
 *    id:      "screener"            unique name; the chosen sort is remembered under it
 *    cols:    [{ k: "edge",         field name, also the sort key
 *                label: "Edge",     header (HTML allowed)
 *                title: "…",        header tooltip: say what the number is and its basis
 *                l / c:  true       left / centre aligned (numbers are right aligned by default)
 *                val:  row => …     raw value for sorting and for fmt (default row[k])
 *                fmt:  (v, row, i) => html      cell markup (default: escaped value, "—" when null)
 *                cls:  (v, row) => "up"         cell class (or a fixed string)
 *                heat: (v, row) => style        cell background, usually heat(v, lo, hi)
 *                sort: false        not sortable       hide: true   leave the column out       w: px width }],
 *    rows:    [...]                 any objects
 *    key:     row => id             row identity (default row.key)
 *    sel:     id                    the highlighted row
 *    sort:    { k, dir: -1 | 1 }    initial sort (the user's own choice wins once made)
 *    limit:   200                   rows drawn before "Show more"
 *    onRow:   (row, event) => {}    click (not fired for clicks on buttons, links or inputs in the row)
 *    onDbl:   (row, event) => {}    double click
 *    rowCls:  row => "dim"          extra class for the row
 *    empty:   "Nothing passes the filters"
 *    maxH:    320                   cap the height (px or CSS); the table then scrolls with a sticky header
 *    head:    "<tr>…</tr>"          extra header row(s) above the column names
 *    foot:    "html"                note under the table
 *    cls:     "chain"               extra class on the <table>
 *    nav:     false                 opt out of ↑/↓ row navigation }
 *  → { setSel(id), move(±1), view() }    view() = rows in display order */
export function table(el, cfg) {
  let st = el.__tbl;
  if (!st || st.id !== cfg.id) {
    el.classList.add("tbl-host");
    el.innerHTML = `<div class="tbl-wrap" data-scroll${cfg.nav === false ? "" : " data-nav"}><table class="t${cfg.cls ? " " + cfg.cls : ""}"><thead></thead><tbody></tbody></table></div><div class="tbl-foot" hidden></div>`;
    st = el.__tbl = { id: cfg.id, sort: sorts[cfg.id] || cfg.sort || null, step: cfg.limit || 200, shown: cfg.limit || 200 };
    const wrap = el.firstElementChild;
    wrap.addEventListener("click", e => {
      const th = e.target.closest("th[data-k]");
      if (th) {
        const c = st.cols.find(x => x.k === th.dataset.k);
        if (!c || c.sort === false) return;
        st.sort = st.sort && st.sort.k === c.k ? { k: c.k, dir: -st.sort.dir } : { k: c.k, dir: c.l ? 1 : -1 };
        sorts[st.id] = st.sort;
        save("sorts", sorts);
        drawTable(el, st);
        return;
      }
      if (e.target.closest("button, a, input, select, [data-act], [data-chip]")) return;
      const tr = e.target.closest("tbody tr[data-i]");
      if (tr && st.cfg.onRow) st.cfg.onRow(st.view[+tr.dataset.i], e, tr);
    });
    wrap.addEventListener("dblclick", e => {
      if (e.target.closest("button, a, input, select")) return;
      const tr = e.target.closest("tbody tr[data-i]");
      if (tr && st.cfg.onDbl) st.cfg.onDbl(st.view[+tr.dataset.i], e, tr);
    });
    el.lastElementChild.addEventListener("click", e => {
      const b = e.target.closest("button[data-more]");
      if (!b) return;
      st.shown = b.dataset.more === "all" ? Infinity : st.shown + st.step;
      drawTable(el, st);
    });
    st.handle = {
      setSel(id) {
        st.cfg.sel = id;
        const key = st.cfg.key || (r => r.key);
        for (const tr of el.querySelectorAll("tbody tr[data-i]")) tr.classList.toggle("on", id != null && key(st.view[+tr.dataset.i]) === id);
      },
      move(d) {
        const key = st.cfg.key || (r => r.key), n = Math.min(st.view.length, st.shown);
        if (!n) return false;
        const i = st.view.findIndex(r => key(r) === st.cfg.sel);
        const j = clamp(i < 0 ? 0 : i + d, 0, n - 1), r = st.view[j];
        st.handle.setSel(key(r));
        el.querySelector(`tbody tr[data-i="${j}"]`)?.scrollIntoView({ block: "nearest" });
        st.cfg.onRow?.(r, null, null);
        return true;
      },
      view: () => st.view,
    };
  }
  if (cfg.limit && cfg.limit !== st.step) { st.step = cfg.limit; st.shown = cfg.limit; }
  st.cfg = cfg;
  drawTable(el, st);
  return st.handle;
}

/* ---------- files, clipboard, toast ---------- */

/** Save text as a file (through the desktop app's save dialog when inside it, otherwise a browser download). */
export function saveFile(name, text, type = "text/csv") {
  if (inApp()) { window.pywebview.api.save(name, text).then(p => { if (p) toast(`Saved ${p}`); }); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/** Export rows as CSV. cols: [{ k, label, val? }] — raw values, not the formatted cells. */
export function csv(name, cols, rows) {
  const cell = v => {
    if (v == null || (typeof v === "number" && !Number.isFinite(v))) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(c => cell(c.csv ?? c.k)).join(",")];
  for (const r of rows) lines.push(cols.map(c => cell(c.val ? c.val(r) : r[c.k])).join(","));
  saveFile(name, lines.join("\n") + "\n");
  toast(`Exported ${f.int(rows.length)} rows to ${name}`);
}

export async function copy(text, what = "Copied") {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const t = document.createElement("textarea");
    t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
    document.body.append(t); t.select();
    try { document.execCommand("copy"); } catch (e2) { /* nothing more to try */ }
    t.remove();
  }
  toast(what);
}

let toastTimer = 0;
/** A short message at the bottom of the window. kind: "" | "bad" */
export function toast(msg, kind = "") {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === "bad" ? 5000 : 2600);
}

/* ---------- helpers ---------- */

/** Run fn (which may re-render `root`) and put every scroll position back afterwards. */
export async function keepScroll(root, fn) {
  const grab = () => [root, ...root.querySelectorAll("[data-scroll]")];
  const before = grab().map(e => [e.scrollTop, e.scrollLeft]);
  const out = await fn();
  const after = grab();
  if (after.length === before.length) after.forEach((e, i) => { e.scrollTop = before[i][0]; e.scrollLeft = before[i][1]; });
  else { root.scrollTop = before[0][0]; root.scrollLeft = before[0][1]; }
  return out;
}

export function debounce(fn, ms = 150) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Parse what someone typed into a number field: "1,500", "$2k", "12%" → number, or null. */
export function parseNum(s) {
  const m = String(s ?? "").replace(/[$,%\s]/g, "").toLowerCase().match(/^(-?\d*\.?\d+)(k|m)?$/);
  if (!m) return null;
  return +m[1] * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1);
}


/* ---------- dialogs ---------- */

/** A modal dialog with a form. Resolves to { name: value, … } when saved, or null when cancelled.
 *  fields: [{ k, label, type: "text"|"number"|"date"|"select"|"textarea", value, options: [v | { v, label }], full, ph, req }]
 *  Numbers come back as numbers (null when empty), everything else as trimmed strings.
 *  o: { ok: "Save", note: "html shown above the fields", danger: "Delete" (adds a button; resolves { __danger: true }) } */
export function formModal(title, fields, o = {}) {
  return new Promise(resolve => {
    const m = document.getElementById("modal");
    const inp = fl => {
      const v = fl.value ?? "", a = `name="${esc(fl.k)}"${fl.req ? " required" : ""}${fl.ph ? ` placeholder="${esc(fl.ph)}"` : ""}`;
      if (fl.type === "select") return `<select ${a}>${(fl.options || []).map(x => { const c = x != null && typeof x === "object" ? x : { v: x }; return `<option value="${esc(c.v)}"${String(c.v) === String(v) ? " selected" : ""}>${esc(c.label ?? c.v)}</option>`; }).join("")}</select>`;
      if (fl.type === "textarea") return `<textarea ${a} rows="3">${esc(v)}</textarea>`;
      return `<input ${a} type="${["date", "password"].includes(fl.type) ? fl.type : "text"}"${fl.type === "number" ? ' inputmode="decimal"' : ""} value="${esc(v)}" autocomplete="off" spellcheck="false">`;
    };
    m.innerHTML = `<form class="pal"><div class="mh"><span>${esc(title)}</span><button type="button" data-x>✕</button></div>`
      + (o.note ? `<div class="strip">${o.note}</div>` : "")
      + `<div class="form">${fields.map(fl => `<label class="${fl.full || fl.type === "textarea" ? "full" : ""}">${esc(fl.label)}${inp(fl)}</label>`).join("")}</div>`
      + `<div class="mf">${o.danger ? `<button type="button" class="btn warn" data-danger style="margin-right:auto">${esc(o.danger)}</button>` : ""}`
      + `<button type="button" class="btn" data-x>Cancel</button><button class="btn pri">${esc(o.ok || "Save")}</button></div></form>`;
    m.hidden = false;
    const form = m.firstElementChild, done = v => { m.hidden = true; m.innerHTML = ""; document.removeEventListener("keydown", onKey, true); resolve(v); };
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
    document.addEventListener("keydown", onKey, true);
    m.onmousedown = e => { if (e.target === m) done(null); };
    form.addEventListener("click", e => { if (e.target.closest("[data-x]")) done(null); else if (e.target.closest("[data-danger]")) done({ __danger: true }); });
    form.addEventListener("submit", e => {
      e.preventDefault();
      const out = {};
      for (const fl of fields) {
        const raw = String(form.elements[fl.k].value ?? "").trim();
        out[fl.k] = fl.type === "number" ? (raw === "" ? null : parseNum(raw)) : raw;
      }
      done(out);
    });
    (form.querySelector("input,select,textarea") || form).focus();
  });
}

/** Ask yes/no. Resolves true or false. */
export function confirmModal(title, text, ok = "Confirm") {
  return formModal(title, [], { note: text, ok }).then(v => !!v);
}

/** Open the system file picker; resolves to an array of File objects (empty when cancelled). */
export function pickFiles(accept = ".csv,.pdf,.txt,.tsv") {
  return new Promise(resolve => {
    const i = document.createElement("input");
    i.type = "file"; i.multiple = true; i.accept = accept;
    i.onchange = () => resolve([...i.files]);
    i.oncancel = () => resolve([]);
    i.click();
  });
}
