// Pipeline — acquisition deals through seven stages: board (drag and drop) or table, the selected deal's
// checklist, log and terms, and every open task across deals by due date.
import { S, f, get, post, go, select, pref, daysTo, today, esc } from "../core.js";
import { table, panel, kv, chips, btn, sep, bind, toast, formModal, confirmModal, propLink, scoreBar, pill, csv, selectBox, parseNum, useCss } from "../ui.js";

useCss("pipeline");

const ACTIVE = ["discovered", "researching", "underwriting", "diligence", "offer"];
const CHECK = { researching: 4, underwriting: 4, diligence: 6, offer: 5 };   // checklist tasks the engine adds (valora/pipeline.py)
const STRATS = [{ v: "rental", label: "Rental" }, { v: "brrrr", label: "BRRRR" }, { v: "flip", label: "Flip" }];
const TYPE_ABBR = { "Single Family": "SFR", "Multi-Family": "MF", Condo: "Condo", Townhouse: "TH", Duplex: "Duplex", Triplex: "Triplex", Fourplex: "4-plex" };

let view = pref("pl.view") || "board";
let focusId = null;           // the deal shown in the detail area when the ticket holds something else
let lastData = null;

const inDays = s => (s ? Math.max(0, -daysTo(String(s).slice(0, 10))) : null);
const dueCls = d => (!d ? "" : daysTo(d) < 0 ? "down" : daysTo(d) <= 7 ? "amb" : "");
const dueTxt = d => {
  if (!d) return f.DASH;
  const n = daysTo(d);
  return `${f.date(d)} <span class="${n < 0 ? "down" : "mut"}">${n < 0 ? `${-n}d late` : n === 0 ? "today" : `in ${n}d`}</span>`;
};
const typeAbbr = d => [TYPE_ABBR[d.type] || d.type || "", d.units > 1 ? `${d.units}u` : ""].filter(Boolean).join(" ");
const offAsk = d => (f.ok(d.offer) && f.ok(d.ask) && d.ask ? d.offer / d.ask - 1 : null);
const labelOf = (stages, id) => stages.find(s => s.id === id)?.label || id || f.DASH;

function selectedId(deals) {
  if (S.sel?.kind === "deal" && deals.some(d => d.id === +S.sel.id)) return +S.sel.id;
  if (focusId != null && deals.some(d => d.id === focusId)) return focusId;
  const pick = deals.find(d => ACTIVE.includes(d.stage)) || deals[0];
  return pick ? pick.id : null;
}

/* ---------- move a deal (board drop, detail chips) ---------- */

async function moveDeal(d, stage, stages) {
  if (!d || !stage || d.stage === stage) return;
  let reason = "";
  if (stage === "rejected") {
    const v = await formModal(`Reject ${f.street(d.address)}`, [
      { k: "reason", label: "Reason", type: "select", value: "Numbers don't work at the ask", options: ["Numbers don't work at the ask", "Seller won't negotiate", "Inspection findings", "Location / neighbourhood", "Financing", "Outbid", "Other"] },
      { k: "note", label: "Detail (optional)", full: true, ph: "e.g. CoC 3.1% at $204K; seller firm" },
    ], { ok: "Reject deal", note: "The reason goes into the deal log. You can move it back later." });
    if (!v) return;
    reason = [v.reason, v.note].filter(Boolean).join(": ");
  } else if (stage === "acquired") {
    const price = f.ok(d.offer) ? d.offer : d.ask;
    const ok = await confirmModal(`Mark ${f.street(d.address)} acquired`,
      `This marks the property as owned and adds it to Portfolio with purchase price ${f.usd(price)} (${f.ok(d.offer) ? "your offer" : "the ask"}) dated ${f.dateY(today())}. Edit both later in Portfolio.`, "Mark acquired");
    if (!ok) return;
  }
  const r = await post("/api/pipeline", { act: "move", id: d.id, stage, reason });
  if (r.error) return toast(r.error, "bad");
  const lab = labelOf(stages, stage);
  toast(stage === "acquired" ? `${f.street(d.address)} acquired — now in Portfolio`
    : CHECK[stage] ? `Moved to ${lab}. ${CHECK[stage]} checklist tasks added (existing ones are kept).` : `Moved to ${lab}`);
}

