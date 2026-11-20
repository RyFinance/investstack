// shell.js — the frame around every page: header tabs, command bar, property detail, footer,
// command palette, file drop, trackpad gestures and keys. Pages load on demand from ./pages/<id>.js.
import {
  S, PAGES, pageOf, on, emit, refreshState, go, setProp, select, f, esc, load, save, setTheme, isDark,
  api, get, post, parseRoute, routeFor, lookup, upload, pref, changed,
} from "./core.js";
import { toast, keepScroll, loading, empty, formModal } from "./ui.js";

const $ = id => document.getElementById(id);
const mods = new Map(), modNow = new Map(), roots = new Map();
let cur = null;
const tabOrder = PAGES.filter(p => p.group !== "hidden").map(p => p.id);

/* ---------- pages ---------- */

function loadPage(id) {
  if (!mods.has(id)) {
    mods.set(id, import(`./pages/${id}.js`)
      .then(m => m.default || { missing: true, error: "the module has no default export" })
      .catch(e => { console.error(`page "${id}" did not load:`, e); return { missing: true, error: String(e?.message || e) }; })
      .then(m => { modNow.set(id, m); return m; }));
  }
  return mods.get(id);
}

const depends = (id, evt) => (modNow.get(id)?.deps || []).includes(evt) || (evt === "prop" && pageOf(id)?.prop);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let queue = Promise.resolve();

/** Ask the visible page to draw itself. Renders run one after another; a page that hangs is given 15 seconds. */
function render(reason) {
  const page = cur;
  if (!page) return queue;
  queue = queue.then(async () => {
    if (page !== cur) return;
    const mod = await loadPage(page), root = roots.get(page);
    if (page !== cur) return;
    if (mod.missing) { root.innerHTML = empty(`${pageOf(page).label} is not built yet`, esc(mod.error || "")); return; }
    if (!S.state) { root.innerHTML = empty("Connecting to the engine", esc(S.err || "")); return; }
    if (pageOf(page).prop && !S.prop) {
      root.innerHTML = empty("No property selected",
        `Type an address in the command bar, press <b>A</b> to look one up, or pick one on <a class="link" data-go="search">Discover</a> or <a class="link" data-go="properties">Properties</a>.`);
      return;
    }
    try {
      await Promise.race([keepScroll(root, () => mod.render(root, { reason, sub: $("sub"), bar: $("bar-r") })), sleep(15000)]);
    } catch (e) {
      console.error(`page "${page}" failed to draw:`, e);
      root.innerHTML = empty(`${pageOf(page).label} could not be drawn`, esc(String(e?.message || e)));
    }
  });
  return queue;
}

async function show(id, dir = 0) {
  if (!pageOf(id)) id = "overview";
  if (id !== cur) {
    const prev = cur;
    if (prev) {
      try { modNow.get(prev)?.leave?.(); } catch (e) { console.error(e); }
      roots.get(prev).hidden = true;
    }
    cur = id;
    S.page = id;
    save("page", id);
    for (const el of [$("sub"), $("bar-r")]) { el.innerHTML = ""; el.__map = {}; }
    let root = roots.get(id);
    if (!root) {
      root = document.createElement("div");
      root.className = "page";
      root.dataset.page = id;
      root.innerHTML = loading();
      $("main").append(root);
      roots.set(id, root);
    }
    root.hidden = false;
    root.classList.remove("in-l", "in-r");
    if (dir) { void root.offsetWidth; root.classList.add(dir > 0 ? "in-r" : "in-l"); }
    closeTools();
    drawTabs();
    setTitle();
    emit("page");
  }
  return render("show");
}

function setTitle() {
  const p = pageOf(cur);
  document.title = `${p?.prop && S.prop ? f.street(S.prop.property.address) + " · " : ""}${p?.label || "InvestStack"} · InvestStack`;
}

async function onRoute(dir = 0) {
  const r = parseRoute();
  if (r.pid != null && r.pid !== S.pid) await setProp(r.pid);
  const page = r.page || cur || load("page", "overview");
  if (page !== cur) show(page, dir); else render("show");
}

function step(d) {
  const i = tabOrder.indexOf(cur), j = i + d;
  if (i < 0 || j < 0 || j >= tabOrder.length) return;
  pendingDir = d;
  location.hash = routeFor(tabOrder[j]);
}
let pendingDir = 0;

