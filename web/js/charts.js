// Inline-SVG charts for Tenor. No dependencies. Every colour is a CSS variable from web/style.css, so
// both themes work without a redraw; chart rules live in web/css/charts.css.
//
// Each chart function takes a container and options and returns { update(opts), destroy() }. A chart
// redraws when its container changes width, and calling a chart function again on the same element
// replaces the old chart together with its observer and listeners. Colours may be given as a token
// name ("up", "acc", "amber" …), a custom property ("--violet") or any CSS colour.

const TOKENS = new Set(["up", "down", "acc", "amber", "violet", "cyan", "tx", "tx-2", "mut", "faint", "line", "line-2", "panel", "panel-2", "raise", "bg"]);
const PAL = ["acc", "amber", "violet", "cyan", "up", "down", "tx-2"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MINUS = "−";

const col = (c, d = "tx-2") => { c = c || d; return TOKENS.has(c) ? `var(--${c})` : String(c).startsWith("--") ? `var(${c})` : String(c); };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ok = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const R = v => Math.round(v * 10) / 10;
const hair = v => Math.round(v) + 0.5;                      // centre of a device pixel: crisp 1px lines
const tw = (s, fs = 9.5) => String(s).length * fs * 0.62;   // label width budget in the mono font
const dashOf = d => (d === true ? "4 3" : Array.isArray(d) ? d.join(" ") : d ? String(d) : "");

// ---------- numbers and dates ----------

function fixed(v, dp) {
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (v < 0 && /[1-9]/.test(s) ? MINUS : "") + s;
}
function compact(v) {
  const a = Math.abs(v), [d, u] = a >= 1e12 ? [1e12, "T"] : a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : [1, ""];
  const x = a / d, s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
  return (v < 0 && a > 0 ? MINUS : "") + (s.includes(".") ? s.replace(/\.?0+$/, "") : s) + u;
}
function stepDp(step) {
  for (let d = 0; d < 8; d++) { const x = step * 10 ** d; if (Math.abs(x - Math.round(x)) < 1e-6 * Math.max(1, x)) return d; }
  return 8;
}
const autoFmt = (step, top) => (top >= 1e5 ? compact : (dp => v => fixed(v, dp))(stepDp(step)));
const tipFmt = (step, top) => (top >= 1e5 ? compact : (dp => v => fixed(v, dp))(Math.min(6, stepDp(step) + 2)));
const plain = v => fixed(v, Math.min(4, stepDp(Math.abs(v) || 1)));

function niceTicks(lo, hi, n) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(1, n), p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  const st = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p, out = [];
  for (let i = Math.ceil(lo / st - 1e-9); i * st <= hi + st * 1e-9; i++) out.push(+(i * st).toPrecision(12));
  return out;
}

const dnum = v => {
  if (typeof v === "number") return v;
  const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(v || "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5 : NaN;
};
const dstr = n => new Date(Math.round(n) * 864e5).toISOString().slice(0, 10);
const dparts = n => { const d = new Date(Math.round(n) * 864e5); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), w: d.getUTCDay() }; };
const dshort = n => { const p = dparts(n); return `${MON[p.m]} ${p.d}`; };
const dlong = n => { const p = dparts(n); return `${MON[p.m]} ${p.d}, ${p.y}`; };

function dateTicks(lo, hi, maxN) {
  const span = hi - lo, out = [];
  if (!(span > 0)) return [{ v: lo, label: dshort(lo) }];
  const ds = [1, 2, 7, 14].find(s => span / s <= maxN);
  if (ds && span <= 100) {
    let v = Math.ceil(lo);
    if (ds >= 7) while (dparts(v).w !== 1) v++;          // weekly ticks sit on Mondays
    for (; v <= hi; v += ds) out.push({ v, label: dshort(v) });
    return out;
  }
  const ms = [1, 2, 3, 6, 12, 24, 60].find(s => span / 30.44 / s <= maxN) || 120, a = dparts(Math.ceil(lo));
  let abs = Math.ceil((a.y * 12 + a.m + (a.d > 1 ? 1 : 0)) / ms) * ms;
  for (; ; abs += ms) {
    const y = Math.floor(abs / 12), m = abs % 12, v = Date.UTC(y, m, 1) / 864e5;
    if (v > hi) break;
    out.push({ v, label: m === 0 ? String(y) : MON[m] });
  }
  return out;
}

// ---------- shared drawing ----------

