// core.js — shared state, API access with a cache, events, routing and formatters.
// Everything a page needs to know about "what is selected" and "how do I get data" is here. No page markup.

/* ---------- pages ---------- */
// group: "main" | "research" | "ops" (property management) | "hidden" (no sidebar entry).
// prop: true → the page is about the selected property (S.prop) and its route carries the property id.
export const PAGES = [
  { id: "overview", label: "Overview", key: "1", group: "main" },
  { id: "search", label: "Discover", key: "2", group: "main" },
  { id: "properties", label: "Properties", key: "3", group: "main" },
  { id: "underwrite", label: "Underwriting", key: "4", group: "main", prop: true },
  { id: "studio", label: "Development Studio", key: "5", group: "main", prop: true },
  { id: "pipeline", label: "Deal Pipeline", key: "6", group: "main" },
  { id: "portfolio", label: "Portfolio", key: "7", group: "main" },
  { id: "rentroll", label: "Rent roll", key: "", group: "ops" },
  { id: "ledger", label: "Rent ledger", key: "", group: "ops" },
  { id: "books", label: "Expenses & debt", key: "", group: "ops" },
  { id: "comps", label: "Comparable Sales", key: "8", group: "research", prop: true },
  { id: "market", label: "Market Intelligence", key: "9", group: "research" },
  { id: "screen", label: "Opportunity Screen", key: "0", group: "research" },
  { id: "inbox", label: "Documents", key: "", group: "research" },
  { id: "reports", label: "Reports", key: "", group: "research" },
  { id: "property", label: "Property", key: "", group: "hidden", prop: true },
  { id: "settings", label: "Settings", key: "", group: "hidden" },
  { id: "setup", label: "Setup", key: "", group: "hidden" },
  { id: "help", label: "Help", key: "", group: "hidden" },
];
export const pageOf = id => PAGES.find(p => p.id === id) || null;

/* ---------- persistence ---------- */
const LS = "va_";
export function load(k, d) {
  try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
}
export function save(k, v) {
  try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* private mode */ }
}

/* ---------- state ---------- */
export const S = {
  page: "overview",
  pid: load("pid", null),     // selected property id (pages in the "prop" group are about it)
  prop: null,                 // its profile (GET /api/property/<pid>), loaded by the shell; null while loading
  state: null,                // GET /api/state
  sel: null,                  // what the ticket shows: { kind: "property"|"deal"|"lease"|"zip"|"txn"|"unit", id, row } or null
  prefs: Object.assign({ recent: [], collapsed: {} }, load("prefs", {})),
  err: "",
  v: 0,                       // data version: bumped by every mutation; cached GETs belong to one version
};

/* ---------- events ---------- */
// "data"  something was written or the workspace changed: re-read what you show     "tick"  state polled, nothing new
// "page"  visible page changed        "prop"  selected property (S.pid / S.prop) changed
// "sel"   ticket selection changed    "prefs" a preference changed      "theme" light/dark switched
const subs = new Map();
export function on(evt, fn) {
  if (!subs.has(evt)) subs.set(evt, new Set());
  subs.get(evt).add(fn);
  return () => subs.get(evt).delete(fn);
}
export function emit(evt, detail) {
  for (const fn of [...(subs.get(evt) || [])]) {
    try { fn(detail); } catch (e) { console.error(`listener for "${evt}" failed`, e); }
  }
}

export function pref(k, v) {
  if (v === undefined) return S.prefs[k];
  S.prefs[k] = v;
  save("prefs", S.prefs);
  emit("prefs", k);
  return v;
}

/* ---------- API ---------- */