/* ---------- markup ---------- */

function card(d, sel) {
  const days = inDays(d.stage_entered), oa = offAsk(d);
  const tasks = d.stage === "rejected" && d.reason ? `<span class="faint pl-why">${esc(d.reason.split(":")[0])}</span>`
    : d.open_tasks ? `<span class="${dueCls(d.next_due)}" title="Open tasks · next due">${d.open_tasks}t · ${f.date(d.next_due)}</span>` : `<span class="faint">no tasks</span>`;
  return `<div class="card pl-card${d.id === sel ? " on" : ""}${d.stage !== "rejected" && d.stage !== "acquired" && d.open_tasks ? " pl-" + (dueCls(d.next_due) || "ok") : ""}" draggable="true" data-deal="${d.id}" title="${esc(d.address)}${d.reason && d.stage === "rejected" ? "\nReason: " + esc(d.reason) : ""}">`
    + `<b>${esc(f.street(d.address))}</b>`
    + `<div class="m">${esc(d.zip || "")}${typeAbbr(d) ? " · " + esc(typeAbbr(d)) : ""}</div>`
    + `<div class="r"><span title="Ask">${f.cusd(d.ask)}</span><span title="Days in this stage" class="mut">${f.days(days)}</span></div>`
    + (f.ok(d.offer) ? `<div class="r"><span class="amb" title="Offer">off ${f.cusd(d.offer)}</span><span class="${f.cls(oa)}" title="Offer vs ask">${f.spct(oa, 0)}</span></div>` : "")
    + `<div class="r pl-meta">${tasks}</div></div>`;
}

function board(data, sel) {
  return `<div class="board pl-board" title="Drag a card to another column to move the deal. Moving into a stage adds its checklist.">` + data.stages.map(s => {
    const ds = data.deals.filter(d => d.stage === s.id);
    const ask = ds.reduce((a, d) => a + (+d.ask || 0), 0);
    return `<div class="col pl-col${ACTIVE.includes(s.id) ? "" : " pl-closed"}" data-stage="${s.id}">`
      + `<h4><span>${esc(s.label)}</span><i title="Deals · total ask">${ds.length}${ask ? " · " + f.cusd(ask) : ""}</i></h4>`
      + `<div class="pl-cards">${ds.map(d => card(d, sel)).join("") || `<div class="pl-none">Drop a deal here</div>`}</div></div>`;
  }).join("") + `</div>`;
}

function headline(data) {
  const act = data.deals.filter(d => ACTIVE.includes(d.stage));
  const due = data.tasks.filter(t => t.due && daysTo(t.due) <= 7), late = data.tasks.filter(t => t.due && daysTo(t.due) < 0);
  const ask = act.reduce((a, d) => a + (+d.ask || 0), 0), offers = act.filter(d => f.ok(d.offer));
  const avg = act.length ? act.reduce((a, d) => a + (inDays(d.stage_entered) || 0), 0) / act.length : null;
  const n = id => data.deals.filter(d => d.stage === id).length;
  return kv([
    { k: "Active deals", v: f.int(act.length), sub: `${f.int(data.deals.length)} total` },
    { k: "Total ask", v: act.length ? f.cusd(ask) : f.DASH, title: "Sum of asking prices of active deals (Discovered through Offer)" },
    { k: "Offers out", v: f.int(offers.length), sub: offers.length ? f.cusd(offers.reduce((a, d) => a + d.offer, 0)) : "" },
    { k: "Tasks due 7d", v: f.int(due.length), cls: due.length ? "amb" : "", sub: `${f.int(data.tasks.length)} open`, title: "Open tasks due within 7 days, overdue included" },
    { k: "Overdue", v: f.int(late.length), cls: late.length ? "down" : "" },
    { k: "Avg days", v: avg == null ? f.DASH : f.num(avg, 1), sub: "in stage", title: "Average days in the current stage, active deals" },
    { k: "Closed", v: `${f.int(n("acquired"))} / ${f.int(n("rejected"))}`, sub: "acq. · rej.", title: "Acquired / rejected" },
  ], { cls: "tight" });
}