/** Value range → padded axis range. Data that never goes below zero keeps its axis at or above zero. */
function yRange(lo, hi, yo = {}, pad = 0.07) {
  if (yo.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (lo === hi) { const d = Math.abs(lo) * 0.05 || 1; lo -= d; hi += d; }
  const p = (hi - lo) * pad;
  let a = lo - p, b = hi + p;
  if (lo >= 0 && a < 0) a = 0;
  if (hi <= 0 && b > 0) b = 0;
  if (ok(yo.min)) a = yo.min;
  if (ok(yo.max)) b = yo.max;
  if (!(b > a)) b = a + 1;
  return [a, b];
}

function yAxis(lo, hi, len, yo = {}, per = 38) {
  const want = ok(yo.ticks) ? yo.ticks : clamp(Math.floor(len / per), 2, 8);
  const vals = Array.isArray(yo.ticks) ? yo.ticks.filter(v => ok(v) && v >= lo && v <= hi) : niceTicks(lo, hi, want);
  const st = vals.length > 1 ? Math.abs(vals[1] - vals[0]) : (hi - lo) || 1, top = Math.max(Math.abs(lo), Math.abs(hi));
  const fmt = yo.fmt || autoFmt(st, top);
  return { ticks: vals.map(v => ({ v, label: String(fmt(v)) })), fmt, tip: yo.fmt || tipFmt(st, top) };
}

function xAxis(type, lo, hi, len, xo = {}, cats = []) {
  if (type === "date") {
    const f = xo.fmt ? v => String(xo.fmt(dstr(v))) : null;
    const tk = Array.isArray(xo.ticks) ? xo.ticks.map(dnum).filter(v => v >= lo && v <= hi).map(v => ({ v, label: dshort(v) }))
      : dateTicks(lo, hi, ok(xo.ticks) ? xo.ticks : clamp(Math.floor(len / 64), 2, 12));
    if (f) tk.forEach(k => { k.label = f(k.v); });
    return { ticks: tk, tip: f || dlong };
  }
  if (type === "cat") {
    const f = v => { const c = cats[Math.round(v)]; return c == null ? "" : String(xo.fmt ? xo.fmt(c) : c); }, tk = [];
    for (let i = Math.ceil(lo); i <= hi; i++) tk.push({ v: i, label: f(i) });
    return { ticks: tk, tip: f };
  }
  const vals = Array.isArray(xo.ticks) ? xo.ticks.filter(v => ok(v) && v >= lo && v <= hi) : niceTicks(lo, hi, ok(xo.ticks) ? xo.ticks : clamp(Math.floor(len / 72), 2, 10));
  const st = vals.length > 1 ? Math.abs(vals[1] - vals[0]) : (hi - lo) || 1, fmt = xo.fmt || autoFmt(st, Math.max(Math.abs(lo), Math.abs(hi)));
  return { ticks: vals.map(v => ({ v, label: String(fmt(v)) })), tip: xo.fmt || plain };
}

/** Bottom tick labels. Evenly spaced ticks are thinned by a regular stride, uneven ones greedily, so labels
    never overlap; the end labels are pulled inside the chart instead of being clipped. */
function xLabels(ticks, X, y, W, even = true, gap = 10) {
  const it = ticks.map(k => ({ x: X(k.v), w: tw(k.label), label: k.label })).filter(k => k.label !== "");
  let keep = it;
  if (even && it.length > 1) {
    let mw = 0, md = Infinity;
    it.forEach((k, i) => { mw = Math.max(mw, k.w); if (i) md = Math.min(md, Math.abs(k.x - it[i - 1].x)); });
    const n = Math.max(1, Math.ceil((mw + gap) / Math.max(md, 1e-6)));
    keep = it.filter((_, i) => i % n === 0);
  } else if (!even) {
    let edge = -Infinity;
    keep = it.filter(k => { if (k.x - k.w / 2 < edge + gap) return false; edge = k.x + k.w / 2; return true; });
  }
  return keep.map(k => `<text class="ch-tk" x="${R(clamp(k.x, k.w / 2 + 1, W - k.w / 2 - 1))}" y="${y}" text-anchor="middle">${esc(k.label)}</text>`).join("");
}

const hline = (x0, x1, y, cls, style = "") => `<line class="${cls}" x1="${R(x0)}" x2="${R(x1)}" y1="${hair(y)}" y2="${hair(y)}"${style}/>`;
const vline = (x, y0, y1, cls, style = "") => `<line class="${cls}" x1="${hair(x)}" x2="${hair(x)}" y1="${R(y0)}" y2="${R(y1)}"${style}/>`;
const stroke = (c, dash) => ` style="stroke:${c}"${dash ? ` stroke-dasharray="${dash}"` : ""}`;

/** The plot box, grid, tick labels and axis titles of a cartesian chart. f = { l, t, pw, ph, W, H }. */
function frame(f, X, Y, xt, yt, o = {}) {
  const { l, t, pw, ph, W } = f, r = l + pw, b = t + ph;
  let s = "";
  for (const k of yt) { const y = Y(k.v); if (y >= t - 0.5 && y <= b + 0.5) s += hline(l, r, y, "ch-grid"); }
  if (o.vgrid !== false) for (const k of xt) { const x = X(k.v); if (x >= l - 0.5 && x <= r + 0.5) s += vline(x, t, b, "ch-grid"); }
  s += hline(l, r, b, "ch-axis");
  const right = o.side === "right";
  for (const k of yt) {
    const y = Y(k.v);
    if (y < t - 0.5 || y > b + 0.5) continue;
    s += `<text class="ch-tk" x="${right ? r + 6 : l - 6}" y="${R(y + 3.2)}" text-anchor="${right ? "start" : "end"}">${esc(k.label)}</text>`;
  }
  s += xLabels(xt, X, b + 13.5, W, o.even !== false);
  if (o.ylabel) s += `<text class="ch-axl" x="${right ? W - 2 : 2}" y="${t - 8}" text-anchor="${right ? "end" : "start"}">${esc(o.ylabel)}</text>`;
  if (o.xlabel) s += `<text class="ch-axl" x="${R(l + pw / 2)}" y="${b + 27}" text-anchor="middle">${esc(o.xlabel)}</text>`;
  return s;
}

/** Vertical marker lines with labels along the top; labels that would collide drop to the next row. */
function vmarks(marks, X, f, def = "mut") {
  const rows = [];
  let s = "";
  for (const m of [...marks].sort((a, b) => a.px - b.px)) {
    if (!(m.px >= f.l - 0.5 && m.px <= f.l + f.pw + 0.5)) continue;
    const c = col(m.color, def);
    s += vline(m.px, f.t, f.t + f.ph, "ch-mark", stroke(c, dashOf(m.dash ?? true)));
    if (!m.label) continue;
    const w = tw(m.label), flip = m.px + 5 + w > f.l + f.pw, x0 = flip ? m.px - 5 - w : m.px + 5;
    let row = 0;
    while (rows[row] && rows[row].some(([a, b]) => x0 < b + 6 && x0 + w > a - 6)) row++;
    (rows[row] = rows[row] || []).push([x0, x0 + w]);
    s += `<text class="ch-ml" x="${R(flip ? m.px - 5 : m.px + 5)}" y="${f.t + 10 + row * 11}" text-anchor="${flip ? "end" : "start"}" style="fill:${c}">${esc(m.label)}</text>`;
  }
  return s;
}

function hmarksSvg(marks, Y, f, def = "mut") {
  let s = "";
  for (const m of marks || []) {
    if (!ok(m.y)) continue;
    const y = Y(m.y), c = col(m.color, def);
    if (y < f.t - 0.5 || y > f.t + f.ph + 0.5) continue;
    s += hline(f.l, f.l + f.pw, y, "ch-mark", stroke(c, dashOf(m.dash ?? true)));
    if (m.label) s += `<text class="ch-ml" x="${f.l + f.pw - 4}" y="${R(y - 4 < f.t + 9 ? y + 11 : y - 4)}" text-anchor="end" style="fill:${c}">${esc(m.label)}</text>`;
  }
  return s;
}

function bandsSvg(bands, toPx, f) {
  let s = "";
  for (const bd of bands || []) {
    const a = toPx(bd.x0), c = toPx(bd.x1);
    if (!ok(a) || !ok(c)) continue;
    const x0 = clamp(Math.min(a, c), f.l, f.l + f.pw), x1 = clamp(Math.max(a, c), f.l, f.l + f.pw);
    if (x1 - x0 < 0.5) continue;
    s += `<rect x="${R(x0)}" y="${f.t}" width="${R(x1 - x0)}" height="${f.ph}" style="fill:${col(bd.color, "amber")};opacity:${bd.opacity ?? 0.08}"/>`;
    if (bd.label) s += `<text class="ch-ml" x="${R((x0 + x1) / 2)}" y="${f.t + f.ph - 5}" text-anchor="middle" style="fill:${col(bd.color, "amber")}">${esc(bd.label)}</text>`;
  }
  return s;
}

function pathOf(P, X, Y, step) {
  let d = "", pen = false;
  for (const [x, y] of P) {
    if (y == null) { pen = false; continue; }
    const a = R(X(x)), b = R(Y(y));
    d += pen ? (step ? `H${a}V${b}` : `L${a} ${b}`) : `M${a} ${b}`;
    pen = true;
  }
  return d;
}
function areaOf(P, X, Y, base, step) {
  let d = "", start = null, lastX = 0;
  const close = () => { if (start != null) d += `V${R(base)}H${start}Z`; start = null; };
  for (const [x, y] of P) {
    if (y == null) { close(); continue; }
    const a = R(X(x)), b = R(Y(y));
    if (start == null) { d += `M${a} ${b}`; start = a; } else d += step ? `H${a}V${b}` : `L${a} ${b}`;
    lastX = a;
  }
  close();
  return d;
}

/** y of a sorted series at x: the point itself, or a straight line between its neighbours (the left one for steps). */
function valAt(P, x, step) {
  let lo = 0, hi = P.length - 1;
  if (hi < 0 || x < P[0][0] || x > P[hi][0]) return null;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m][0] <= x) lo = m; else hi = m; }
  const a = P[lo], b = P[hi];
  if (x === b[0]) return b[1];
  if (x === a[0] || step) return a[1];
  if (a[1] == null || b[1] == null) return null;
  return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
}
function nearX(P, x) {
  let lo = 0, hi = P.length - 1;
  if (hi < 0) return null;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m][0] <= x) lo = m; else hi = m; }
  return Math.abs(P[lo][0] - x) <= Math.abs(P[hi][0] - x) ? P[lo][0] : P[hi][0];
}

const tipHtml = (head, rows) => (head ? `<div class="ch-th">${esc(head)}</div>` : "")
  + rows.map(r => `<div class="ch-tr"><i${r.c ? ` style="background:${r.c}"` : ""}></i><span>${esc(r.name || "")}</span><b${r.cls ? ` class="${r.cls}"` : ""}>${esc(r.val)}</b></div>`).join("");
const legHtml = items => items.map(i => `<span class="ch-lg"><i class="${i.block ? "blk" : i.dash ? "dsh" : ""}" style="color:${i.c}"></i>${esc(i.name)}</span>`).join("");
const dotSvg = (x, y, c) => `<circle class="ch-dot" cx="${R(x)}" cy="${R(y)}" r="3" style="fill:${c}"/>`;

// ---------- the mount: one per container ----------

const live = new WeakMap();
let uid = 0;