/* ---------- top navigation ---------- */

const PRIMARY_TABS = ["overview", "search", "properties", "pipeline", "portfolio"];
const TOOL_GROUPS = [
  ["Analysis", ["underwrite", "comps", "studio", "market", "screen"]],
  ["Operations", ["rentroll", "ledger", "books", "inbox", "reports"]],
  ["Workspace", ["setup", "settings", "help"]],
];

function drawTabs() {
  const c = S.state?.counts || {};
  const onId = cur === "property" ? "properties" : cur;
  const badge = n => n ? `<span class="n">${n}</span>` : "";
  const count = id => id === "inbox" ? (c.inbox || 0) + (c.txns || 0) : id === "pipeline" ? c.tasks_due : 0;
  const current = id => id === onId ? ' aria-current="page"' : "";
  const tabs = PRIMARY_TABS.map(id => {
    const { label, key } = pageOf(id);
    return `<button class="tab" data-page="${id}"${current(id)} title="${esc(label)} (${key})">${id === "pipeline" ? "Pipeline" : esc(label)}${badge(count(id))}</button>`;
  }).join("");
  const onTool = cur && !PRIMARY_TABS.includes(onId);
  const tools = TOOL_GROUPS.map(([name, ids]) => `<div class="tool-group"><span>${name}</span>${ids.map(id => {
    const { label, key } = pageOf(id);
    return `<button data-page="${id}"${current(id)}>${esc(label)}${badge(count(id)) || (key ? `<kbd>${key}</kbd>` : "")}</button>`;
  }).join("")}${name === "Workspace" && S.prop ? '<button data-page="property">Selected property</button>' : ""}</div>`).join("");
  const nav = $("tabs");
  const wasOpen = !!nav.querySelector(".menu.open");
  const focused = nav.contains(document.activeElement) ? document.activeElement : null;
  nav.innerHTML = tabs + `<div class="menu${wasOpen ? " open" : ""}"><button class="tab${onTool ? " on" : ""}" data-act-menu
    aria-expanded="${wasOpen}" aria-controls="tool-pages">Tools${badge(count("inbox"))}<i class="car" aria-hidden="true"></i></button>
    <div class="dd" id="tool-pages">${tools}</div></div>`;
  if (focused) {
    const target = focused.hasAttribute("data-act-menu") ? "[data-act-menu]" : `[data-page="${focused.dataset.page}"]`;
    nav.querySelector(target)?.focus({ preventScroll: true });
  }
  const title = $("ptitle");
  title.textContent = cur === "property" && S.prop ? f.street(S.prop.property.address) : (pageOf(cur)?.label || "");
}

function closeTools(restoreFocus = false) {
  const menu = $("tabs").querySelector(".menu.open");
  if (!menu) return false;
  const trigger = menu.querySelector("[data-act-menu]");
  menu.classList.remove("open");
  trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger.focus();
  return true;
}

/* ---------- desk figures (header) ---------- */