/** Raw call. GET when body is undefined, POST JSON otherwise. Throws on HTTP errors. */
export async function api(path, body) {
  const r = await fetch(path, body === undefined ? { cache: "no-store" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok) throw new Error(j?.error || `${path} answered ${r.status}`);
  return j;
}

const cache = new Map();   // path → { v, p }
/** Cached GET: the same path asked twice between two writes is fetched once. Use this in render(). */
export function get(path) {
  const hit = cache.get(path);
  if (hit && hit.v === S.v) return hit.p;
  const p = api(path).catch(e => { cache.delete(path); throw e; });
  cache.set(path, { v: S.v, p });
  return p;
}

/** A write. POSTs, then invalidates every cached GET, reloads the selected property and emits "data".
 *  Returns the response (check `.error`). Never throws: a failed call returns { error }. */
export async function post(path, body, o = {}) {
  let r;
  try { r = await api(path, body || {}); } catch (e) { return { error: String(e.message || e) }; }
  if (!o.quiet) await changed();
  return r || {};
}

/** Call after data changed by some other route (the shell also calls it). */
export async function changed() {
  S.v++;
  cache.clear();
  try { S.state = await api("/api/state"); } catch (e) { /* keep the old one */ }
  if (S.pid != null) { try { S.prop = await get(`/api/property/${S.pid}`); } catch (e) { S.prop = null; } }
  emit("data");
}

let stamp = "";
/** Poll the engine. Emits "data" when the workspace, the market data or the counts changed; otherwise "tick". */
export async function refreshState() {
  const st = await api("/api/state");
  const sig = JSON.stringify([st.demo, st.market, st.counts, st.job.busy, st.rentcast.used, st.config]);
  S.state = st;
  S.err = st.job?.error || "";
  if (sig !== stamp) {
    const first = !stamp;
    stamp = sig;
    if (!first) { S.v++; cache.clear(); }
    if (S.pid != null && !S.prop) { try { S.prop = await get(`/api/property/${S.pid}`); } catch (e) { S.pid = null; S.prop = null; } }
    emit("data");
  } else emit("tick");
  return st;
}

/* ---------- selection ---------- */

/** Make a property the selected one (loads its profile). Returns the profile, or null if it does not exist. */
export async function setProp(pid) {
  pid = pid == null ? null : +pid;
  if (pid === S.pid && S.prop) return S.prop;
  S.pid = pid;
  S.prop = null;
  save("pid", pid);
  if (pid != null) {
    try { S.prop = await get(`/api/property/${pid}`); } catch (e) { S.pid = null; save("pid", null); }
    if (S.prop) {
      const p = S.prop.property;
      pref("recent", [{ id: p.id, address: p.address }, ...(S.prefs.recent || []).filter(r => r.id !== p.id)].slice(0, 8));
    }
  }
  emit("prop");
  return S.prop;
}

/** Select something for the ticket (right panel), or null to clear.  select({ kind: "property", id, row }) */
export function select(x) {
  S.sel = x || null;
  emit("sel");
}

export const routeFor = (page, pid) => (pageOf(page)?.prop && (pid ?? S.pid) != null ? `#/${page}/${pid ?? S.pid}` : `#/${page}`);

/** Go to a page; pass a property id to select that property too.  go("underwrite", 12) */
export function go(page, pid) {
  const h = routeFor(page, pid);
  if (pid != null && !pageOf(page)?.prop) setProp(pid);
  if (location.hash !== h) location.hash = h;
  else emit("route");
}

export function parseRoute(hash = location.hash) {
  const [page, id] = hash.replace(/^#\/?/, "").split("/");
  return { page: pageOf(page) ? page : null, pid: id && /^\d+$/.test(id) ? +id : null };
}

/** Look an address up (geocode + records when a key is set), select it and open its page. */
export async function lookup(address, page = "property") {
  const r = await post("/api/lookup", { address });
  if (r.error || r.id == null) return r;
  await setProp(r.id);
  go(page, r.id);
  return r;
}

/** Upload files (File objects) to the Inbox. Returns [{ name, id, kind, dup, extract, error }]. */
export async function upload(files, extra = {}) {
  const out = [];
  for (const file of files) {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      const r = await api("/api/upload", { name: file.name, data: btoa(bin), ...extra });
      out.push({ name: file.name, ...r });
    } catch (e) { out.push({ name: file.name, error: String(e.message || e) }); }
  }
  await changed();
  return out;
}

/* ---------- theme and the desktop app ---------- */

export const isDark = () => document.documentElement.dataset.theme !== "light";
export function setTheme(mode) {
  if (mode === "light") document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem("va_theme", mode); } catch (e) { /* ignore */ }
  emit("theme", mode);
}
/** Inside the desktop app (pywebview)? Then files are saved through its native dialog. */
export const inApp = () => !!window.pywebview?.api;

/** Open a web page in the user's browser (the desktop app hands it to the system browser). */
export function openExternal(url) {
  if (inApp() && window.pywebview.api.open_url) window.pywebview.api.open_url(url); else window.open(url, "_blank", "noopener");
}
/** Street-level view of a point: get(streetView(lat, lon)) → { link (Google Street View in the browser, always),
 *  embed (iframe URL, only when a Google Maps key is set in Settings; else null), maps (plain map link) }. */
export const streetView = (lat, lon) => `/api/streetview?lat=${+lat}&lon=${+lon}`;

/* ---------- formatters: every number on screen goes through one of these ---------- */