function detail(d, det, stages) {
  if (!d) return panel({ title: "Deal", body: `<div class="empty"><b>No deal selected</b><span>Click a card on the board or a row in the table.</span></div>` });
  const deal = { ...d, ...(det?.deal || {}) };
  const days = inDays(deal.stage_entered), oa = offAsk(deal);
  const tasks = det?.tasks || [], events = det?.events || [];
  const open = tasks.filter(t => !t.done), done = tasks.filter(t => t.done);
  const head = `<a class="link" data-prop="${deal.property_id}" data-go="property">Property</a>`
    + `<a class="link" data-prop="${deal.property_id}" data-go="underwrite">Underwrite</a>`
    + `<a class="link" data-prop="${deal.property_id}" data-go="comps">Comps</a>`;
  const stageChips = chips("move", stages.map(s => ({ v: s.id, label: s.label, cls: s.id === "rejected" ? "pl-rej" : "" })), deal.stage);
  const chk = t => `<label class="chk${t.done ? " done" : ""}"><input type="checkbox" data-task="${t.id}"${t.done ? " checked" : ""}>`
    + `<span>${esc(t.title)}</span><em class="${t.done ? "" : daysTo(t.due) < 0 ? "late" : ""}">${t.due ? f.date(t.due) + (t.done ? "" : daysTo(t.due) < 0 ? ` · ${-daysTo(t.due)}d late` : "") : f.DASH}</em></label>`;
  const due7 = new Date(Date.parse(today() + "T12:00:00Z") + 7 * 864e5).toISOString().slice(0, 10);
  return `<section class="pnl pl-detail">`
    + `<div class="ph"><h3>${esc(f.street(deal.address))}</h3><span class="s">${esc(f.city(deal.address))}${typeAbbr(deal) ? " · " + esc(typeAbbr(deal)) : ""} · ${f.bb(deal)} · ${f.sqft(deal.sqft)}</span>`
    + `<div class="r pl-links">${pill(labelOf(stages, deal.stage), deal.stage === "acquired" ? "up" : deal.stage === "rejected" ? "down" : deal.stage === "offer" ? "amb" : "")}${head}</div></div>`
    + kv([
      { k: "In stage", v: f.days(days), sub: f.dateY(deal.stage_entered), title: "Days since the deal entered its current stage" },
      { k: "Ask", v: f.usd(deal.ask), title: f.ok(deal.ask) && deal.sqft ? `${f.usd(deal.ask / deal.sqft)} per sf` : "" },
      { k: "Offer", v: f.usd(deal.offer), sub: oa != null ? `<span class="${f.cls(oa)}">${f.spct(oa)} vs ask</span>` : "", title: "Your offer; the sub-line is its gap to the ask" },
      { k: "Open tasks", v: f.int(open.length), sub: `${done.length} done`, title: `In pipeline ${f.days(inDays(deal.created))}, added ${f.dateY(deal.created)}` },
    ], { cls: "tight" })
    + `<div class="pl-row"><span class="lbl">Move to</span>${stageChips}</div>`
    + `<div class="pl-row pl-terms"><span class="pl-f"><span class="lbl">Ask</span><label class="fld"><span>$</span><input data-input="ask" value="${f.ok(deal.ask) ? Math.round(deal.ask) : ""}" inputmode="decimal" autocomplete="off" style="width:84px"></label></span>`
    + `<span class="pl-f"><span class="lbl">Offer</span><label class="fld"><span>$</span><input data-input="offer" value="${f.ok(deal.offer) ? Math.round(deal.offer) : ""}" inputmode="decimal" autocomplete="off" placeholder="—" style="width:84px"></label></span>`
    + `<span class="pl-f">${selectBox("strategy", STRATS, deal.strategy || "rental", { label: "Strategy" })}</span>`
    + btn("terms", "Save terms", { cls: "pri" })
    + (deal.reason && deal.stage === "rejected" ? `<span class="pl-reason mut" title="${esc(deal.reason)}">Reason: ${esc(deal.reason)}</span>` : "")
    + `<span style="margin-left:auto"></span>${btn("del", "Remove from pipeline", { cls: "ghost", title: "Delete this deal, its tasks and its log. The property stays." })}</div>`
    + `<div class="cols2 pl-split">`
    + `<div class="pl-sub"><h4>Checklist <em class="m">${open.length} open${open.some(t => daysTo(t.due) < 0) ? ` · <span class="down">${open.filter(t => daysTo(t.due) < 0).length} late</span>` : ""}</em></h4>`
    + (tasks.length ? open.map(chk).join("") + done.map(chk).join("")
      : `<div class="note">No tasks. Moving the deal to Researching, Underwriting, Due diligence or Offer adds that stage's checklist; or add one below.</div>`)
    + `<div class="pl-add"><input class="pl-in" data-input="tk-title" placeholder="New task" autocomplete="off" spellcheck="false">`
    + `<input class="pl-in pl-date" type="date" data-input="tk-due" value="${due7}">${btn("task", "Add task")}</div></div>`
    + `<div class="pl-sub"><h4>Log <em class="m">${events.length} events</em></h4>`
    + `<div class="pl-add pl-add-top"><input class="pl-in" data-input="note" placeholder="Add a note (Enter)" autocomplete="off" spellcheck="true">${btn("note", "Add note")}</div>`
    + `<div class="pl-log">${events.map(e => `<div class="ev"><i>${f.date(e.ts)} ${esc(String(e.ts || "").slice(11, 16))}</i>`
      + `<span class="tag ${e.kind === "stage" ? "acc" : e.kind === "offer" ? "amb" : "mut"}">${esc(e.kind || "note")}</span> ${esc(e.text)}</div>`).join("") || `<div class="note">Nothing logged yet.</div>`}</div></div>`
    + `</div></section>`;
}

