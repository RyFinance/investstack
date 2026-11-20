// ticket.js — the right-hand panel (318px): the detail of whatever is selected (S.sel), else the selected property,
// else a short list of ways to start. Pages call select({ kind, id, row }) with their own table row as `row`, so every
// drawer uses row fields when present and fetches the detail it lacks.
import { S, f, get, post, go, select, pref, daysTo, today, esc, streetView, openExternal } from "./core.js";
import { bind, toast, formModal, confirmModal, src, pill, useCss } from "./ui.js";
import * as C from "./charts.js";
import { mapView } from "./map.js";

useCss("ticket");

const STAGES = [["discovered", "Discovered"], ["researching", "Researching"], ["underwriting", "Underwriting"], ["diligence", "Due diligence"],
  ["offer", "Offer"], ["acquired", "Acquired"], ["rejected", "Rejected"]];
const stageLabel = id => (STAGES.find(s => s[0] === id) || [0, id || f.DASH])[1];
const PARTS = [["cashflow", "Cash flow"], ["cap", "Cap rate"], ["discount", "Discount to value"], ["momentum", "ZIP momentum"], ["negotiable", "Negotiable (DOM)"], ["risk", "Data confidence"]];
const okLL = p => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon) && p.lat !== null && p.lon !== null;
const srcKind = s => (!s ? "x" : /demo|assum|default|rough|index|zip/i.test(s) ? "e" : /record|bill|county|verified/i.test(s) ? "v" : /my |you|manual|own/i.test(s) ? "m" : "e");
const daysSince = s => (s ? Math.max(0, -daysTo(String(s).slice(0, 10))) : null);
const tryGet = async path => { try { return await get(path); } catch (e) { return null; } };
const parse = v => { if (v && typeof v === "string") { try { return JSON.parse(v); } catch (e) { return {}; } } return v || {}; };

/* ---------- markup helpers ---------- */

const hdr = (title, small, sub, right = "") => `<div class="tk-h"><div class="sym">${esc(title)}${small ? `<small>${esc(small)}</small>` : ""}${right ? `<span class="tk-hr">${right}</span>` : ""}</div>`
  + (sub ? `<div class="sub2">${sub}</div>` : "") + `</div>`;