const ok = v => v != null && v !== "" && Number.isFinite(+v);
const DASH = "—";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ymd = e => { const [y, m, d] = String(e).slice(0, 10).split("-").map(Number); return { y, m, d: d || 1 }; };
const grp = (v, dp) => Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const sign = v => (v > 0 ? "+" : v < 0 ? "−" : "");
export const workspaceCurrency = () => S.state?.demo ? "USD" : S.state?.config?.currency || "USD";
const currencyPrefixes = new Map([["USD", "$"], ["CAD", "$"]]);
function currencyPrefix() {
  const code = workspaceCurrency();
  if (!currencyPrefixes.has(code)) {
    const parts = new Intl.NumberFormat("en", { style: "currency", currency: code }).formatToParts(0);
    const symbol = parts.find(part => part.type === "currency")?.value || code;
    currencyPrefixes.set(code, /^[A-Z]{3}$/.test(symbol) ? symbol + " " : symbol);
  }
  return currencyPrefixes.get(code);
}

export const f = {
  ok, DASH,
  /** 1,234.57 */
  num: (v, dp = 2) => (ok(v) ? (v < 0 ? "−" : "") + grp(+v, dp) : DASH),
  /** 1,235 */
  int: v => (ok(v) ? (v < 0 ? "−" : "") + grp(Math.round(+v), 0) : DASH),
  /** $1,235 (dp = 2 → $1,234.57) */
  usd: (v, dp = 0) => (ok(v) ? (v < 0 ? "−" : "") + currencyPrefix() + grp(+v, dp) : DASH),
  /** +$1,235 / −$1,235 */
  susd: (v, dp = 0) => (ok(v) ? sign(+v) + currencyPrefix() + grp(+v, dp) : DASH),
  /** $12.3K, $4.5M */
  cusd: v => (ok(v) ? (v < 0 ? "−" : "") + currencyPrefix() + f.compact(Math.abs(v)) : DASH),
  /** fraction → 12.3% */
  pct: (v, dp = 1) => (ok(v) ? (v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(dp) + "%" : DASH),
  /** fraction → +12.3% / −12.3% */
  spct: (v, dp = 1) => (ok(v) ? sign(+v) + Math.abs(v * 100).toFixed(dp) + "%" : DASH),
  /** ratio: 1.25× */
  x: (v, dp = 2) => (ok(v) ? (+v).toFixed(dp) + "×" : DASH),
  /** 12.3K, 4.5M, 1.2B */
  compact: v => {
    if (!ok(v)) return DASH;
    const a = Math.abs(v), s = v < 0 ? "−" : "";
    if (a >= 1e9) return s + (a / 1e9).toFixed(a >= 1e10 ? 1 : 2) + "B";
    if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
    if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "K";
    return s + String(Math.round(a));
  },
  /** "2026-11-20" → Nov 20 */
  date: e => { if (!e) return DASH; const p = ymd(e); return `${MON[p.m - 1]} ${p.d}`; },
  /** → Nov 20 '26 */
  dateY: e => { if (!e) return DASH; const p = ymd(e); return `${MON[p.m - 1]} ${p.d} '${String(p.y).slice(2)}`; },
  /** "2026-11" or a date → Nov '26 */
  mo: e => { if (!e) return DASH; const p = ymd(e); return `${MON[p.m - 1]} '${String(p.y).slice(2)}`; },
  /** 1,450 sf */
  sqft: v => (ok(v) ? grp(Math.round(+v), 0) + " sf" : DASH),
  /** beds / baths: 3 bd · 2 ba */
  bb: p => `${ok(p?.beds) ? +p.beds : DASH} bd · ${ok(p?.baths) ? +p.baths : DASH} ba`,
  /** "123 Main St, Columbus, OH 43201" → "123 Main St" */
  street: a => String(a || DASH).split(",")[0],
  /** → "Columbus, OH 43201" */
  city: a => String(a || "").split(",").slice(1).join(",").trim(),
  /** "up" / "down" / "" for colouring a signed number */
  cls: v => (ok(v) ? (v > 0 ? "up" : v < 0 ? "down" : "") : ""),
  /** days: 34d */
  days: d => (ok(d) ? `${Math.round(d)}d` : DASH),
  /** → "12m ago", "3h ago", "2d ago" */
  ago: ts => {
    if (!ts) return DASH;
    const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    return s < 90 ? "just now" : s < 5400 ? Math.round(s / 60) + "m ago" : s < 129600 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago";
  },
  /** score 0–100 → "72" */
  score: v => (ok(v) ? String(Math.round(v)) : DASH),
};

/** Calendar days from today to a date string (negative = past). */
export function daysTo(e) {
  const a = ymd((S.state?.today || new Date().toISOString()).slice(0, 10)), b = ymd(e);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}
export const today = () => (S.state?.today || new Date().toISOString().slice(0, 10));

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