let sideSeq = 0;
async function drawSide() {
  const side = $("side"), seq = ++sideSeq;
  if (!S.state) { side.innerHTML = ""; return; }
  let pf = null, pl = null;
  try { [pf, pl] = await Promise.all([get("/api/portfolio"), get("/api/pipeline")]); } catch (e) { /* draw what we can */ }
  if (seq !== sideSeq) return;
  const t = pf?.total, r = S.state.rates || {}, own = pf?.properties.length;
  const cell = (go_, k, v, title = "", cls = "") => `<div class="dsk" data-go="${go_}" title="${esc(title)}"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  let h = "";
  if (own) {
    h += cell("portfolio", "Equity", f.cusd(t.equity), `${f.cusd(t.value)} value, ${f.pct(t.ltv, 0)} loan-to-value, ${own} properties`)
      + cell("portfolio", "Cash flow 12m", f.susd(t.cf), "Rent collected less operating expenses and loan payments, last 12 months", f.cls(t.cf))
      + cell("rentroll", "Occupied", `${t.occupied}/${t.units}`, `${f.usd(t.rent_roll)} scheduled rent a month`)
      + cell("ledger", "Rent owed", f.usd(t.arrears), "Unpaid rent and fees across all leases", t.arrears > 0 ? "down" : "");
  }
  if (pl) {
    const act = pl.deals.filter(d => !["acquired", "rejected"].includes(d.stage)).length;
    const due = pl.tasks.filter(x => x.due && x.due <= S.state.today).length;
    h += cell("pipeline", "Deals", String(act), `${act} active deals, ${due} tasks due`) + (due ? cell("pipeline", "Tasks due", String(due), "", "amb") : "");
  }
  if (r.MORTGAGE30US) h += cell("market", "30-yr fixed", r.MORTGAGE30US.value.toFixed(2) + "%", `FRED, week of ${r.MORTGAGE30US.date}`);
  side.innerHTML = h;
}

/* ---------- footer ---------- */

function drawFoot() {
  const st = S.state;
  if (!st) { $("foot").innerHTML = `<span><i class="dot"></i>${esc(S.err || "Connecting to the engine")}</span>`; return; }
  const rc = st.rentcast, job = st.job;
  const left = [
    `<span><i class="dot ${job.busy ? "busy" : "live"}"></i>${job.busy ? esc(job.step || "Updating market data") : st.demo ? "Demo workspace" : "Your workspace"}</span>`,
    st.market.zips ? `<span title="Zillow Research ZIP indexes">${f.int(st.market.zips)} ZIPs · ${f.mo(st.market.as_of)}</span>` : `<span class="amb">Market indexes not downloaded yet</span>`,
    `<span>${f.int(st.counts.listings)} listings · ${f.int(st.counts.properties)} properties</span>`,
    `<span>${st.demo ? "USD" : esc(st.config?.currency || "USD")}</span>`,
    rc.has_key ? `<span title="RentCast calls this month. First ${rc.free} are free; ${rc.billable} billable so far (about ${f.usd(rc.est_cost, 2)})" class="${rc.used >= rc.allowance ? "down" : rc.used >= rc.free ? "amb" : ""}">RentCast ${rc.used}/${rc.allowance}</span>`
      : `<span class="mut" title="Add a key in Settings to pull live listings, records and estimates">No RentCast key</span>`,
    job.error ? `<span class="down" title="${esc(job.error)}">Data error: ${esc(job.error.slice(0, 50))}</span>` : "",
  ];
  const right = [`<span><kbd>A</kbd>address</span>`, `<span><kbd>⌘K</kbd>commands</span>`, `<span><kbd>?</kbd>help</span>`];
  $("foot").innerHTML = left.filter(Boolean).join("") + `<span class="r">${right.join("")}</span>`;
  $("ws-txt").textContent = st.demo ? "Demo" : "Workspace";
  $("ws-badge").querySelector("i").className = st.demo ? "" : "live";
}

/* ---------- ticket (right panel) ---------- */

let ticket = null;
/** The floating property card: shown only while something is selected (S.sel); Esc or ✕ closes it. */
async function drawTicket(reason) {
  const el = $("ticket");
  document.body.classList.toggle("has-sel", !!S.sel);
  if (!S.sel || !S.state) return;
  if (ticket === null) {
    ticket = await import("./ticket.js").then(m => m.default || false)
      .catch(e => { console.error("the ticket did not load:", e); return false; });
  }
  if (ticket) {
    try { await ticket.render(el, { reason }); } catch (e) { console.error("the ticket failed to draw:", e); }
  }
  if (!el.querySelector(".tk-x")) el.insertAdjacentHTML("afterbegin", `<button class="tk-x" title="Close (Esc)">✕</button>`);
}

/* ---------- command bar ---------- */

const ALIAS = {
  SEARCH: "search", FIND: "search", LIST: "search", MAP: "search", SCREEN: "screen", SCR: "screen", RANK: "screen", MARKET: "market", MKT: "market", ZIP: "market",
  PROP: "property", PROPERTY: "property", DES: "property", COMPS: "comps", COMP: "comps", UW: "underwrite", UNDERWRITE: "underwrite", MODEL: "underwrite",
  PIPE: "pipeline", PIPELINE: "pipeline", DEALS: "pipeline", PORT: "portfolio", PORTFOLIO: "portfolio", HOME: "portfolio", RR: "rentroll", RENTROLL: "rentroll", RENT: "rentroll",
  LEASES: "rentroll", LEDGER: "ledger", AR: "ledger", BOOKS: "books", EXP: "books", EXPENSES: "books", DEBT: "books", MAINT: "books", INBOX: "inbox", IMPORT: "inbox",
  REPORTS: "reports", REPORT: "reports", TAX: "reports", SETTINGS: "settings", SETUP: "setup", KEYS: "setup", HELP: "help",
};

async function addAddress(pre = "") {
  const canada = !S.state?.demo && S.state?.config?.currency === "CAD";
  const v = await formModal("Look up an address", [{ k: "address", label: "Street address, unit, city and region", full: true, value: pre,
    ph: canada ? "Street address, Surrey, BC" : "123 Main St, Columbus, OH", req: true }],
    { ok: "Look up", note: canada ? "Available municipal facts are pulled automatically for Surrey and the Township of Langley."
      : "Geocoded with the US Census geocoder (free). With a RentCast key the record, value and rent estimates are pulled too (3 calls)." });
  if (!v?.address) return;
  toast("Looking up the address…");
  const r = await lookup(v.address);
  if (r.error) return toast(r.error, "bad");
  toast(r.notes?.length ? r.notes[0] : "Property added");
}

async function runCmd(text) {
  const raw = String(text).trim();
  if (!raw) return;
  const words = raw.toUpperCase().split(/\s+/);
  const page = ALIAS[words[words.length - 1]] || (words.length === 1 ? ALIAS[words[0]] : null);
  const rest = page && words.length > 1 ? raw.split(/\s+/).slice(0, -1).join(" ") : page ? "" : raw;
  if (!rest) return go(page);
  if (/^\d{5}$/.test(rest)) { pref("zip", rest); return go(page && page !== "property" ? page : "market"); }
  if (rest.toUpperCase() === "DEMO" || rest.toUpperCase() === "LIVE") return setWorkspace(rest.toUpperCase() === "DEMO");
  if (rest.toUpperCase() === "THEME") return setTheme(isDark() ? "light" : "dark");
  let hits = [];
  try { hits = await api(`/api/find?q=${encodeURIComponent(rest)}`); } catch (e) { /* fall through to lookup */ }
  if (hits.length) { await setProp(hits[0].id); return go(page || "property", hits[0].id); }
  if (/\d/.test(rest) && /[a-z]/i.test(rest)) {
    toast("Looking up the address…");
    const r = await lookup(rest, page || "property");
    if (r.error) toast(r.error, "bad"); else if (r.notes?.length) toast(r.notes[0]);
    return;
  }
  toast(`Nothing matches "${rest}". Type a full address to look it up, or press ⌘K.`, "bad");
}

async function setWorkspace(demo) {
  const r = await post("/api/settings", { demo });
  if (r.error) return toast(r.error, "bad");
  S.pid = null; S.prop = null; save("pid", null); pref("recent", []);
  select(null);
  emit("prop");
  toast(demo ? "Demo workspace: sample properties around Columbus, Ohio" : "Your workspace");
}

/* ---------- command palette ---------- */

let palIdx = 0, palList = [], palExtra = [];
function palItems() {
  const items = [];
  for (const p of PAGES) items.push({ kind: "Page", label: p.label, hint: p.key ? `key ${p.key}` : "", run: () => go(p.id) });
  for (const p of palExtra) items.push(p);
  for (const p of S.prefs.recent || []) items.push({ kind: "Recent", label: p.address, hint: "", run: () => go("property", p.id) });
  items.push({ kind: "Action", label: "Look up an address", hint: "A", run: () => addAddress() });
  items.push({ kind: "Action", label: "Import files (bank CSV, lease, mortgage statement)", hint: "I", run: () => go("inbox") });
  items.push({ kind: "Action", label: S.state?.demo ? "Switch to your own workspace" : "Switch to the demo workspace", hint: "", run: () => setWorkspace(!S.state?.demo) });
  items.push({ kind: "Action", label: "Update market data (Zillow, FRED)", hint: "", run: refreshMarket });
  items.push({ kind: "Action", label: `Switch to the ${isDark() ? "light" : "dark"} theme`, hint: "T", run: () => setTheme(isDark() ? "light" : "dark") });
  items.push({ kind: "Action", label: "Connect data providers", hint: "", run: () => go("setup") });
  return items;
}
async function palLoad() {
  try {
    const [pf, pl] = await Promise.all([get("/api/portfolio"), get("/api/pipeline")]);
    palExtra = [
      ...pf.properties.map(p => ({ kind: "Owned", label: p.address, hint: `${f.cusd(p.value)} · ${p.occupied}/${p.units_n} occupied`, run: () => go("property", p.id) })),
      ...pl.deals.map(d => ({ kind: "Deal", label: d.address, hint: `${d.stage} · ${f.cusd(d.ask)}`, run: () => { select({ kind: "deal", id: d.id, row: d }); go("pipeline"); } })),
    ];
    if (palOpen()) drawPal();
  } catch (e) { /* palette works without them */ }
}
function drawPal() {
  const q = $("pal-in").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  palList = palItems().filter(it => q.every(w => (it.kind + " " + it.label).toLowerCase().includes(w)));
  const typed = $("pal-in").value.trim();
  if (typed && /\d/.test(typed) && /[a-z]/i.test(typed)) palList.push({ kind: "Lookup", label: `Look up "${typed}"`, hint: "address", run: () => runCmd(typed) });
  if (/^\d{5}$/.test(typed)) palList.unshift({ kind: "ZIP", label: `Market for ${typed}`, hint: "", run: () => runCmd(typed) });
  palIdx = Math.min(palIdx, Math.max(0, palList.length - 1));
  $("pal-list").innerHTML = palList.length
    ? palList.slice(0, 80).map((it, i) => `<div class="pi${i === palIdx ? " on" : ""}" data-i="${i}"><span>${it.kind}</span>${esc(it.label)}<em>${esc(it.hint || "")}</em></div>`).join("")
    : `<div class="pi"><span></span>Nothing matches</div>`;
  $("pal-list").querySelector(".pi.on")?.scrollIntoView({ block: "nearest" });
}
const palOpen = () => !$("pal").hidden;
function openPal() {
  if (palOpen()) return;
  $("pal").hidden = false;
  $("pal-in").value = "";
  palIdx = 0;
  drawPal();
  palLoad();
  $("pal-in").focus();
}
function closePal() { $("pal").hidden = true; $("pal-in").blur(); }
function runPal(i) { const it = palList[i]; closePal(); if (it) it.run(); }

/* ---------- market refresh, polling ---------- */

async function refreshMarket() {
  const r = await post("/api/market/refresh", { force: true }, { quiet: true });
  toast(r.started ? "Downloading Zillow and FRED data. The ZIP file is 124 MB; this takes a few minutes." : "An update is already running.");
  poll();
}
let pollTimer = 0;
async function poll() {
  clearTimeout(pollTimer);
  try { await refreshState(); } catch (e) { S.err = "The engine is not answering"; drawFoot(); }
  pollTimer = setTimeout(poll, S.state?.job?.busy ? 3000 : 20000);
}

/* ---------- file drop ---------- */

async function importFiles(files) {
  if (!files.length) return;
  toast(`Reading ${files.length} file${files.length > 1 ? "s" : ""}…`);
  const res = await upload(files);
  const bad = res.filter(r => r.error), dup = res.filter(r => r.dup);
  toast(bad.length ? `${bad[0].name}: ${bad[0].error}` : dup.length === res.length ? "Already imported (same file)" : `${res.length - dup.length} file${res.length - dup.length > 1 ? "s" : ""} read. Review the proposals in the Inbox.`, bad.length ? "bad" : "");
  go("inbox");
}
function wireDrop() {
  let depth = 0;
  const has = e => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", e => { if (!has(e)) return; e.preventDefault(); depth++; $("drop").hidden = false; });
  window.addEventListener("dragover", e => { if (has(e)) e.preventDefault(); });
  window.addEventListener("dragleave", e => { if (!has(e)) return; depth = Math.max(0, depth - 1); if (!depth) $("drop").hidden = true; });
  window.addEventListener("drop", e => {
    if (!has(e)) return;
    e.preventDefault(); depth = 0; $("drop").hidden = true;
    importFiles([...e.dataTransfer.files]);
  });
}

/* ---------- gestures ---------- */

function scrollerX(el, dx) {
  for (; el && el !== document.body; el = el.parentElement) {
    if (el.classList?.contains("map")) return true;
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX;
      if ((ox === "auto" || ox === "scroll") && (dx > 0 ? el.scrollLeft < el.scrollWidth - el.clientWidth - 1 : el.scrollLeft > 0)) return true;
    }
  }
  return false;
}
function atTop(el) {
  for (; el && el !== document.body; el = el.parentElement) { if (el.scrollTop > 0 || el.classList?.contains("map")) return false; }
  return true;
}
const PULL = 520;

function wireGestures() {
  let accX = 0, lastX = 0, cool = 0, pull = 0, topAt = 0, lastY = 0;
  const hint = $("pull");
  const setPull = v => {
    pull = v;
    const t = Math.min(1, v / PULL);
    hint.style.opacity = t > 0.08 ? String(t) : "0";
    hint.style.transform = `translate(-50%, ${-50 + 50 * t}px)`;
  };
  window.addEventListener("wheel", e => {
    const now = performance.now(), ax = Math.abs(e.deltaX), ay = Math.abs(e.deltaY);
    if (!$("modal").hidden) return;
    if (palOpen()) { if (e.deltaY > 30 && !e.target.closest?.("#pal-list")) closePal(); return; }
    if (ax > ay * 1.4 && ax > 1) {
      setPull(0);
      if (e.target.closest?.(".rail, #ticket, .hdr, .bar, .no-swipe") || scrollerX(e.target, e.deltaX)) return;
      if (now - lastX > 250) accX = 0;
      lastX = now;
      accX += e.deltaX;
      if (now > cool && Math.abs(accX) > 150) { cool = now + 650; step(accX > 0 ? 1 : -1); accX = 0; }
      return;
    }
    if (e.deltaY < 0 && e.target.closest?.("#main") && atTop(e.target)) {
      if (now - lastY > 180) { topAt = now; setPull(0); }
      lastY = now;
      if (now - topAt > 450) setPull(pull + Math.min(25, -e.deltaY));
      if (pull > PULL) { setPull(0); cool = now + 1200; openPal(); }
    } else if (pull) setPull(0);
  }, { passive: true });
}

/* ---------- keys ---------- */

function navTable() {
  const root = roots.get(cur);
  const hosts = [...(root?.querySelectorAll(".tbl-wrap[data-nav]") || [])].map(w => w.parentElement).filter(h => h.__tbl?.handle);
  return (hosts.find(h => h.querySelector("tr.on")) || hosts[0])?.__tbl.handle || null;
}
function wireKeys() {
  window.addEventListener("keydown", e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); palOpen() ? closePal() : openPal(); return; }
    if (!$("modal").hidden) return;
    if (palOpen()) {
      if (e.key === "Escape") closePal();
      else if (e.key === "ArrowDown") { e.preventDefault(); palIdx = Math.min(palIdx + 1, palList.length - 1); drawPal(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); palIdx = Math.max(palIdx - 1, 0); drawPal(); }
      else if (e.key === "Enter") { e.preventDefault(); runPal(palIdx); }
      return;
    }
    if (e.key === "Escape" && closeTools(true)) return;
    if (typing) { if (e.key === "Escape") e.target.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    try { if (modNow.get(cur)?.key?.(e)) { e.preventDefault(); return; } } catch (err) { console.error(err); }
    const byKey = PAGES.find(p => p.key && p.key === e.key);
    if (byKey) { go(byKey.id); return; }
    switch (e.key) {
      case "/": e.preventDefault(); $("cmd").focus(); $("cmd").select(); break;
      case "?": go(cur === "help" ? load("back", "overview") : (save("back", cur), "help")); break;
      case "a": case "A": e.preventDefault(); addAddress(); break;
      case "i": case "I": go("inbox"); break;
      case "t": case "T": setTheme(isDark() ? "light" : "dark"); break;
      case "ArrowRight": case "]": step(1); break;
      case "ArrowLeft": case "[": step(-1); break;
      case "ArrowDown": case "j": if (navTable()?.move(1)) e.preventDefault(); break;
      case "ArrowUp": case "k": if (navTable()?.move(-1)) e.preventDefault(); break;
      case "Escape": if (S.sel) select(null); break;
      default: break;
    }
  });
}

/* ---------- wiring ---------- */

function wire() {
  $("tabs").addEventListener("click", e => {
    const m = e.target.closest("[data-act-menu]");
    if (m) {
      if (!closeTools()) {
        m.parentElement.classList.add("open");
        m.setAttribute("aria-expanded", "true");
      }
      return;
    }
    const t = e.target.closest("[data-page]");
    const fromMenu = !!t?.closest(".dd");
    closeTools(fromMenu);
    if (t) go(t.dataset.page);
  });
  // property and page links anywhere:  <a data-prop="12" data-go="underwrite">  or  <a data-go="market">
  document.addEventListener("click", e => {
    const a = e.target.closest("[data-prop], [data-go]");
    if (!a || a.closest("#pal") || a.closest("[data-nolink]")) return;
    if (a.dataset.prop) { e.preventDefault(); go(a.dataset.go || "property", +a.dataset.prop); }
    else if (a.dataset.go) { e.preventDefault(); go(a.dataset.go); }
  });
  $("cmd").addEventListener("keydown", e => {
    if (e.key === "Enter") { runCmd($("cmd").value); $("cmd").value = ""; $("cmd").blur(); }
  });
  $("add").addEventListener("click", () => addAddress());
  $("theme").addEventListener("click", () => setTheme(isDark() ? "light" : "dark"));
  $("ws-badge").addEventListener("click", () => go("settings"));
  document.addEventListener("pointerdown", e => { if (!e.target.closest("#tabs .menu")) closeTools(); });
  $("tabs").addEventListener("focusout", e => {
    if (e.relatedTarget && !e.relatedTarget.closest?.("#tabs .menu")) closeTools();
  });
  $("ticket").addEventListener("click", e => { if (e.target.closest(".tk-x")) select(null); });
  $("pal").addEventListener("mousedown", e => { if (e.target === $("pal")) closePal(); });
  $("pal-in").addEventListener("input", () => { palIdx = 0; drawPal(); });
  $("pal-list").addEventListener("click", e => { const it = e.target.closest("[data-i]"); if (it) runPal(+it.dataset.i); });
  window.addEventListener("hashchange", () => { const d = pendingDir; pendingDir = 0; onRoute(d); });
  wireGestures();
  wireKeys();
  wireDrop();

  on("route", () => onRoute(0));
  on("data", () => { drawSide(); drawFoot(); drawTabs(); render("data"); drawTicket("data"); });
  on("tick", drawFoot);
  on("prop", () => {
    drawSide();
    drawTabs();
    setTitle();
    if (pageOf(cur)?.prop && S.pid != null) history.replaceState(null, "", routeFor(cur, S.pid));
    if (depends(cur, "prop")) render("prop");
    drawTicket("prop");
  });
  for (const evt of ["sel", "prefs"]) {
    on(evt, k => {
      if (evt === "prefs" && k === "recent") drawTabs();
      if (depends(cur, evt)) render(evt);
      if (evt === "sel") drawTicket(evt);
    });
  }
  on("theme", () => { $("theme").textContent = isDark() ? "☀" : "☾"; if (depends(cur, "theme")) render("theme"); });
}

// what pages may import from the shell
export { addAddress, importFiles, setWorkspace, refreshMarket };

async function init() {
  wire();
  $("theme").textContent = isDark() ? "☀" : "☾";
  drawTabs();
  drawFoot();
  try { await refreshState(); } catch (e) { S.err = "The engine is not answering"; drawFoot(); }
  const r = parseRoute();
  if (r.pid != null) await setProp(r.pid);
  else if (S.pid != null && !S.prop) await setProp(S.pid);
  const firstRun = S.state?.demo && !S.state.config?.setup_complete;
  await show(r.page || (firstRun ? "setup" : load("page", "overview")));
  await queue;
  await drawTicket("show");
  if (!load("tip", 0)) { save("tip", 1); toast("Type an address or a ZIP in the command bar. Drop files on the window to import them. ⌘K for everything."); }
  window.__valoraReady = true;
  pollTimer = setTimeout(poll, S.state?.job?.busy ? 3000 : 20000);
}

init();