function mount(el, opts, kind) {
  if (!el) return { update() {}, destroy() {} };
  live.get(el)?.destroy();
  const id = ++uid, root = document.createElement("div");
  root.className = "ch";
  root.innerHTML = '<div class="ch-leg" hidden></div><div class="ch-plot"></div><div class="ch-tip" hidden></div>';
  el.replaceChildren(root);
  const [leg, plot, tip] = root.children;
  let o = opts || {}, scene = null, hov = null, W = -1, HB = -1, raf = 0, hraf = 0, at = null, key = null, tipW = 0, tipH = 0, dead = false;

  const hide = () => { if (key !== null) { key = null; if (hov) hov.innerHTML = ""; tip.hidden = true; } };
  const render = () => {
    raf = 0;
    if (dead) return;
    const fill = o.h === "fill";
    root.classList.toggle("ch-fill", fill);
    W = Math.floor(root.clientWidth); HB = fill ? Math.floor(root.clientHeight) : -1;
    scene = null; hov = null; key = null; tip.hidden = true;
    if (W < 40 || (fill && HB < 40)) { plot.innerHTML = ""; return; }      // hidden or not laid out yet: the observer calls back
    let lg = "";
    try { lg = kind.legend && o.legend !== false ? kind.legend(o) : ""; } catch (e) { lg = ""; }
    leg.innerHTML = lg; leg.hidden = !lg;
    let H = 220;
    try {
      const total = fill ? HB : kind.height ? kind.height(o, W) : +o.h || 220;
      H = Math.max(40, Math.round(total - (lg ? leg.offsetHeight : 0)));
      scene = kind.draw(o, W, H, id);
    } catch (e) { console.error("chart:", e); scene = null; }
    if (!scene) { plot.innerHTML = `<div class="ch-empty" style="height:${Math.min(H, 220)}px">${esc(o.empty || "No data")}</div>`; return; }
    plot.innerHTML = `<svg class="ch-svg${scene.click ? " ch-click" : ""}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">${scene.svg}<g class="ch-hov"></g></svg>`;
    hov = plot.firstChild.lastChild;
  };
  const schedule = () => { if (!raf && !dead) raf = requestAnimationFrame(render); };
  const local = (x, y) => { const r = plot.getBoundingClientRect(); return [x - r.left, y - r.top]; };
  const hover = () => {
    hraf = 0;
    if (dead || !at || !scene || !scene.hover || !hov || o.hover === false) return hide();
    const [px, py] = local(at[0], at[1]);
    let hit = null;
    try { hit = scene.hover(px, py); } catch (e) { hit = null; }
    if (!hit) return hide();
    if (hit.key !== key) {                       // content changes only when the nearest point does: no flicker
      key = hit.key; hov.innerHTML = hit.svg || ""; tip.innerHTML = hit.html || ""; tip.hidden = !hit.html;
      if (hit.html) { tipW = tip.offsetWidth; tipH = tip.offsetHeight; }
    }
    if (!hit.html) return;
    let x = hit.tx + 14;
    if (x + tipW > W - 2) x = hit.tx - 14 - tipW;
    const y = clamp((hit.ty ?? py) - tipH / 2, 2, Math.max(2, plot.offsetHeight - tipH - 2)) + plot.offsetTop;
    tip.style.transform = `translate(${Math.round(clamp(x, 2, Math.max(2, W - tipW - 2)))}px,${Math.round(y)}px)`;
  };
  const onMove = e => { at = [e.clientX, e.clientY]; if (!hraf) hraf = requestAnimationFrame(hover); };
  const onLeave = () => { at = null; hide(); };
  const onClick = e => { if (scene && scene.click) { const [px, py] = local(e.clientX, e.clientY); try { scene.click(px, py); } catch (err) { console.error("chart:", err); } } };
  plot.addEventListener("pointermove", onMove);
  plot.addEventListener("pointerleave", onLeave);
  plot.addEventListener("click", onClick);
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    if (Math.floor(root.clientWidth) !== W || (o.h === "fill" && Math.floor(root.clientHeight) !== HB)) schedule();
  }) : null;
  if (ro) ro.observe(root);

  const api = {
    update(next) { if (dead) return api; o = { ...o, ...(next || {}) }; cancelAnimationFrame(raf); render(); return api; },
    destroy() {
      if (dead) return;
      dead = true;
      if (ro) ro.disconnect();
      cancelAnimationFrame(raf); cancelAnimationFrame(hraf);
      plot.removeEventListener("pointermove", onMove);
      plot.removeEventListener("pointerleave", onLeave);
      plot.removeEventListener("click", onClick);
      if (live.get(el) === api) live.delete(el);
      root.remove();
    },
  };
  live.set(el, api);
  render();
  return api;
}

// ---------- line ----------

const LINE = {
  legend(o) {
    const named = (o.series || []).filter(s => s && s.name);
    if (!(o.legend ?? named.length > 1) || !named.length) return "";
    const it = [];
    (o.series || []).forEach((s, i) => { if (s && s.name) it.push({ name: s.name, c: col(s.color, PAL[i % PAL.length]), dash: !!s.dash }); });
    (o.ribbons || []).forEach(r => { if (r && r.name) it.push({ name: r.name, c: col(r.color, "acc"), block: true }); });
    return legHtml(it);
  },
  draw(o, W, H, id) {
    const xo = o.x || {}, yo = o.y || {}, type = xo.type || "num", cats = xo.cats || [];
    const toX = type === "date" ? dnum : type === "cat" ? v => (typeof v === "number" ? v : cats.indexOf(v)) : v => v;
    const conv = pts => (pts || []).filter(p => p && ok(toX(p[0])) && (type !== "cat" || toX(p[0]) >= 0)).map(p => [toX(p[0]), ok(p[1]) ? p[1] : null]).sort((a, b) => a[0] - b[0]);
    const ser = (o.series || []).filter(Boolean).map((s, i) => ({ ...s, P: conv(s.pts), c: col(s.color, PAL[i % PAL.length]) }));
    const rib = (o.ribbons || []).filter(Boolean).map(r => ({ ...r, L: conv(r.lo), U: conv(r.hi), c: col(r.color, "acc") }));
    let x0 = Infinity, x1 = -Infinity, lo = Infinity, hi = -Infinity;
    const see = P => { for (const [x, y] of P) if (y != null) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < lo) lo = y; if (y > hi) hi = y; } };
    ser.forEach(s => see(s.P)); rib.forEach(r => { see(r.L); see(r.U); });
    if (!(hi >= lo)) return null;
    for (const m of o.hmarks || []) if (ok(m.y)) { lo = Math.min(lo, m.y); hi = Math.max(hi, m.y); }
    if (type === "cat" && cats.length) { x0 = 0; x1 = cats.length - 1; }
    if (xo.min != null && ok(toX(xo.min))) x0 = toX(xo.min);
    if (xo.max != null && ok(toX(xo.max))) x1 = toX(xo.max);
    if (!(x1 > x0)) { x0 -= 0.5; x1 += 0.5; }
    const [y0, y1] = yRange(lo, hi, yo);
    const t = 10 + (yo.label ? 12 : 0), ph = H - t - 22 - (xo.label ? 13 : 0);
    const ya = yAxis(y0, y1, ph, yo), l = Math.max(26, Math.ceil(Math.max(0, ...ya.ticks.map(k => tw(k.label)))) + 12), pw = W - l - 14;
    if (pw < 30 || ph < 30) return null;
    const f = { l, t, pw, ph, W, H }, X = v => l + (v - x0) / (x1 - x0) * pw, Y = v => t + (y1 - v) / (y1 - y0) * ph;
    const xa = xAxis(type, x0, x1, pw, xo, cats);

    let s = `<clipPath id="chk${id}"><rect x="${l - 4}" y="${t - 4}" width="${pw + 8}" height="${ph + 8}"/></clipPath>`;
    s += bandsSvg(o.bands, v => X(toX(v)), f);
    s += frame(f, X, Y, xa.ticks, ya.ticks, { xlabel: xo.label, ylabel: yo.label });
    if (y0 < 0 && y1 > 0) s += hline(l, l + pw, Y(0), "ch-zero");
    s += `<g clip-path="url(#chk${id})">`;
    for (const r of rib) {
      const up = r.U.filter(p => p[1] != null), dn = r.L.filter(p => p[1] != null).reverse();
      if (up.length < 2 || dn.length < 2) continue;
      s += `<path d="M${up.concat(dn).map(p => `${R(X(p[0]))} ${R(Y(p[1]))}`).join("L")}Z" style="fill:${r.c};opacity:${r.opacity ?? 0.13}"/>`;
    }
    const base = Y(clamp(0, y0, y1));
    for (const q of ser) if (q.area) s += `<path d="${areaOf(q.P, X, Y, base, q.step)}" style="fill:${q.c};opacity:${ok(q.area) ? q.area : 0.12}"/>`;
    for (const q of ser) {
      const d = pathOf(q.P, X, Y, q.step);
      if (d) s += `<path class="ch-ln" d="${d}" style="stroke:${q.c};stroke-width:${q.width || 1.5}"${q.dash ? ` stroke-dasharray="${dashOf(q.dash)}"` : ""}/>`;
      const pts = q.P.filter(p => p[1] != null);
      if (q.dots === true && pts.length <= 400) s += pts.map(p => `<circle cx="${R(X(p[0]))}" cy="${R(Y(p[1]))}" r="2" style="fill:${q.c}"/>`).join("");
      if (q.dots === "last" && pts.length) { const p = pts[pts.length - 1]; s += dotSvg(X(p[0]), Y(p[1]), q.c); }
    }
    s += "</g>";
    s += hmarksSvg(o.hmarks, Y, f);
    s += vmarks((o.marks || []).map(m => ({ ...m, px: X(toX(m.x)) })).filter(m => ok(m.px)), X, f);

    const back = v => (type === "date" ? dstr(v) : type === "cat" ? cats[Math.round(v)] ?? Math.round(v) : v);
    const snap = px => {
      const xv = x0 + (px - l) / pw * (x1 - x0);
      let sx = null, best = Infinity;
      for (const q of ser) { const n = nearX(q.P, xv); if (n != null && Math.abs(n - xv) < best) { best = Math.abs(n - xv); sx = n; } }
      if (sx == null) for (const r of rib) { const n = nearX(r.U, xv); if (n != null && Math.abs(n - xv) < best) { best = Math.abs(n - xv); sx = n; } }
      return sx;
    };
    const inside = (px, py) => px >= l - 8 && px <= l + pw + 8 && py >= t - 8 && py <= t + ph + 8;
    return {
      svg: s,
      hover(px, py) {
        if (!inside(px, py)) return null;
        const sx = snap(px);
        if (sx == null) return null;
        const cx = X(sx), items = [], rows = [];
        let dots = "";
        for (const q of ser) {
          const y = valAt(q.P, sx, q.step);
          if (y == null) continue;
          items.push({ name: q.name, color: q.c, y });
          rows.push({ name: q.name || yo.label || "", c: q.c, val: ya.tip(y) });
          if (y >= y0 && y <= y1) dots += dotSvg(cx, Y(y), q.c);
        }
        for (const r of rib) {
          if (!r.name) continue;
          const a = valAt(r.L, sx), b = valAt(r.U, sx);
          if (a != null && b != null) rows.push({ name: r.name, c: r.c, val: `${ya.tip(a)} – ${ya.tip(b)}` });
        }
        const html = typeof o.hover === "function" ? o.hover({ x: back(sx), label: xa.tip(sx), items }) : tipHtml(xa.tip(sx), rows);
        return { key: sx, svg: vline(cx, t, t + ph, "ch-cross") + dots, html, tx: cx, ty: py };
      },
      click: o.onClick ? (px, py) => { if (inside(px, py)) { const sx = snap(px); if (sx != null) o.onClick(back(sx)); } } : null,
    };
  },
};