/* ---------- tables ---------- */

const dealCols = stages => {
  const order = Object.fromEntries(stages.map((s, i) => [s.id, i]));
  const narrow = window.innerWidth < 1320;   // ticket hidden or tight: drop secondary columns so Tasks / Next due stay visible
  return [
    { k: "address", label: "Property", l: true, val: d => d.address, fmt: (v, d) => propLink(d) },
    { k: "zip", label: "ZIP", l: true, hide: narrow },
    { k: "stage", label: "Stage", l: true, val: d => order[d.stage] ?? 99, fmt: (v, d) => esc(labelOf(stages, d.stage)), cls: (v, d) => (d.stage === "rejected" ? "mut" : d.stage === "acquired" ? "up" : "") },
    { k: "days", label: "Days", title: "Days in the current stage", val: d => inDays(d.stage_entered), fmt: v => f.int(v) },
    { k: "type", label: "Type", l: true, val: d => typeAbbr(d) || null },
    { k: "beds", label: "Bd/Ba", val: d => d.beds, fmt: (v, d) => `${f.ok(d.beds) ? +d.beds : f.DASH}/${f.ok(d.baths) ? +d.baths : f.DASH}` },
    { k: "sqft", label: "Sqft", fmt: v => f.int(v), hide: narrow },
    { k: "ask", label: "Ask", fmt: v => f.usd(v) },
    { k: "ppsf", hide: narrow, label: "$/sf", title: "Ask per square foot", val: d => (f.ok(d.ask) && d.sqft ? d.ask / d.sqft : null), fmt: v => f.usd(v) },
    { k: "offer", label: "Offer", fmt: v => f.usd(v) },
    { k: "oa", label: "Off/ask", title: "Offer relative to the ask", val: offAsk, fmt: v => f.spct(v), cls: v => f.cls(v) },
    { k: "score", hide: narrow, label: "Score", title: "Score saved when the deal was added", fmt: v => scoreBar(v) },
    { k: "strategy", hide: narrow, label: "Strat", l: true, fmt: v => esc(STRATS.find(s => s.v === v)?.label || v || f.DASH) },
    { k: "open_tasks", label: "Tasks", title: "Open tasks", fmt: v => f.int(v) },
    { k: "next_due", label: "Next due", val: d => (d.stage === "rejected" ? null : d.next_due), fmt: v => dueTxt(v), cls: v => dueCls(v) },
    { k: "reason", label: "Reason", l: true, val: d => (d.stage === "rejected" ? d.reason || null : null), fmt: v => (v ? `<span class="mut" title="${esc(v)}">${esc(String(v).slice(0, 34))}</span>` : "") },
  ];
};