const sec = (title, right, body) => `<div class="tk-sec"><h4>${esc(title)}${right ? `<em>${right}</em>` : ""}</h4>${body}</div>`;
const r3 = items => `<div class="row3">${items.filter(Boolean).map(i => `<div${i.title ? ` title="${esc(i.title)}"` : ""}><span>${esc(i.k)}</span><b class="${i.cls || ""}">${i.v ?? f.DASH}</b></div>`).join("")}</div>`;
const lines = items => `<div class="tk-ln">${items.filter(Boolean).map(([k, v, cls, title]) => `<div${title ? ` title="${esc(title)}"` : ""}><span>${esc(k)}</span><b class="${cls || ""}">${v ?? f.DASH}</b></div>`).join("")}</div>`;
const acts = list => `<div class="tk-acts">${list.filter(Boolean).map(([act, label, cls, attrs, title]) => `<button class="btn${cls ? " " + cls : ""}" data-act="${act}"${attrs ? " " + attrs : ""}${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</button>`).join("")}</div>`;
const verdict = (cls, html) => `<div class="verdict ${cls}">${html}</div>`;
const note = t => `<div class="note">${t}</div>`;
const stagePill = s => pill(stageLabel(s), s === "acquired" ? "up" : s === "rejected" ? "down" : s === "offer" ? "amb" : "");
const range = v => (v && f.ok(v.low) && f.ok(v.high) ? `${f.cusd(v.low)}–${f.cusd(v.high)}` : "");

/* The 3D site map: one MapLibre instance, kept across re-renders of the same point (the node is moved, not rebuilt). */
let site = null;   // { key, box, m }
function dropSite() { try { site?.m?.destroy?.(); } catch (e) { /* already gone */ } site = null; }
async function mountSite(el) {
  const host = el.querySelector(".tk-site");
  if (!host) { dropSite(); return; }
  const lat = +host.dataset.lat, lon = +host.dataset.lon, key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  if (site && site.key === key) { host.replaceWith(site.box); return; }
  dropSite();
  const box = document.createElement("div");
  box.className = "tk-site";
  host.replaceWith(box);
  const mine = site = { key, box, m: null };
  const m = await mapView(box, { points: [{ id: 1, lat, lon, kind: "subject", label: host.dataset.label || "" }], tilt3d: true });
  if (site !== mine) { m.destroy(); return; }
  mine.m = m;
}

/** Street View: an inline panorama when a Google Maps key is set (Embed API, free), else a button that opens it.
 *  With site3d, a tilted 3D map of the block (extruded OpenStreetMap buildings) sits above it. */
async function streetBlock(lat, lon, label = "Street view", site3d = false) {
  if (lat == null || lon == null || !Number.isFinite(+lat) || !Number.isFinite(+lon)) return { html: "", acts: {} };
  const sv = await tryGet(streetView(lat, lon));
  if (!sv && !site3d) return { html: "", acts: {} };
  const map3d = site3d ? `<div class="tk-site" data-lat="${+lat}" data-lon="${+lon}"></div><div class="tk-mute tk-cap">3D buildings: OpenStreetMap heights via OpenFreeMap. Right-drag to rotate.</div>` : "";
  if (!sv) return { html: sec(label, `${(+lat).toFixed(5)}, ${(+lon).toFixed(5)}`, map3d), acts: {} };
  const html = sec(label, `${(+lat).toFixed(5)}, ${(+lon).toFixed(5)}`, map3d
    + (sv.embed ? `<iframe class="sv tk-sv" src="${esc(sv.embed)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>` : "")
    + acts([["sv", "Open Street View", "", "", "Google Street View in your browser"], sv.maps ? ["map", "Map", "ghost"] : null])
    + (sv.embed ? "" : `<div class="tk-mute">Add a Google Maps key in <a class="link" data-go="settings">Settings</a> to see it here.</div>`));
  return { html, acts: { "act:sv": () => openExternal(sv.link), "act:map": () => sv.maps && openExternal(sv.maps) } };
}

/* ---------- property ---------- */

async function drawProperty(id, row) {
  id = id ?? row?.property_id ?? row?.id;
  const prof = S.prop?.property?.id === +id ? S.prop : id != null ? await tryGet(`/api/property/${id}`) : null;
  const p = prof?.property || row;
  if (!p) return { html: hdr("Property not found", "", "It may have been removed. Pick another row.") };
  const lst = prof?.listing || null;
  const price = lst?.price ?? row?.price ?? null;
  const q = prof?.quick || (row && f.ok(row.cap) ? row : {});
  const value = prof?.value || (f.ok(row?.value_est) ? { value: row.value_est, source: row.value_src || "quick estimate" } : null);
  const rent = prof?.rent || (f.ok(row?.rent_est) ? { value: row.rent_est, source: row.rent_src || "estimate" } : null);
  const owned = prof?.owned || null, deal = prof?.deal || null;
  const disc = f.ok(value?.value) && f.ok(price) && price ? value.value / price - 1 : null;

  const facts = [p.type, f.bb(p), f.sqft(p.sqft), p.year_built ? `built ${p.year_built}` : "", p.units > 1 ? `${p.units} units` : ""].filter(Boolean).map(esc).join(" · ");
  const status = owned || p.owned ? pill("Owned", "up") : deal ? stagePill(deal.stage) : lst?.status ? pill(lst.status, lst.status === "Active" ? "" : "amb") : "";
  let h = hdr(f.street(p.address), p.zip || "", facts, status);

  // price / value / rent
  h += `<div class="tk-px">`
    + `<div><span>${owned ? "Paid" : "Ask"}</span><b>${f.usd(owned ? owned.purchase_price : price)}</b><i>${owned ? f.dateY(owned.purchase_date) : lst ? `${f.int(lst.dom)} DOM · ${esc(lst.source || "")}` : "not listed"}</i></div>`
    + `<div><span>Value</span><b>${f.usd(value?.value)}</b><i>${range(value) || (value ? (value.n ? `n ${value.n}` : "no range") : "no estimate")}</i></div>`
    + `<div><span>Rent / mo</span><b>${f.usd(rent?.value)}</b><i>${range(rent) || (rent ? "no range" : "no estimate")}</i></div></div>`;
  const provs = [value ? src(`Value: ${value.source || "estimate"}${value.as_of ? " " + value.as_of : ""}${value.n ? ` · ${value.n} comps` : ""}`, srcKind(value.source)) : "",
    rent ? src(`Rent: ${rent.source || "estimate"}${rent.as_of ? " " + rent.as_of : ""}${rent.n ? ` · ${rent.n} comps` : ""}`, srcKind(rent.source)) : ""].filter(Boolean);
  if (provs.length || disc != null) h += `<div class="tk-prov">${provs.join("<br>")}${disc != null && !owned ? `<br><span class="${f.cls(disc)}">Value is ${f.spct(Math.abs(disc)).replace(/^[+−]/, "")} ${disc >= 0 ? "above" : "below"} the ask</span>` : ""}</div>`;

  let after = null;
  if (owned || p.owned) {
    const pf = await tryGet("/api/portfolio");
    const o = pf?.properties?.find(x => x.id === p.id);
    if (o) {
      h += sec("Owned · trailing 12 months", "", r3([
        { k: "NOI", v: f.usd(o.noi), cls: f.cls(o.noi) }, { k: "Cash flow", v: f.susd(o.cf), cls: f.cls(o.cf) }, { k: "Cap on value", v: f.pct(o.cap_on_value) },
        { k: "Equity", v: f.cusd(o.equity) }, { k: "LTV", v: f.pct(o.ltv, 0) }, { k: "DSCR", v: f.x(o.dscr) },
        { k: "Occupied", v: o.units_n ? `${o.occupied}/${o.units_n}` : f.DASH }, { k: "Rent owed", v: f.usd(o.arrears), cls: o.arrears > 0 ? "down" : "" }, { k: "Gain", v: f.susd(o.gain), cls: f.cls(o.gain), title: "Value less purchase price, closing and rehab" },
      ]) + `<div class="tk-mute">From ledger payments and expenses. Value: ${esc(o.value_src || value?.source || "—")}.</div>`);
    }
  } else if (f.ok(q.cap) || f.ok(q.cf)) {
    h += sec("Quick returns", "at the ask", r3([
      { k: "Cap", v: f.pct(q.cap) }, { k: "CoC", v: f.pct(q.coc), cls: f.cls(q.coc) }, { k: "Cash flow", v: f.susd(q.cf), cls: f.cls(q.cf), title: "Per month after debt service and reserves" },
      { k: "DSCR", v: f.x(q.dscr), cls: f.ok(q.dscr) && q.dscr < 1 ? "down" : "" }, { k: "GRM", v: f.num(q.grm, 1) }, { k: "Rent / price", v: f.pct(q.one_pct, 2), title: "Monthly rent over price (the 1% rule)" },
    ]) + `<div class="tk-mute">25% down at ${f.pct(prof?.ctx?.rate, 2)} (${esc(prof?.ctx?.rate_src || "current investor rate")}); tax ${prof?.tax?.amount ? f.usd(prof.tax.amount) + " (" + esc(prof.tax.src || "") + ")" : "assumed"}; insurance 0.5% of price.</div>`);
    const sp = q.score_parts || {};
    if (Object.keys(sp).length) {
      h += sec("Score", `<b class="m">${f.score(q.score)}</b> / 100`, `<div class="tk-bars">` + PARTS.map(([k, lab]) =>
        `<div><span>${lab}</span>${C.bar(sp[k], { max: 100, w: 104, color: "acc" })}<b>${f.score(sp[k])}</b></div>`).join("") + `</div>`);
    }
    const coc = q.coc, dscr = q.dscr, cf = q.cf, miss = prof?.missing?.length || 0;
    const tail = miss ? ` ${miss} input${miss > 1 ? "s" : ""} assumed (see Missing).` : "";
    if (f.ok(coc) && f.ok(dscr) && coc >= 0.08 && dscr >= 1.25 && cf > 0)
      h += verdict("good", `<b>Pencils at the ask.</b> CoC ${f.pct(coc)}, DSCR ${f.x(dscr)}, ${f.susd(cf)}/mo.${tail}`);
    else if ((f.ok(cf) && cf < 0) || (f.ok(dscr) && dscr < 1))
      h += verdict("bad", `<b>Does not cash-flow at the ask.</b> ${f.susd(cf)}/mo, DSCR ${f.x(dscr)}. Underwrite shows the max offer for 8% CoC.${tail}`);
    else h += verdict("check", `<b>Marginal at the ask.</b> CoC ${f.pct(coc)}, DSCR ${f.x(dscr)}. Check rent and expenses on Underwrite before an offer.${tail}`);
  } else {
    h += verdict("check", `<b>No quick returns.</b> ${price == null ? "No asking price on file." : "No rent estimate."} Open Underwrite and enter ${price == null ? "a price" : "a rent"} to run the numbers.`);
  }

  if (deal) h += sec("Pipeline", stagePill(deal.stage), lines([
    ["In stage", f.days(daysSince(deal.stage_entered))], ["Ask", f.usd(deal.ask)], ["Offer", f.usd(deal.offer)],
  ]));
  if (prof?.missing?.length) h += sec("Missing", `${prof.missing.length}`, prof.missing.slice(0, 4).map(m => `<div class="tk-miss"><b>${esc(m.k)}</b><span>${esc(m.how)}</span></div>`).join(""));

  const sv = await streetBlock(p.lat, p.lon, "Site", true);
  h += sv.html;
  h += `<div class="tk-sec tk-last">` + acts([
    ["open", "Open", "pri"], ["uw", "Underwrite"], ["comps", "Comps"],
    owned || p.owned ? ["port", "Portfolio"] : deal ? ["deal", "Deal"] : ["pipe", "+ Pipeline", "", "", "Add as a deal at Discovered"],
  ]) + `</div>`;

  return {
    html: h,
    acts: {
      ...sv.acts,
      "act:open": () => go("property", p.id), "act:uw": () => go("underwrite", p.id), "act:comps": () => go("comps", p.id),
      "act:port": () => go("portfolio", p.id),
      "act:deal": () => { select({ kind: "deal", id: deal.id }); go("pipeline"); },
      "act:pipe": async () => {
        const r = await post("/api/pipeline", { act: "add", property_id: p.id, ask: price, strategy: "rental", score: f.ok(q.score) ? Math.round(q.score) : null });
        toast(r.error || `${f.street(p.address)} added to the pipeline at Discovered`, r.error ? "bad" : "");
      },
    },
    after,
  };
}

/* ---------- deal ---------- */

async function moveDeal(d, stage) {
  let reason = "";
  if (stage === "rejected") {
    const v = await formModal(`Reject ${f.street(d.address)}`, [
      { k: "reason", label: "Reason", type: "select", value: "Numbers don't work at the ask", options: ["Numbers don't work at the ask", "Seller won't negotiate", "Inspection findings", "Location / neighbourhood", "Financing", "Outbid", "Other"] },
      { k: "note", label: "Detail (optional)", full: true },
    ], { ok: "Reject deal", note: "The reason goes into the deal log." });
    if (!v) return;
    reason = [v.reason, v.note].filter(Boolean).join(": ");
  } else if (stage === "acquired") {
    const price = f.ok(d.offer) ? d.offer : d.ask;
    if (!(await confirmModal(`Mark ${f.street(d.address)} acquired`, `Marks the property owned and adds it to Portfolio at ${f.usd(price)}, dated ${f.dateY(today())}.`, "Mark acquired"))) return;
  }
  const r = await post("/api/pipeline", { act: "move", id: d.id, stage, reason });
  toast(r.error || `Moved to ${stageLabel(stage)}`, r.error ? "bad" : "");
}

async function drawDeal(id, row) {
  const [det, pl] = await Promise.all([id != null ? tryGet(`/api/deal/${id}`) : null, tryGet("/api/pipeline")]);
  const base = pl?.deals?.find(x => x.id === +id) || row || {};
  if (!det?.deal && !base.id) return { html: hdr("Deal not found", "", "It may have been removed from the pipeline.") };
  const d = { ...base, ...(det?.deal || {}) };
  const tasks = det?.tasks || [], events = det?.events || [];
  const open = tasks.filter(t => !t.done), late = open.filter(t => t.due && daysTo(t.due) < 0);
  const oa = f.ok(d.offer) && f.ok(d.ask) && d.ask ? d.offer / d.ask - 1 : null;
  const order = STAGES.map(s => s[0]), i = order.indexOf(d.stage);
  const next = i >= 0 && i < 5 ? order[i + 1] : null, prev = i > 0 && i <= 5 ? order[i - 1] : d.stage === "rejected" ? "discovered" : null;

  let h = hdr(f.street(d.address), d.zip || "", `${esc(f.city(d.address))}${d.type ? " · " + esc(d.type) : ""}${d.units > 1 ? ` · ${d.units} units` : ""}`, stagePill(d.stage));
  h += `<div class="tk-sec">` + r3([
    { k: "In stage", v: f.days(daysSince(d.stage_entered)) }, { k: "Ask", v: f.cusd(d.ask) }, { k: "Offer", v: f.cusd(d.offer) },
    { k: "Off / ask", v: f.spct(oa), cls: f.cls(oa) }, { k: "Open tasks", v: f.int(open.length), cls: late.length ? "down" : "" },
    { k: "Score", v: f.score(d.score), title: "Score saved when the deal was added" },
  ]) + (d.reason && d.stage === "rejected" ? `<div class="tk-mute">Reason: ${esc(d.reason)}</div>` : "") + `</div>`;
  h += sec("Move", "", acts([
    next ? ["mv", `Advance to ${stageLabel(next)}`, "pri", `data-stage="${next}"`] : null,
    prev ? ["mv", `Back to ${stageLabel(prev)}`, "", `data-stage="${prev}"`] : null,
    d.stage !== "rejected" ? ["mv", "Reject", "warn", `data-stage="rejected"`] : null,
  ]));
  h += sec("Tasks", `${open.length} open${late.length ? ` · <span class="down">${late.length} late</span>` : ""}`,
    open.length ? `<div class="tk-chk">${open.slice(0, 8).map(t => `<label class="chk"><input type="checkbox" data-input="tk" data-id="${t.id}"><span>${esc(t.title)}</span>`
      + `<em class="${t.due && daysTo(t.due) < 0 ? "late" : ""}">${f.date(t.due)}</em></label>`).join("")}</div>${open.length > 8 ? `<div class="tk-mute">${open.length - 8} more on the Pipeline page</div>` : ""}`
      : `<div class="tk-mute">No open tasks.${next ? ` Advancing to ${stageLabel(next)} adds its checklist.` : ""}</div>`);
  if (events.length) h += sec("Log", `${events.length}`, `<div class="tk-ev">${events.slice(0, 5).map(e => `<div class="ev"><i>${f.date(e.ts)}</i>${esc(e.text)}</div>`).join("")}</div>`);
  const sv = await streetBlock(d.lat, d.lon, "Site", true);
  h += sv.html;
  h += `<div class="tk-sec tk-last">` + acts([["prop", "Property", "pri"], ["uw", "Underwrite"], ["pipe", "Pipeline"]]) + `</div>`;

  return {
    html: h,
    acts: {
      ...sv.acts,
      "act:mv": el => moveDeal(d, el.dataset.stage),
      "change:tk": async (v, el) => {
        const r = await post("/api/pipeline", { act: "task_done", task_id: +el.dataset.id, done: el.checked });
        if (r.error) toast(r.error, "bad");
      },
      "act:prop": () => go("property", d.property_id), "act:uw": () => go("underwrite", d.property_id), "act:pipe": () => go("pipeline"),
    },
  };
}

/* ---------- lease / unit ---------- */

async function drawLease(id, row) {
  const lid = row?.lease_id ?? (row && "tenant" in row && row.id && !row.property_id ? row.id : null) ?? id;
  // the rent roll row carries the escalated current rent; fetch it when the caller passed only an id
  if (lid != null && row?.current_rent === undefined) {
    const rr = (await tryGet("/api/rentroll"))?.find?.(u => u.lease_id === +lid);
    if (rr) row = { ...rr, ...(row || {}) };
  }
  const led = lid != null ? await tryGet(`/api/ledger/${lid}`) : null;
  if (!led?.lease && !row) return { html: hdr("Lease not found", "", "It may have ended or been removed.") };
  const L = { ...(row || {}), ...(led?.lease || {}) };
  const bal = led?.balance ?? row?.balance ?? null, aging = led?.aging || row?.aging || {};
  const rentNow = row?.current_rent ?? L.rent;
  const left = L.end ? daysTo(L.end) : null;
  const st = L.status || row?.lease_status || "lease", hold = st === "active" && left != null && left < 0;
  let h = hdr(L.tenant || "Lease", L.unit || row?.name || "", esc(L.address || ""), pill(hold ? "holdover" : st, st === "active" && !hold ? "up" : "amb"));
  h += `<div class="tk-sec">` + r3([
    { k: "Rent", v: f.usd(rentNow), title: row?.current_rent != null && row.current_rent !== L.rent ? `Lease rent ${f.usd(L.rent)}; with escalation ${f.usd(row.current_rent)}` : "Monthly rent" },
    { k: "Balance", v: f.usd(bal), cls: bal > 0 ? "down" : bal < 0 ? "up" : "", title: "Positive = owed by the tenant; negative = prepaid" },
    { k: "Deposit", v: f.usd(L.deposit) },
    { k: "Start", v: f.dateY(L.start) }, { k: "End", v: f.dateY(L.end) },
    { k: left != null && left < 0 ? "Past end" : "Days left", v: left == null ? f.DASH : left < 0 ? `${f.int(-left)}d` : f.int(left), title: left != null && left < 0 ? "Lease end date has passed: month-to-month or holdover until renewed or ended" : "", cls: left != null && left < 0 ? "down" : left != null && left <= 90 ? "amb" : "" },
    { k: "Due day", v: L.due_day ? f.int(L.due_day) : f.DASH }, { k: "Late fee", v: f.usd(L.late_fee) }, { k: "Escalation", v: f.pct(L.escalation), title: "Yearly rent increase" },
  ]) + `</div>`;
  h += `<div class="tk-sec"><h4>Ageing<em>${led?.prepaid ? `prepaid ${f.usd(led.prepaid)}` : ""}</em></h4><div class="aging tk-aging">`
    + ["0-30", "31-60", "61-90", "90+"].map(k => `<div><span>${k}</span><b class="${aging[k] > 0 ? "down" : ""}">${f.usd(aging[k] ?? null)}</b></div>`).join("") + `</div></div>`;
  const ents = (led?.entries || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 8);
  h += sec("Recent ledger", ents.length ? `${led.entries.length} entries` : "", ents.length
    ? `<table class="tk-t"><tbody>${ents.map(e => `<tr><td>${f.dateY(e.date)}</td><td class="l">${esc(e.type.replace("_", " "))}</td><td class="${e.type === "payment" || e.type === "credit" ? "up" : ""}">${e.type === "payment" || e.type === "credit" ? "−" : ""}${f.usd(e.amount, 2)}</td><td class="mut">${f.usd(e.running, 2)}</td></tr>`).join("")}</tbody></table>`
    : `<div class="tk-mute">No entries yet. Record a payment, or import a bank CSV in the Inbox.</div>`);
  h += `<div class="tk-sec tk-last">` + acts([lid != null ? ["pay", "Record payment", "pri"] : null, ["ledger", "Ledger"], ["rr", "Rent roll"]]) + `</div>`;
  return {
    html: h,
    acts: {
      "act:pay": async () => {
        const v = await formModal(`Payment · ${L.tenant || "tenant"}`, [
          { k: "date", label: "Date", type: "date", value: today(), req: true },
          { k: "amount", label: "Amount", type: "number", value: bal > 0 ? Math.round(bal * 100) / 100 : rentNow ?? "", req: true },
          { k: "memo", label: "Memo", full: true, ph: "ACH, check #, cash" },
        ], { ok: "Record payment" });
        if (!v || !f.ok(v.amount)) return;
        const r = await post("/api/portfolio", { act: "add", table: "entry", data: { lease_id: +lid, date: v.date, type: "payment", amount: Math.abs(v.amount), memo: v.memo } });
        toast(r.error || `Recorded ${f.usd(v.amount, 2)} from ${L.tenant || "the tenant"}`, r.error ? "bad" : "");
      },
      "act:ledger": () => go("ledger"), "act:rr": () => go("rentroll"),
    },
  };
}

async function drawUnit(id, row) {
  if (row?.lease_id) return drawLease(row.lease_id, row);
  const u = row?.name ? row : (await tryGet("/api/units"))?.find(x => x.id === +id);
  if (!u) return { html: hdr("Unit not found") };
  let h = hdr(u.name || "Unit", f.street(u.address), esc(f.city(u.address)), pill(u.status || "vacant", u.status === "occupied" ? "up" : "amb"));
  h += `<div class="tk-sec">` + r3([
    { k: "Beds", v: f.ok(u.beds) ? +u.beds : f.DASH }, { k: "Baths", v: f.ok(u.baths) ? +u.baths : f.DASH }, { k: "Sqft", v: f.int(u.sqft) },
    { k: "Market rent", v: f.usd(u.market_rent) }, { k: "Status", v: esc(u.status || f.DASH) }, { k: "Lease", v: u.lease_id ? "#" + u.lease_id : "none" },
  ]) + `</div>`;
  if (u.status !== "occupied") h += verdict("check", `<b>Vacant.</b> ${f.ok(u.market_rent) ? `${f.usd(u.market_rent)}/mo of market rent is not being collected.` : "Set a market rent to track the loss."} Start a lease on the Rent roll page, or drop a signed lease PDF on the window.`);
  h += `<div class="tk-sec tk-last">` + acts([["rr", "Rent roll", "pri"], u.property_id ? ["prop", "Property"] : null]) + `</div>`;
  return { html: h, acts: { "act:rr": () => go("rentroll"), "act:prop": () => go("property", u.property_id) } };
}

/* ---------- zip ---------- */

async function drawZip(id, row) {
  const zip = String(row?.zip ?? id ?? "");
  if (!/^\d{5}$/.test(zip)) return { html: hdr("ZIP not found") };
  const mk = await tryGet(`/api/market?zip=${zip}`);
  const snap = m => (mk?.zip_snap || []).find(s => s.metric === m) || {};
  const zv = snap("zhvi"), zr = snap("zori");
  const value = row?.value ?? zv.latest ?? null, rent = row?.rent ?? zr.latest ?? null;
  const yld = row?.yield ?? (f.ok(value) && f.ok(rent) && value ? rent * 12 / value : null);
  const ptr = f.ok(value) && f.ok(rent) && rent ? value / (rent * 12) : null;
  const v1 = row?.value_1y ?? zv.chg1y, v5 = row?.value_5y ?? zv.chg5y, r1 = row?.rent_1y ?? zr.chg1y, r5 = row?.rent_5y ?? zr.chg5y;
  const asOf = row?.as_of || zv.as_of || zr.as_of;
  const place = [row?.city || zv.name, row?.state || zv.state].filter(Boolean).join(", ");
  const metro = row?.metro || zv.metro || "";
  let h = hdr(zip, place, metro && metro !== place ? esc(metro) + " metro" : "ZIP-level index");
  if (!f.ok(value) && !f.ok(rent)) {
    h += verdict("check", S.state?.market?.zips ? `<b>No Zillow index for ${zip}.</b> Small or rural ZIPs often have no ZHVI/ZORI.` : `<b>Market data not downloaded.</b> Open Market to download Zillow and FRED data.`);
  } else {
    h += `<div class="tk-sec">` + r3([
      { k: "Home value", v: f.cusd(value) }, { k: "Rent / mo", v: f.usd(rent) }, { k: "Gross yield", v: f.pct(yld), title: "Rent × 12 / value" },
      { k: "Value 1y", v: f.spct(v1), cls: f.cls(v1) }, { k: "Value 5y", v: f.spct(v5), cls: f.cls(v5) }, { k: "Price / rent", v: f.num(ptr, 1), title: "Value / yearly rent" },
      { k: "Rent 1y", v: f.spct(r1), cls: f.cls(r1) }, { k: "Rent 5y", v: f.spct(r5), cls: f.cls(r5) }, { k: "As of", v: f.mo(asOf) },
    ]) + `</div>`;
    const zh = (mk?.zip?.zhvi || []).slice(-60).map(x => x.value), zo = (mk?.zip?.zori || []).slice(-60).map(x => x.value);
    if (zh.length > 1 || zo.length > 1) h += sec("Last 5 years", "", `<div class="tk-spk">`
      + (zh.length > 1 ? `<div><span>Value</span>${C.spark(zh, { w: 190, h: 26, color: "acc", fill: true })}</div>` : "")
      + (zo.length > 1 ? `<div><span>Rent</span>${C.spark(zo, { w: 190, h: 26, color: "amber", fill: true })}</div>` : "") + `</div>`);
    h += `<div class="tk-prov">${src(`Zillow Research ZHVI / ZORI · ZIP-level index${asOf ? " · " + asOf : ""}`, "e")}</div>`;
  }
  h += `<div class="tk-sec tk-last">` + acts([["mkt", "Market", "pri"]]) + `</div>`;
  return { html: h, acts: { "act:mkt": () => { pref("zip", zip); go("market"); } } };
}

/* ---------- bank transaction ---------- */

async function drawTxn(id, row) {
  let t = row && "amount" in row ? row : null;
  if (!t) t = (await tryGet("/api/inbox"))?.txns?.find(x => x.id === +id) || null;
  if (!t) return { html: hdr("Transaction not found", "", "It may have been removed with its file.") };
  const m = parse(t.matched);
  const props = m.property_id ? (await tryGet("/api/inbox"))?.properties || [] : [];
  const propName = id => { const p = props.find(x => x.id === +id); return p ? esc(f.street(p.address)) : `#${id}`; };
  const kindTxt = { payment: "Rent payment", expense: "Expense", debt: "Loan payment", income: "Other income", ignore: "Ignore" }[m.kind] || "No match";
  let h = hdr(f.susd(t.amount, 2), f.dateY(t.date), esc(t.account || ""), m.done ? pill("Applied", "up") : "");
  h = h.replace('<div class="sym">', `<div class="sym ${f.cls(t.amount)}">`);
  h += `<div class="tk-sec"><div class="tk-desc sel-text">${esc(t.description || "—")}</div>`
    + `<div class="tk-mute">${t.document_id ? `File #${t.document_id}` : "Source file unknown"}${t.line ? `, line ${t.line}` : ""}</div></div>`;
  h += sec("Proposed match", f.ok(m.confidence) ? `${f.pct(m.confidence, 0)} confidence` : "", lines([
    ["As", esc(kindTxt)], m.category ? ["Category", esc(m.category)] : null,
    m.lease_id ? ["Lease", `#${m.lease_id}`] : null, m.property_id ? ["Property", propName(m.property_id)] : null,
  ]) + (m.why ? `<div class="tk-mute">${esc(m.why)}</div>` : ""));
  h += `<div class="tk-sec tk-last">` + acts([m.done ? null : ["acc", "Accept", "pri", m.kind ? "" : "disabled"], m.done ? null : ["ign", "Ignore"], ["inbox", "Inbox"]]) + `</div>`;
  return {
    html: h,
    acts: {
      "act:acc": async () => { const r = await post("/api/inbox", { act: "accept_txn", id: t.id }); toast(r.error || "Accepted", r.error ? "bad" : ""); },
      "act:ign": async () => { const r = await post("/api/inbox", { act: "accept_txn", id: t.id, override: { kind: "ignore" } }); toast(r.error || "Ignored", r.error ? "bad" : ""); },
      "act:inbox": () => go("inbox"),
    },
  };
}

/* ---------- comp ---------- */

async function drawComp(id, row) {
  id = id ?? row?.id;
  let pc = S.prop?.comps?.find(c => c.id === +id) || null;
  const subject = row?.subject_id ?? pc?.subject_id ?? S.pid;
  let adj = row?.lines ? row : null;
  if (!adj && subject != null) {
    const cs = await tryGet(`/api/comps/${subject}`);
    adj = [...(cs?.sale || []), ...(cs?.rent || [])].find(c => c.id === +id) || null;
  }
  if (!pc && subject != null && subject !== S.pid) pc = (await tryGet(`/api/property/${subject}`))?.comps?.find(c => c.id === +id) || null;
  const c = { ...(pc || {}), ...(adj || {}), ...(row || {}) };
  if (!c.price && !c.address) return { html: hdr("Comp not found") };
  const rentComp = c.kind === "rent";
  const money = v => (rentComp ? f.usd(v) : f.cusd(v));
  const incl = c.included === 1 || c.included === true;
  let h = hdr(f.street(c.address || "Comp"), rentComp ? "rent comp" : "sale comp", `${f.bb(c)} · ${f.sqft(c.sqft)}${c.year_built ? ` · built ${c.year_built}` : ""}`, pill(incl ? "Included" : "Excluded", incl ? "up" : ""));
  h += `<div class="tk-sec">` + r3([
    { k: rentComp ? "Rent" : "Price", v: money(c.price) }, { k: "Adjusted", v: money(c.adjusted) }, { k: "Gross adj", v: f.pct(c.gross_adj), title: "Sum of absolute adjustments / price" },
    { k: "Distance", v: f.ok(c.dist_mi ?? c.distance) ? f.num(c.dist_mi ?? c.distance, 2) + " mi" : f.DASH }, { k: "Date", v: f.dateY(c.date) },
    { k: "Similarity", v: f.ok(c.correlation) ? f.num(c.correlation, 2) : f.DASH, title: "Correlation score from the data source" },
  ]) + `</div>`;
  const ls = c.lines || [];
  if (ls.length) h += sec("Adjustments", "to the subject", lines([...ls.map(l => [l.k, `${f.susd(l.v)}`, f.cls(l.v)]), ["Adjusted", money(c.adjusted)]]));
  if (c.source) h += `<div class="tk-prov">${src(`Comp: ${c.source}`, srcKind(c.source))}</div>`;
  const sv = await streetBlock(c.lat, c.lon);
  h += sv.html;
  h += `<div class="tk-sec tk-last">` + acts([c.id != null ? ["tog", incl ? "Exclude" : "Include", incl ? "" : "pri"] : null, ["comps", "Comps page"]]) + `</div>`;
  return {
    html: h,
    acts: {
      ...sv.acts,
      "act:tog": async () => {
        const r = await post("/api/comp", { act: "toggle", id: c.id, included: !incl });
        if (r.error) return toast(r.error, "bad");
        if (S.sel?.row) S.sel.row = { ...S.sel.row, included: incl ? 0 : 1 };
        toast(incl ? "Excluded from the reconciled value" : "Included in the reconciled value");
      },
      "act:comps": () => go("comps", subject ?? undefined),
    },
  };
}

/* ---------- debt ---------- */

async function drawDebt(id, row) {
  let d = row && "principal" in row ? row : null;
  if (!d?.schedule) d = (await tryGet("/api/debts"))?.find(x => x.id === +(id ?? row?.id)) || d;
  if (!d) return { html: hdr("Loan not found") };
  const sch = d.schedule || [];
  const yr = d.months_paid != null ? Math.floor(d.months_paid / 12) : null, cur = yr != null ? sch[Math.min(yr, sch.length - 1)] : null;
  const payoff = d.start && d.years ? +String(d.start).slice(0, 4) + Math.round(+d.years) : null;
  const total = d.years ? Math.round(d.years * 12) : null;
  let h = hdr(d.lender || "Loan", d.io ? "interest-only" : "", esc(d.address || ""));
  h += `<div class="tk-sec">` + r3([
    { k: "Balance", v: f.cusd(d.balance) }, { k: "Rate", v: f.pct(d.rate, 3) }, { k: "Payment", v: f.usd(d.payment), title: "Principal and interest per month" },
    { k: "Original", v: f.cusd(d.principal) }, { k: "Term", v: d.years ? `${f.int(d.years)}y` : f.DASH }, { k: "Escrow", v: d.escrow ? f.usd(d.escrow) : f.DASH },
    { k: "Paid", v: total ? `${f.int(d.months_paid)}/${total}` : f.int(d.months_paid), title: "Payments made / total" }, { k: "Start", v: f.mo(d.start) }, { k: "Payoff", v: payoff ? String(payoff) : f.DASH },
  ]) + `</div>`;
  if (cur) h += sec(`Loan year ${cur.year}`, "", lines([["Interest", f.usd(cur.interest)], ["Principal", f.usd(cur.principal)], ["Balance at year end", f.usd(cur.balance)], ["P&I per year", f.usd(d.pi_year)]]));
  if (sch.length > 1) h += sec("Balance", "over the term", `<div class="tk-spk"><div>${C.spark([d.principal, ...sch.map(s => s.balance)], { w: 280, h: 34, color: "acc", fill: true })}</div></div>`);
  h += `<div class="tk-sec tk-last">` + acts([["books", "Books · Debt", "pri"], d.property_id ? ["prop", "Property"] : null]) + `</div>`;
  return { html: h, acts: { "act:books": () => go("books"), "act:prop": () => go("property", d.property_id) } };
}

/* ---------- nothing selected ---------- */

function drawStart() {
  const st = S.state || {}, c = st.counts || {}, cfg = st.config || {};
  let h = hdr("InvestStack", st.demo ? "demo" : "", st.demo ? "Sample market and portfolio around Columbus, OH" : "Your workspace");
  const steps = [
    [`Type an address in the command bar or press <b>A</b>`, "Geocodes it and opens its profile; with a RentCast key it pulls the record, value and rent."],
    [`<a class="link" data-go="search">Search</a> or <a class="link" data-go="screen">Screen</a> listings`, c.listings ? `${f.int(c.listings)} listings on file, ranked by score.` : "None yet: on Search, import a listings CSV (e.g. Redfin's export), paste addresses, or pull live listings with a RentCast key."],
    [`Drop files on the window`, "Bank CSVs, leases and mortgage statements become proposals in the Inbox."],
    [`<a class="link" data-go="portfolio">Portfolio</a> for what you own`, c.owned ? `${f.int(c.owned)} owned properties.` : "Mark a deal acquired, or add a property you own."],
  ];
  h += sec("How to start", "", `<ol class="tk-steps">${steps.map(([a, b]) => `<li><b>${a}</b><span>${b}</span></li>`).join("")}</ol>`);
  if (!cfg.has_rentcast_key) h += verdict("check", `<b>No RentCast key.</b> Without one, value and rent come from free ZIP-level indexes and are marked rough. Add a key in <a class="link" data-go="settings">Settings</a> for AVMs with comps and live listings${f.ok(st.rentcast?.free) ? ` (${f.int(st.rentcast.free)} free calls a month)` : ""}.`);
  h += sec("Workspace", "", lines([["Properties", f.int(c.properties)], ["Deals", f.int(c.deals)], ["Owned", f.int(c.owned)], ["Tasks due", f.int(c.tasks_due), c.tasks_due ? "amb" : ""], ["Inbox", f.int(c.inbox)]]));
  return { html: h };
}

/* ---------- entry ---------- */

const DRAW = { property: drawProperty, deal: drawDeal, lease: drawLease, unit: drawUnit, zip: drawZip, txn: drawTxn, comp: drawComp, debt: drawDebt };
let seq = 0;

export default {
  async render(el, ctx = {}) {
    const my = ++seq, sel = S.sel;
    let out;
    try {
      if (sel && DRAW[sel.kind]) out = await DRAW[sel.kind](sel.id ?? null, sel.row || null);
      else if (S.pid != null) out = S.prop ? await drawProperty(S.pid, null) : { html: hdr("Loading…") };
      else out = drawStart();
    } catch (e) {
      console.error("ticket", e);
      out = { html: hdr("Detail not available", "", esc(String(e?.message || e))) };
    }
    if (my !== seq) return;              // a newer selection arrived while this one loaded
    const top = sel && sel.kind ? `<div class="tk-top"><span>${esc(sel.kind)}</span><button data-act="clear" title="Clear the selection (Esc)">Clear</button></div>` : "";
    const keepTop = el.__key === (sel ? sel.kind + ":" + sel.id : "") ? el.scrollTop : 0;
    el.innerHTML = top + out.html;
    el.__key = sel ? sel.kind + ":" + sel.id : "";
    el.scrollTop = keepTop;
    bind(el, { "act:clear": () => select(null), ...(out.acts || {}) });
    mountSite(el).catch(e => console.error("site map", e));
    out.after?.(el);
  },
};