// ---------- scatter ----------

const SCATTER = {
  draw(o, W, H) {
    const xo = o.x || {}, yo = o.y || {};
    const pts = (o.pts || []).filter(p => p && ok(p.x) && ok(p.y));
    if (!pts.length) return null;
    let a0 = Math.min(...pts.map(p => p.x)), a1 = Math.max(...pts.map(p => p.x)), b0 = Math.min(...pts.map(p => p.y)), b1 = Math.max(...pts.map(p => p.y));
    if (o.diag) { a0 = b0 = Math.min(a0, b0); a1 = b1 = Math.max(a1, b1); }      // one range on both axes: the diagonal runs corner to corner
    const [x0, x1] = yRange(a0, a1, xo, 0.08), [y0, y1] = yRange(b0, b1, yo, 0.08);
    const t = 10 + (yo.label ? 12 : 0), ph = H - t - 22 - (xo.label ? 13 : 0);
    const ya = yAxis(y0, y1, ph, yo), l = Math.max(26, Math.ceil(Math.max(0, ...ya.ticks.map(k => tw(k.label)))) + 12), pw = W - l - 14;
    if (pw < 30 || ph < 30) return null;
    const f = { l, t, pw, ph, W, H }, X = v => l + (v - x0) / (x1 - x0) * pw, Y = v => t + (y1 - v) / (y1 - y0) * ph;
    const xa = xAxis("num", x0, x1, pw, xo);
    let s = frame(f, X, Y, xa.ticks, ya.ticks, { xlabel: xo.label, ylabel: yo.label });
    if (o.diag) {
      const d0 = Math.max(x0, y0), d1 = Math.min(x1, y1);
      if (d1 > d0) s += `<line class="ch-diag" x1="${R(X(d0))}" y1="${R(Y(d0))}" x2="${R(X(d1))}" y2="${R(Y(d1))}"/>`;
      if (typeof o.diag === "string" && d1 > d0) s += `<text class="ch-ml" x="${R(X(d1) - 6)}" y="${R(Y(d1) + 14)}" text-anchor="end">${esc(o.diag)}</text>`;
    }
    const P = pts.map(p => ({ p, x: X(p.x), y: Y(p.y), r: ok(p.r) ? p.r : 3.2, c: col(p.color, "acc") }));
    s += P.map(q => `<circle class="ch-pt" cx="${R(q.x)}" cy="${R(q.y)}" r="${q.r}" style="fill:${q.c}"/>`).join("");
    if (o.labels ?? P.length <= 80) {
      // Try the eight spots around each point and take the first that hits no other label or point; a point
      // with no free spot goes unlabelled (the tooltip still names it).
      const boxes = P.map(q => [q.x - q.r - 1, q.y - q.r - 1, q.x + q.r + 1, q.y + q.r + 1]), free = b => !boxes.some(o2 => b[0] < o2[2] && b[2] > o2[0] && b[1] < o2[3] && b[3] > o2[1]);
      for (const q of P) {
        if (!q.p.label) continue;
        const w = tw(q.p.label, 9.5), g = q.r + 3, hh = 10;
        const spots = [[g, -hh / 2], [-g - w, -hh / 2], [-w / 2, -g - hh], [-w / 2, g], [g - 1, -g - hh + 3], [g - 1, g - 3], [-g - w + 1, -g - hh + 3], [-g - w + 1, g - 3]];
        for (const [dx, dy] of spots) {
          const bx = [q.x + dx, q.y + dy, q.x + dx + w, q.y + dy + hh];
          if (bx[0] < l + 1 || bx[2] > l + pw - 1 || bx[1] < t + 1 || bx[3] > t + ph - 1 || !free(bx)) continue;
          boxes.push(bx);
          s += `<text class="ch-pl" x="${R(bx[0])}" y="${R(bx[1] + 8.5)}">${esc(q.p.label)}</text>`;
          break;
        }
      }
    }
    const pick = (px, py) => {
      let best = null, bd = 26 * 26;
      for (const q of P) { const d = (q.x - px) ** 2 + (q.y - py) ** 2; if (d < bd) { bd = d; best = q; } }
      return best;
    };
    return {
      svg: s,
      hover(px, py) {
        const q = pick(px, py);
        if (!q) return null;
        const rows = [{ name: xo.label || "x", val: xa.tip(q.p.x) }, { name: yo.label || "y", val: ya.tip(q.p.y) }];
        const html = typeof o.hover === "function" ? o.hover(q.p) : tipHtml(q.p.label, rows);
        return { key: P.indexOf(q), svg: vline(q.x, t, t + ph, "ch-cross") + hline(l, l + pw, q.y, "ch-cross") + `<circle class="ch-ring" cx="${R(q.x)}" cy="${R(q.y)}" r="${q.r + 3}" style="stroke:${q.c}"/>`, html, tx: q.x, ty: q.y };
      },
      click: o.onClick ? (px, py) => { const q = pick(px, py); if (q) o.onClick(q.p); } : null,
    };
  },
};

// ---------- bars ----------

const cut = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