const taskCols = stagesOf => [
  { k: "done", label: "", sort: false, c: true, w: 26, fmt: (v, t) => `<input type="checkbox" class="pl-tick" data-task="${t.id}" title="Mark done">` },
  { k: "due", label: "Due", l: true, fmt: v => (v ? `<span title="${daysTo(v) < 0 ? `${-daysTo(v)} days overdue` : daysTo(v) === 0 ? "Due today" : `Due in ${daysTo(v)} days`}">${f.date(v)}</span>` : f.DASH), cls: v => dueCls(v) },
  { k: "title", label: "Task", l: true, fmt: v => `<span class="pl-tt">${esc(v)}</span>` },
  { k: "address", label: "Property", l: true, fmt: (v, t) => (t.property_id ? propLink(t) : f.DASH) },
];

/* ---------- page ---------- */

const page = {
  id: "pipeline",
  deps: ["sel"],
  async render(root, ctx) {
    let data;
    try { data = await get("/api/pipeline"); } catch (e) {
      root.innerHTML = `<div class="empty"><b>The pipeline did not load</b><span>${esc(e.message || e)}</span></div>`;
      return;
    }
    const stages = data?.stages?.length ? data.stages : ["discovered", "researching", "underwriting", "diligence", "offer", "acquired", "rejected"].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
    // open tasks of live deals only: a rejected deal's leftover checklist is not work to do
    const rejected = new Set((data?.deals || []).filter(x => x.stage === "rejected").map(x => x.id));
    data = { stages, deals: data?.deals || [], tasks: (data?.tasks || []).filter(t => !t.done && !rejected.has(t.deal_id)) };
    lastData = data;
    const sel = selectedId(data.deals);
    const d = data.deals.find(x => x.id === sel) || null;
    let det = null;
    if (d) { try { det = await get(`/api/deal/${d.id}`); } catch (e) { det = null; } }

    // command bar
    const p = S.prop?.property, canAdd = p && !S.prop?.deal;
    ctx.sub.innerHTML = chips("view", [{ v: "board", label: "Board" }, { v: "table", label: "Table" }], view, { label: "View" })
      + (canAdd ? sep() + btn("addcur", `+ Pipeline: ${f.street(p.address)}`, { title: "Add the selected property as a deal at Discovered, ask = its listing price" }) : "");
    bind(ctx.sub, {
      "chip:view": v => { view = v; pref("pl.view", v); page.render(root, { ...ctx, reason: "prefs" }); },
      "act:addcur": async () => {
        const q = S.prop?.quick || {};
        const r = await post("/api/pipeline", { act: "add", property_id: p.id, ask: S.prop?.listing?.price ?? null, strategy: "rental", score: f.ok(q.score) ? Math.round(q.score) : null });
        if (r.error) return toast(r.error, "bad");
        focusId = r.id;
        toast(`${f.street(p.address)} added at Discovered`);
      },
    });
    ctx.bar.innerHTML = btn("csv", "CSV", { title: "Export all deals" });
    bind(ctx.bar, {
      "act:csv": () => csv("valora-pipeline.csv", ["id", "address", "zip", "stage", "stage_entered", "ask", "offer", "strategy", "score", "open_tasks", "next_due", "reason", "created", "closed"].map(k => ({ k })), data.deals),
    });

    if (!data.deals.length) {
      root.innerHTML = panel({ flush: true, body: headline(data) })
        + panel({ title: "No deals yet", body: `<div class="empty"><b>Add a property to the pipeline to start tracking it</b>`
          + `<span>Use <span class="tag">+ Pipeline</span> on a Search or Screen row, on the ticket, or on a Property page. Each stage you move a deal into adds its checklist (zoning, tax bill, comps, inspection, title…) with due dates.</span>`
          + `<span><a class="link" data-go="search">Open Search</a> · <a class="link" data-go="screen">Open Screen</a></span></div>` })
        + panel({ title: "Tasks", sub: "all deals, by due date", body: `<div class="note">No open tasks.</div>` });
      return;
    }

    root.innerHTML = panel({ flush: true, body: headline(data) })
      + (view === "board" ? board(data, sel) : panel({ title: "All deals", sub: "click a row for its detail · double-click opens the property", flush: true, cls: "pl-host", body: `<div id="pl-table"></div>` }))
      + `<div class="cols2 w32 pl-lower"><div id="pl-detail">${detail(d, det, stages)}</div>`
      + panel({ title: "Tasks", sub: `all deals · ${data.tasks.length} open · by due date`, flush: true, body: `<div id="pl-tasks"></div>` }) + `</div>`;

    if (view === "table") {
      table(root.querySelector("#pl-table"), {
        id: "pl-deals", rows: data.deals, cols: dealCols(stages), key: r => r.id, sel, sort: { k: "stage", dir: 1 }, maxH: 360,
        rowCls: r => (r.stage === "rejected" ? "dim" : ""),
        onRow: r => { focusId = r.id; select({ kind: "deal", id: r.id, row: r }); },
        onDbl: r => go("property", r.property_id),
      });
    }
    const stageOf = t => labelOf(stages, data.deals.find(x => x.id === t.deal_id)?.stage);
    table(root.querySelector("#pl-tasks"), {
      id: "pl-tasks", rows: data.tasks.map(t => ({ ...t })), cols: taskCols(stageOf), key: r => r.id, sort: { k: "due", dir: 1 }, maxH: 420, nav: false,
      rowCls: r => (r.deal_id === sel ? "pl-mine" : ""),
      empty: "No open tasks. Moving a deal into a stage adds its checklist.",
      onRow: r => { const x = data.deals.find(z => z.id === r.deal_id); if (x) { focusId = x.id; select({ kind: "deal", id: x.id, row: x }); } },
    });

    wire(root, stages);
  },
};
export default page;