const BARS = {
  legend(o) {
    const ser = (o.series || []).filter(s => s && s.name);
    return (o.legend ?? ser.length > 1) && ser.length ? legHtml((o.series || []).map((s, i) => ({ name: s.name, c: col(s.color, PAL[i % PAL.length]), block: true })).filter(i => i.name)) : "";
  },
  height(o) {
    if (o.h) return +o.h;
    if (!o.horizontal) return 220;
    const n = (o.cats || []).length, ns = o.stacked ? 1 : Math.max(1, (o.series || []).length);
    return 36 + n * Math.max(18, 9 * ns + 7) + ((o.series || []).length > 1 ? 22 : 0);
  },
  draw(o, W, H) {
    const cats = o.cats || [], yo = o.y || {}, n = cats.length, hz = !!o.horizontal;
    const ser = (o.series || []).filter(Boolean).map((s, i) => ({ ...s, c: col(s.color, PAL[i % PAL.length]), v: cats.map((_, j) => (ok((s.vals || [])[j]) ? s.vals[j] : null)) }));
    if (!n || !ser.some(s => s.v.some(v => v != null))) return null;
    let lo = 0, hi = 0;
    for (let j = 0; j < n; j++) {
      if (o.stacked) { let p = 0, m = 0; for (const s of ser) { const v = s.v[j] || 0; if (v > 0) p += v; else m += v; } lo = Math.min(lo, m); hi = Math.max(hi, p); }
      else for (const s of ser) if (s.v[j] != null) { lo = Math.min(lo, s.v[j]); hi = Math.max(hi, s.v[j]); }
    }
    const [v0, v1] = yRange(lo, hi, { ...yo, zero: true }, 0.06);
    const labW = hz ? Math.min(120, Math.ceil(Math.max(...cats.map(c => tw(cut(c, 18)))))) : 0;
    const t = 10 + (yo.label ? 12 : 0), ph = H - t - 22;
    const va = yAxis(v0, v1, hz ? W - labW - 30 : ph, yo, hz ? 74 : 38);
    const l = hz ? labW + 12 : Math.max(26, Math.ceil(Math.max(0, ...va.ticks.map(k => tw(k.label)))) + 12), pw = W - l - 14;
    if (pw < 30 || ph < 20) return null;
    const f = { l, t, pw, ph, W, H }, band = (hz ? ph : pw) / n, ns = o.stacked ? 1 : ser.length;
    const V = hz ? v => l + (v - v0) / (v1 - v0) * pw : v => t + (v1 - v) / (v1 - v0) * ph;
    const inner = Math.min(band * 0.74, ns * 26 + (ns - 1)), bw = Math.max(1, (inner - (ns - 1)) / ns), zero = V(0);
    let s = "";
    if (hz) {
      for (const k of va.ticks) s += vline(V(k.v), t, t + ph, "ch-grid");
      s += xLabels(va.ticks, V, t + ph + 13.5, W);
      const every = Math.max(1, Math.ceil(12 / band));
      cats.forEach((c, j) => { if (j % every === 0) s += `<text class="ch-tk ch-cat" x="${l - 7}" y="${R(t + (j + 0.5) * band + 3.2)}" text-anchor="end">${esc(cut(c, 18))}</text>`; });
    } else {
      for (const k of va.ticks) s += hline(l, l + pw, V(k.v), "ch-grid");
      for (const k of va.ticks) s += `<text class="ch-tk" x="${l - 6}" y="${R(V(k.v) + 3.2)}" text-anchor="end">${esc(k.label)}</text>`;
      s += xLabels(cats.map((c, j) => ({ v: j, label: cut(c, 12) })), j => l + (j + 0.5) * band, t + ph + 13.5, W);
      if (yo.label) s += `<text class="ch-axl" x="2" y="${t - 8}">${esc(yo.label)}</text>`;
    }
    const rect = (j, k, a, b, c) => {                       // one bar of category j, slot k, from value a to value b
      const p0 = V(a), p1 = V(b), at = (hz ? t : l) + j * band + (band - inner) / 2 + k * (bw + 1), len = Math.max(Math.abs(p1 - p0), a === b ? 0 : 1);
      return hz ? `<rect x="${R(Math.min(p0, p1))}" y="${R(at)}" width="${R(len)}" height="${R(bw)}" style="fill:${c}"/>`
        : `<rect x="${R(at)}" y="${R(Math.min(p0, p1))}" width="${R(bw)}" height="${R(len)}" style="fill:${c}"/>`;
    };
    s += '<g class="ch-bars">';
    for (let j = 0; j < n; j++) {
      let up = 0, dn = 0;
      ser.forEach((q, k) => {
        const v = q.v[j];
        if (v == null || v === 0) return;
        if (o.stacked) { const a = v > 0 ? up : dn; if (v > 0) up += v; else dn += v; s += rect(j, 0, a, a + v, q.c); }
        else s += rect(j, k, 0, v, q.c);
      });
    }
    s += "</g>";
    s += hz ? vline(zero, t, t + ph, v0 < 0 ? "ch-zero" : "ch-axis") : hline(l, l + pw, zero, v0 < 0 ? "ch-zero" : "ch-axis");
    const idx = (px, py) => { const j = Math.floor(((hz ? py - t : px - l)) / band); return px >= l - 4 && px <= l + pw + 4 && py >= t && py <= t + ph && j >= 0 && j < n ? j : -1; };
    return {
      svg: s,
      hover(px, py) {
        const j = idx(px, py);
        if (j < 0) return null;
        const rows = ser.filter(q => q.v[j] != null).map(q => ({ name: q.name || "", c: q.c, val: va.tip(q.v[j]) }));
        if (o.stacked && rows.length > 1) rows.push({ name: "Total", val: va.tip(ser.reduce((a, q) => a + (q.v[j] || 0), 0)) });
        const box = hz ? `<rect class="ch-band" x="${l}" y="${R(t + j * band)}" width="${pw}" height="${R(band)}"/>` : `<rect class="ch-band" x="${R(l + j * band)}" y="${t}" width="${R(band)}" height="${ph}"/>`;
        return { key: j, svg: box, html: tipHtml(cats[j], rows), tx: hz ? px : l + (j + 0.5) * band, ty: hz ? t + (j + 0.5) * band : py };
      },
      click: o.onClick ? (px, py) => { const j = idx(px, py); if (j >= 0) o.onClick(cats[j], j); } : null,
    };
  },
};

// ---------- heat ----------