/* ---------- events ---------- */

function current() {
  const id = selectedId(lastData?.deals || []);
  return (lastData?.deals || []).find(d => d.id === id) || null;
}

function wire(root, stages) {
  bind(root, {
    "chip:move": v => moveDeal(current(), v, stages),
    "act:terms": async () => {
      const d = current();
      if (!d) return;
      const val = n => root.querySelector(`[data-input="${n}"]`)?.value ?? "";
      const ask = parseNum(val("ask")), offerRaw = val("offer").trim(), offer = offerRaw === "" ? null : parseNum(offerRaw);
      if (offerRaw !== "" && offer == null) return toast("Offer is not a number", "bad");
      const body = { act: "update", id: d.id, strategy: val("strategy") || d.strategy };
      if (ask !== (d.ask ?? null)) body.ask = ask;
      if (offer !== (d.offer ?? null)) body.offer = offer;
      const r = await post("/api/pipeline", body);
      toast(r.error || ("offer" in body ? `Offer ${offer == null ? "cleared" : "set to " + f.usd(offer)}` : "Saved"), r.error ? "bad" : "");
    },
    "enter:ask": () => root.querySelector('[data-act="terms"]')?.click(),
    "enter:offer": () => root.querySelector('[data-act="terms"]')?.click(),
    "act:task": async () => addTask(root),
    "enter:tk-title": async () => addTask(root),
    "act:note": async () => addNote(root),
    "enter:note": async () => addNote(root),
    "act:del": async () => {
      const d = current();
      if (!d) return;
      if (!(await confirmModal("Remove from pipeline", `Delete the deal for <b>${esc(f.street(d.address))}</b>, its tasks and its log? The property and its estimates stay. This cannot be undone.`, "Remove"))) return;
      const r = await post("/api/pipeline", { act: "delete", id: d.id });
      if (r.error) return toast(r.error, "bad");
      if (S.sel?.kind === "deal" && +S.sel.id === d.id) select(null);
      focusId = null;
      toast("Deal removed");
    },
  });

  // checklist ticks (change on a checkbox, not a click handler, so the label toggles too)
  if (!root.__plChk) {
    root.__plChk = true;
    root.addEventListener("change", async e => {
      const cb = e.target.closest?.("input[data-task]");
      if (!cb) return;
      const r = await post("/api/pipeline", { act: "task_done", task_id: +cb.dataset.task, done: cb.checked });
      if (r.error) toast(r.error, "bad");
    });
    // card click selects; drag and drop moves
    root.addEventListener("click", e => {
      const c = e.target.closest(".pl-card");
      if (!c || e.target.closest("a")) return;
      const d = lastData?.deals.find(x => x.id === +c.dataset.deal);
      if (d) { focusId = d.id; select({ kind: "deal", id: d.id, row: d }); }
    });
    root.addEventListener("dblclick", e => {
      const c = e.target.closest(".pl-card");
      const d = c && lastData?.deals.find(x => x.id === +c.dataset.deal);
      if (d) go("property", d.property_id);
    });
    root.addEventListener("dragstart", e => {
      const c = e.target.closest?.(".pl-card");
      if (!c) return;
      e.dataTransfer.setData("text/plain", c.dataset.deal);
      e.dataTransfer.effectAllowed = "move";
      c.classList.add("pl-drag");
      root.__dragId = +c.dataset.deal;
    });
    root.addEventListener("dragend", e => {
      e.target.closest?.(".pl-card")?.classList.remove("pl-drag");
      root.querySelectorAll(".pl-col.over").forEach(x => x.classList.remove("over"));
      root.__dragId = null;
    });
    root.addEventListener("dragover", e => {
      const col = e.target.closest?.(".pl-col");
      if (!col || root.__dragId == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      root.querySelectorAll(".pl-col.over").forEach(x => x !== col && x.classList.remove("over"));
      col.classList.add("over");
    });
    root.addEventListener("dragleave", e => {
      const col = e.target.closest?.(".pl-col");
      if (col && !col.contains(e.relatedTarget)) col.classList.remove("over");
    });
    root.addEventListener("drop", e => {
      const col = e.target.closest?.(".pl-col");
      if (!col) return;
      e.preventDefault();
      col.classList.remove("over");
      const id = +(e.dataTransfer.getData("text/plain") || root.__dragId);
      const d = lastData?.deals.find(x => x.id === id);
      root.__dragId = null;
      if (d && d.stage !== col.dataset.stage) { focusId = d.id; moveDeal(d, col.dataset.stage, lastData.stages); }
    });
  }
}

async function addTask(root) {
  const d = current();
  const t = root.querySelector('[data-input="tk-title"]'), due = root.querySelector('[data-input="tk-due"]');
  const title = t?.value.trim();
  if (!d || !title) { t?.focus(); return; }
  const r = await post("/api/pipeline", { act: "task", id: d.id, property_id: d.property_id, title, due: due?.value || null });
  toast(r.error || `Task added${due?.value ? ", due " + f.date(due.value) : ""}`, r.error ? "bad" : "");
}

async function addNote(root) {
  const d = current();
  const n = root.querySelector('[data-input="note"]'), text = n?.value.trim();
  if (!d || !text) { n?.focus(); return; }
  const r = await post("/api/pipeline", { act: "note", id: d.id, text });
  toast(r.error || "Note added", r.error ? "bad" : "");
}