const HEAT_TOP = 18;
const HEAT = {
  height(o) { return HEAT_TOP + (o.rows || []).length * (o.cellH || 22) + 1; },
  draw(o, W, H) {
    const rows = o.rows || [], cols = o.cols || [], z = o.z || [], nr = rows.length, nc = cols.length;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) { const v = (z[i] || [])[j]; if (ok(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    if (!nr || !nc || !(hi >= lo)) return null;
    if (ok(o.min)) lo = o.min;
    if (ok(o.max)) hi = o.max;
    const div = o.scale === "div", mid = ok(o.mid) ? o.mid : 0, span = div ? Math.max(hi - mid, mid - lo) || 1 : (hi - lo) || 1;
    const fmt = o.fmt || plain, ch = o.cellH || 22;
    const rowW = ok(o.rowW) ? o.rowW : Math.min(120, Math.ceil(Math.max(...rows.map(r => tw(cut(r, 18))))) + 14), cw = (W - rowW - 1) / nc;
    if (cw < 3) return null;
    const pos = col(o.colors?.[1], "up"), neg = col(o.colors?.[0], "down"), one = col(o.color, "acc");
    // Shades stop at 58% of the theme colour over the panel, so the normal text colour stays readable on every cell.
    const shade = v => {
      const u = clamp(div ? Math.abs(v - mid) / span : (v - lo) / span, 0, 1), c = div ? (v >= mid ? pos : neg) : one;
      return `color-mix(in srgb,${c} ${R(4 + 54 * u)}%,var(--panel-2))`;
    };
    let s = xLabels(cols.map((c, j) => ({ v: j, label: String(c) })), j => rowW + (j + 0.5) * cw, 11, W, true, 8);
    const everyRow = Math.max(1, Math.ceil(11 / ch));
    let cells = "", text = "";
    for (let i = 0; i < nr; i++) {
      const y = HEAT_TOP + i * ch;
      if (i % everyRow === 0) s += `<text class="ch-tk ch-cat" x="${rowW - 8}" y="${R(y + ch / 2 + 3.2)}" text-anchor="end">${esc(cut(rows[i], 18))}</text>`;
      for (let j = 0; j < nc; j++) {
        const v = (z[i] || [])[j], x = rowW + j * cw;
        if (!ok(v)) { cells += `<rect class="ch-nil" x="${R(x)}" y="${y}" width="${R(cw - 1)}" height="${ch - 1}"/>`; continue; }
        cells += `<rect x="${R(x)}" y="${y}" width="${R(cw - 1)}" height="${ch - 1}" style="fill:${shade(v)}"/>`;
        const lab = String(fmt(v));
        if (ch >= 13 && tw(lab, 9.5) + 4 <= cw) text += `<text class="ch-ct" x="${R(x + (cw - 1) / 2)}" y="${R(y + (ch - 1) / 2 + 3.3)}" text-anchor="middle">${esc(lab)}</text>`;
      }
    }
    s += `<g class="ch-cells">${cells}</g>${text}`;
    const cell = (px, py) => { const j = Math.floor((px - rowW) / cw), i = Math.floor((py - HEAT_TOP) / ch); return i >= 0 && i < nr && j >= 0 && j < nc && px >= rowW ? [i, j] : null; };
    return {
      svg: s,
      hover(px, py) {
        const c = cell(px, py);
        if (!c) return null;
        const [i, j] = c, v = (z[i] || [])[j], x = rowW + j * cw, y = HEAT_TOP + i * ch;
        return { key: i * nc + j, svg: `<rect class="ch-cell-on" x="${R(x) - 0.5}" y="${y - 0.5}" width="${R(cw)}" height="${ch}"/>`,
          html: tipHtml(`${rows[i]} · ${cols[j]}`, [{ name: o.label || "", val: ok(v) ? fmt(v) : "—" }]), tx: x + cw / 2, ty: y + ch / 2 };
      },
      click: o.onCell ? (px, py) => { const c = cell(px, py); if (c) o.onCell(c[0], c[1]); } : null,
    };
  },
};

// ---------- candles ----------

const wday = d => { const n = dnum(d); return ok(n) ? (((n + 4) % 7) + 7) % 7 : 0; };      // 1970-01-01 was a Thursday

/** Date ticks for session-spaced slots: weeks when there is room, otherwise months (thinned to every
    2, 3 or 6), otherwise years. Returns [{ v: slot index, label }]. */
function sessionTicks(dates, slot) {
  const n = dates.length, wk = [], mo = [], yr = [];
  for (let i = 1; i < n; i++) {
    const a = dates[i - 1], b = dates[i];
    if (!a || !b) continue;
    if (a.slice(0, 7) !== b.slice(0, 7)) mo.push(i);
    if (a.slice(0, 4) !== b.slice(0, 4)) yr.push(i);
    if (wday(b) < wday(a) || dnum(b) - dnum(a) >= 7) wk.push(i);
  }
  const room = (list, px) => list.length >= 2 && (n * slot) / list.length >= px;
  const month = i => ({ v: i, label: dates[i].slice(5, 7) === "01" ? dates[i].slice(0, 4) : MON[+dates[i].slice(5, 7) - 1] });
  if (room(wk, 58)) return wk.map(i => ({ v: i, label: dshort(dnum(dates[i])) }));
  for (const k of [1, 2, 3, 6]) { const list = mo.filter(i => (+dates[i].slice(5, 7) - 1) % k === 0); if (room(list, 40) || (k === 1 && list.length === 1 && !yr.length)) return list.map(month); }
  if (yr.length) return yr.map(i => ({ v: i, label: dates[i].slice(0, 4) }));
  return mo.length ? mo.map(month) : wk.map(i => ({ v: i, label: dshort(dnum(dates[i])) }));
}

const CANDLES = {
  legend(o) {
    const it = (o.overlays || []).filter(v => v && v.name).map((v, i) => ({ name: v.name, c: col(v.color, PAL[(i + 1) % PAL.length]) }));
    if ((o.cone || []).length) it.push({ name: o.coneName || "Implied ±1σ", c: col(o.coneColor, "acc"), block: true });
    return it.length ? legHtml(it) : "";
  },
  draw(o, W, H) {
    const d = o.data || {}, all = d.dates || [], N = Math.min(all.length, (d.c || []).length);
    const n = Math.max(0, Math.min(N, o.last > 0 ? Math.round(o.last) : 180)), from = N - n;
    const cut0 = a => (a || []).slice(from, N).map(v => (ok(v) ? v : null));
    const dates = all.slice(from, N), C = cut0(d.c), O = cut0(d.o), Hi = cut0(d.h), Lo = cut0(d.l), V = cut0(d.v);
    let lastI = -1;
    for (let i = n - 1; i >= 0; i--) if (C[i] != null) { lastI = i; break; }
    if (lastI < 0) return null;
    for (let i = 0; i < n; i++) {                       // tolerate rows with only a close
      if (C[i] == null) continue;
      if (O[i] == null) O[i] = C[i];
      if (Hi[i] == null) Hi[i] = Math.max(O[i], C[i]);
      if (Lo[i] == null) Lo[i] = Math.min(O[i], C[i]);
    }
    // The cone is drawn in session time (5 sessions per 7 calendar days) and kept to under half the width of the bars.
    const last = C[lastI], capS = Math.max(6, Math.round(n * 0.45));
    let cone = (o.cone || []).filter(p => p && ok(p.d) && p.d > 0 && ok(p.up) && ok(p.dn)).sort((a, b) => a.d - b.d).map(p => ({ s: p.d * 5 / 7, d: p.d, up: p.up, dn: p.dn }));
    if (cone.length) {
      cone.unshift({ s: 0, d: 0, up: last, dn: last });
      const k = cone.findIndex(p => p.s > capS);
      if (k > 0) {
        const a = cone[k - 1], b = cone[k], w = (capS - a.s) / (b.s - a.s);
        cone = cone.slice(0, k).concat({ s: capS, d: a.d + (b.d - a.d) * w, up: a.up + (b.up - a.up) * w, dn: a.dn + (b.dn - a.dn) * w });
      }
    }
    const extra = cone.length ? Math.ceil(cone[cone.length - 1].s) + 1 : 1, slots = n + extra;
    const slotDates = dates.slice();
    for (let x = dnum(dates[n - 1]) + 1; slotDates.length < slots && ok(x); x++) { const w = (((x + 4) % 7) + 7) % 7; if (w !== 0 && w !== 6) slotDates.push(dstr(x)); }

    const over = (o.overlays || []).filter(Boolean).map((v, i) => ({ ...v, c: col(v.color, PAL[(i + 1) % PAL.length]), y: cut0(v.ys) }));
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) if (C[i] != null) { lo = Math.min(lo, Lo[i]); hi = Math.max(hi, Hi[i]); }
    for (const v of over) for (const y of v.y) if (y != null) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
    for (const p of cone) { lo = Math.min(lo, p.dn); hi = Math.max(hi, p.up); }
    const [y0, y1] = yRange(lo, hi, o.y || {}, 0.06);
    const vmax = Math.max(0, ...V.filter(v => v != null)), t = 8, b = 22, volH = vmax > 0 && o.volume !== false ? clamp(Math.round((H - t - b) * 0.17), 22, 56) : 0;
    const ph = H - t - b - (volH ? volH + 6 : 0);
    const ya = yAxis(y0, y1, ph, o.y || {}, 34), r = Math.max(34, Math.ceil(Math.max(0, ...ya.ticks.map(k => tw(k.label)))) + 14), l = 8, pw = W - l - r;
    if (pw < 40 || ph < 30) return null;
    const slot = pw / slots, f = { l, t, pw, ph, W, H };
    const X = i => l + (i + 0.5) * slot, Y = v => t + (y1 - v) / (y1 - y0) * ph, bot = t + ph + (volH ? volH + 6 : 0);
    const xt = sessionTicks(slotDates, slot);

    let s = "";
    for (const k of ya.ticks) s += hline(l, l + pw, Y(k.v), "ch-grid");
    for (const k of xt) s += vline(X(k.v) - slot / 2, t, bot, "ch-grid");
    s += hline(l, l + pw, bot, "ch-axis");
    for (const k of ya.ticks) s += `<text class="ch-tk" x="${l + pw + 7}" y="${R(Y(k.v) + 3.2)}">${esc(k.label)}</text>`;
    s += xLabels(xt, i => X(i) - slot / 2, bot + 13.5, W, false, 12);

    if (cone.length > 1) {
      const cx = p => X(lastI + p.s), up = cone.map(p => `${R(cx(p))} ${R(Y(p.up))}`), dn = cone.map(p => `${R(cx(p))} ${R(Y(p.dn))}`), cc = col(o.coneColor, "acc");
      s += vline(X(lastI) + slot / 2, t, bot, "ch-now");
      s += `<path d="M${up.concat(dn.slice().reverse()).join("L")}Z" style="fill:${cc};opacity:.10"/>`;
      s += `<path class="ch-ln" d="M${up.join("L")}" style="stroke:${cc};stroke-width:1" stroke-dasharray="3 3"/><path class="ch-ln" d="M${dn.join("L")}" style="stroke:${cc};stroke-width:1" stroke-dasharray="3 3"/>`;
    }
    // Bodies snap to whole pixels and keep an odd width so the 1px wick sits exactly in the middle.
    let bw = Math.floor(slot * 0.7); if (bw % 2 === 0) bw -= 1; bw = clamp(bw, 1, 13);
    const body = { up: "", down: "" }, vol = { up: "", down: "" };
    for (let i = 0; i < n; i++) {
      if (C[i] == null) continue;
      const side = C[i] >= O[i] ? "up" : "down", cx = Math.round(X(i) - 0.5) + 0.5, yo_ = Math.round(Y(O[i])), yc = Math.round(Y(C[i]));
      body[side] += `M${cx} ${Math.round(Y(Hi[i]))}V${Math.round(Y(Lo[i]))}`;
      if (bw >= 3) { const top = Math.min(yo_, yc), h = Math.max(1, Math.abs(yc - yo_)), x = cx - bw / 2; body[side] += `M${x} ${top}h${bw}v${h}h${-bw}Z`; }
      if (volH && V[i] != null && vmax > 0) { const h = Math.max(1, Math.round(V[i] / vmax * (volH - 2))), w = Math.max(1, bw), x = cx - w / 2; vol[side] += `M${x} ${bot}v${-h}h${w}v${h}Z`; }
    }
    if (volH) {
      s += hline(l, l + pw, t + ph + 3, "ch-grid");
      s += `<path class="ch-vol" d="${vol.up}" style="fill:var(--up)"/><path class="ch-vol" d="${vol.down}" style="fill:var(--down)"/>`;
      s += `<text class="ch-axl" x="${l + 2}" y="${t + ph + 14}">Vol</text><text class="ch-tk" x="${l + pw + 7}" y="${R(bot - volH + 8)}">${esc(compact(vmax))}</text>`;
    }
    for (const v of over) { const dd = pathOf(v.y.map((y, i) => [i, y]), X, Y); if (dd) s += `<path class="ch-ln" d="${dd}" style="stroke:${v.c};stroke-width:${v.width || 1.2}"${v.dash ? ` stroke-dasharray="${dashOf(v.dash)}"` : ""}/>`; }
    s += `<path class="ch-cd" d="${body.up}" style="fill:var(--up);stroke:var(--up)"/><path class="ch-cd" d="${body.down}" style="fill:var(--down);stroke:var(--down)"/>`;
    const marks = [];
    for (const m of o.marks || []) {
      if (!m || !m.date) continue;
      const i = slotDates.findIndex(x => x >= m.date);
      if (i >= 0 && (i > 0 || slotDates[0] === m.date)) marks.push({ ...m, px: X(i) });
    }
    s += vmarks(marks, X, f, "amber");
    // The last price sits on the axis as a filled tag, coloured by the day's direction.
    const prev = lastI > 0 && C[lastI - 1] != null ? C[lastI - 1] : O[lastI], tagC = last >= prev ? "var(--up)" : "var(--down)", ly = clamp(Y(last), t + 6, t + ph - 6), lab = ya.tip(last);
    s += hline(l, l + pw, Y(last), "ch-last", ` style="stroke:${tagC}"`);
    s += `<rect x="${l + pw + 2}" y="${R(ly - 7)}" width="${Math.ceil(tw(lab) + 9)}" height="14" rx="2" style="fill:${tagC}"/><text class="ch-tag" x="${l + pw + 6.5}" y="${R(ly + 3.3)}">${esc(lab)}</text>`;

    const pf = ya.tip, pct = v => (v >= 0 ? "+" : MINUS) + Math.abs(v * 100).toFixed(2) + "%";
    return {
      svg: s,
      hover(px, py) {
        if (px < l || px > l + pw || py < t - 4 || py > bot + 4) return null;
        const i = clamp(Math.floor((px - l) / slot), 0, slots - 1), cx = X(i), yv = y1 - (py - t) / ph * (y1 - y0);
        const cross = vline(cx, t, bot, "ch-cross") + (py <= t + ph ? hline(l, l + pw, py, "ch-cross") + `<rect class="ch-ytag" x="${l + pw + 2}" y="${R(py - 7)}" width="${Math.ceil(tw(pf(yv)) + 9)}" height="14" rx="2"/><text class="ch-ytx" x="${l + pw + 6.5}" y="${R(py + 3.3)}">${esc(pf(yv))}</text>` : "");
        if (i > lastI) {
          if (cone.length < 2) return { key: "f" + i, svg: cross, html: "", tx: cx, ty: py };
          const sx = i - lastI, e = cone[cone.length - 1];
          if (sx > e.s + 0.5) return { key: "f" + i, svg: cross, html: "", tx: cx, ty: py };
          const k = Math.max(1, cone.findIndex(p => p.s >= sx)), a = cone[k - 1], bb = cone[k] || e, w = clamp((sx - a.s) / ((bb.s - a.s) || 1), 0, 1);
          const up = a.up + (bb.up - a.up) * w, dn = a.dn + (bb.dn - a.dn) * w;
          return { key: "f" + i, svg: cross, tx: cx, ty: py, html: tipHtml(`${dlong(dnum(slotDates[i]))} · +${Math.round(sx * 7 / 5)}d`, [
            { name: "Upper", c: col(o.coneColor, "acc"), val: `${pf(up)}  ${pct(up / last - 1)}` }, { name: "Lower", c: col(o.coneColor, "acc"), val: `${pf(dn)}  ${pct(dn / last - 1)}` }]) };
        }
        if (C[i] == null) return { key: i, svg: cross, html: "", tx: cx, ty: py };
        const pc = i > 0 && C[i - 1] != null ? C[i - 1] : null, chg = pc ? C[i] / pc - 1 : null;
        const rows = [{ name: "Open", val: pf(O[i]) }, { name: "High", val: pf(Hi[i]) }, { name: "Low", val: pf(Lo[i]) }, { name: "Close", val: pf(C[i]), cls: C[i] >= O[i] ? "up" : "down" }];
        if (chg != null) rows.push({ name: "Change", val: pct(chg), cls: chg >= 0 ? "up" : "down" });
        if (V[i] != null) rows.push({ name: "Volume", val: compact(V[i]) });
        for (const v of over) if (v.y[i] != null) rows.push({ name: v.name || "", c: v.c, val: pf(v.y[i]) });
        return { key: i, svg: cross, html: tipHtml(dlong(dnum(dates[i])), rows), tx: cx, ty: py };
      },
      click: o.onClick ? px => { const i = Math.floor((px - l) / slot); if (i >= 0 && i < n) o.onClick(dates[i], i); } : null,
    };
  },
};

// ---------- payoff ----------

const PAYOFF = {
  legend(o) {
    const ser = (o.series || []).filter(s => s && s.name);
    if (!(o.legend ?? ser.length > 1) || !ser.length) return "";
    return legHtml((o.series || []).map((s, i) => ({ name: s && s.name, c: i === 0 && !s.color ? "var(--tx)" : col(s && s.color, PAL[(i - 1 + PAL.length) % PAL.length]), dash: !!(s && s.dash) })).filter(i => i.name));
  },
  draw(o, W, H, id) {
    const xo = o.x || {}, yo = o.y || {}, xs = (o.xs || []).map(v => (ok(v) ? v : null));
    const ser = (o.series || []).filter(Boolean).map((q, i) => ({ ...q, first: i === 0, c: i === 0 && !q.color ? "var(--tx)" : col(q.color, PAL[(i - 1 + PAL.length) % PAL.length]),
      P: xs.map((x, j) => [x, ok((q.ys || [])[j]) ? q.ys[j] : null]).filter(p => p[0] != null).sort((a, b) => a[0] - b[0]) }));
    let x0 = Infinity, x1 = -Infinity, lo = 0, hi = 0, any = false;
    for (const q of ser) for (const [x, y] of q.P) if (y != null) { any = true; x0 = Math.min(x0, x); x1 = Math.max(x1, x); lo = Math.min(lo, y); hi = Math.max(hi, y); }
    if (!any || !(x1 > x0)) return null;
    const [y0, y1] = yRange(lo, hi, yo, 0.1);
    const t = 10 + (yo.label ? 12 : 0), ph = H - t - 22 - (xo.label ? 13 : 0);
    const ya = yAxis(y0, y1, ph, yo), l = Math.max(26, Math.ceil(Math.max(0, ...ya.ticks.map(k => tw(k.label)))) + 12), pw = W - l - 14;
    if (pw < 30 || ph < 30) return null;
    const f = { l, t, pw, ph, W, H }, X = v => l + (v - x0) / (x1 - x0) * pw, Y = v => t + (y1 - v) / (y1 - y0) * ph, zy = Y(0);
    const xa = xAxis("num", x0, x1, pw, xo);
    // Two clip boxes split the plot at zero: the same curve is painted green in the upper one and red in the lower.
    let s = `<clipPath id="chp${id}"><rect x="${l}" y="${t}" width="${pw}" height="${R(Math.max(0, zy - t))}"/></clipPath><clipPath id="chn${id}"><rect x="${l}" y="${R(zy)}" width="${pw}" height="${R(Math.max(0, t + ph - zy))}"/></clipPath>`;
    s += bandsSvg(o.bands, X, f);
    s += frame(f, X, Y, xa.ticks, ya.ticks, { xlabel: xo.label, ylabel: yo.label });
    const main = ser[0];
    if (main) {
      const ar = areaOf(main.P, X, Y, zy), ln = pathOf(main.P, X, Y);
      s += `<path d="${ar}" clip-path="url(#chp${id})" style="fill:var(--up);opacity:.16"/><path d="${ar}" clip-path="url(#chn${id})" style="fill:var(--down);opacity:.16"/>`;
      s += hline(l, l + pw, zy, "ch-zero");
      if (main.color) s += `<path class="ch-ln" d="${ln}" style="stroke:${main.c};stroke-width:1.6"/>`;
      else s += `<path class="ch-ln" d="${ln}" clip-path="url(#chp${id})" style="stroke:var(--up);stroke-width:1.6"/><path class="ch-ln" d="${ln}" clip-path="url(#chn${id})" style="stroke:var(--down);stroke-width:1.6"/>`;
    }
    for (const q of ser.slice(1)) { const dd = pathOf(q.P, X, Y); if (dd) s += `<path class="ch-ln" d="${dd}" style="stroke:${q.c};stroke-width:${q.width || 1.25}"${q.dash ? ` stroke-dasharray="${dashOf(q.dash)}"` : ""}/>`; }
    const tipX = xo.fmt || plain, marks = [];
    if (ok(o.spot)) marks.push({ px: X(o.spot), label: `Spot ${tipX(o.spot)}`, color: "tx-2" });
    s += vmarks(marks, X, f);
    // Break-even labels sit just under the zero line (above it when the plot has no room below) and step down a row when two would touch.
    const taken = [];
    for (const be of (o.breakevens || []).filter(ok).sort((a, b) => a - b)) {
      const px = X(be);
      if (px < l || px > l + pw) continue;
      const lab = `BE ${tipX(be)}`, w = tw(lab), x = clamp(px, l + w / 2 + 2, l + pw - w / 2 - 2);
      let row = 0;
      while (taken.some(k => k.row === row && Math.abs(k.x - x) < (k.w + w) / 2 + 6)) row++;
      taken.push({ x, w, row });
      const below = zy + 14 + row * 11 < t + ph - 2, y = below ? zy + 14 + row * 11 : zy - 7 - row * 11;
      s += `<circle class="ch-be" cx="${R(px)}" cy="${R(zy)}" r="3"/><text class="ch-ml" x="${R(x)}" y="${R(y)}" text-anchor="middle" style="fill:var(--amber)">${esc(lab)}</text>`;
    }
    return {
      svg: s,
      hover(px, py) {
        if (px < l - 8 || px > l + pw + 8 || py < t - 8 || py > t + ph + 8 || !main) return null;
        const sx = nearX(main.P, x0 + (px - l) / pw * (x1 - x0));
        if (sx == null) return null;
        const cx = X(sx), rows = [];
        let dots = "";
        for (const q of ser) {
          const y = valAt(q.P, sx);
          if (y == null) continue;
          rows.push({ name: q.name || "", c: q.first && !q.color ? (y >= 0 ? "var(--up)" : "var(--down)") : q.c, val: ya.tip(y), cls: y > 0 ? "up" : y < 0 ? "down" : "" });
          dots += dotSvg(cx, Y(y), q.first && !q.color ? (y >= 0 ? "var(--up)" : "var(--down)") : q.c);
        }
        const head = ok(o.spot) && o.spot > 0 ? `${tipX(sx)}  ${(sx >= o.spot ? "+" : MINUS) + Math.abs((sx / o.spot - 1) * 100).toFixed(1)}%` : tipX(sx);
        return { key: sx, svg: vline(cx, t, t + ph, "ch-cross") + dots, html: tipHtml(head, rows), tx: cx, ty: py };
      },
      click: o.onClick ? px => { const sx = main && nearX(main.P, x0 + (px - l) / pw * (x1 - x0)); if (sx != null) o.onClick(sx); } : null,
    };
  },
};

// ---------- public API ----------

/** Lines, with optional ribbons (a cone), shaded bands, marks, areas, dashes and steps. */
export const line = (el, opts) => mount(el, opts, LINE);
/** Labelled points, optionally with the y = x diagonal. */
export const scatter = (el, opts) => mount(el, opts, SCATTER);
/** Grouped, stacked or horizontal bars over categories. */
export const bars = (el, opts) => mount(el, opts, BARS);
/** A rows × cols grid shaded on a sequential or diverging scale. */
export const heat = (el, opts) => mount(el, opts, HEAT);
/** Session-spaced OHLC candles with a volume strip, overlays and a forward cone. update({ data }) swaps the data. */
export const candles = (el, data, opts) => mount(el, { ...(opts || {}), data }, CANDLES);
/** Profit against the underlying: green above zero, red below, with spot and break-even marks. */
export const payoff = (el, opts) => mount(el, opts, PAYOFF);

/** A sparkline for a table cell → SVG string. Nulls leave gaps; too little data draws a short dash. */
export function spark(values, o = {}) {
  const w = o.w || 64, h = o.h || 18, c = col(o.color, "tx-2"), v = (values || []).map(x => (ok(x) ? x : null)), live_ = v.filter(x => x != null);
  const open = `<svg class="ch-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">`;
  if (live_.length < 2) return `${open}<line x1="${w / 2 - 4}" x2="${w / 2 + 4}" y1="${h / 2}" y2="${h / 2}" style="stroke:var(--faint)"/></svg>`;
  let lo = Math.min(...live_), hi = Math.max(...live_);
  if (o.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi === lo) { hi += 1; lo -= 1; }
  const X = i => 2 + i / (v.length - 1) * (w - 4), Y = y => 2 + (hi - y) / (hi - lo) * (h - 4), P = v.map((y, i) => [i, y]);
  let s = open;
  if (o.fill) s += `<path d="${areaOf(P, X, Y, o.zero ? Y(0) : h - 1)}" style="fill:${c};opacity:.16"/>`;
  if (o.zero && lo < 0 && hi > 0) s += `<line x1="0" x2="${w}" y1="${hair(Y(0))}" y2="${hair(Y(0))}" style="stroke:var(--line-2)" shape-rendering="crispEdges"/>`;
  s += `<path d="${pathOf(P, X, Y)}" fill="none" style="stroke:${c};stroke-width:1.2" stroke-linejoin="round" stroke-linecap="round"/>`;
  let li = v.length - 1; while (v[li] == null) li--;
  if (o.dot !== false) s += `<circle cx="${R(X(li))}" cy="${R(Y(v[li]))}" r="1.6" style="fill:${c}"/>`;
  return s + "</svg>";
}

/** A small horizontal bar for a table cell → HTML string. With `mid` it grows left or right of that value. */
export function bar(value, o = {}) {
  const lo = ok(o.min) ? o.min : 0, hi = ok(o.max) ? o.max : 1, w = o.w || 48, h = o.h || 6, span = (hi - lo) || 1;
  const open = `<span class="ch-bar" style="width:${w}px;height:${h}px">`;
  if (!ok(value)) return open + "</span>";
  const p = v => clamp((v - lo) / span, 0, 1) * 100, a = ok(o.mid) ? p(o.mid) : 0, b = p(value);
  const c = col(o.color, ok(o.mid) ? (value >= o.mid ? "up" : "down") : "acc");
  return `${open}<i style="left:${R(Math.min(a, b))}%;width:${R(Math.abs(b - a))}%;background:${c}"></i>${ok(o.mid) ? `<u style="left:${R(a)}%"></u>` : ""}</span>`;
}
