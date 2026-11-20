// Properties — the register of everything tracked: owned assets, deals in the pipeline and listings.
import { S, f, get, go, select, pref, esc } from "../core.js";
import { table, chips, bind, btn, csv, pill, debounce } from "../ui.js";
import { addAddress } from "../shell.js";

let status = pref("pr_status") || "all", cls = "all", q = "", handle = null;
const KIND_CLS = { owned: "up", deal: "amb", listed: "", tracked: "" };

const COLS = [
  { k: "address", label: "Property", l: true, fmt: (v, r) => `<b>${esc(f.street(v))}</b> <span class="mut">${esc(f.city(v))}</span>` },
  { k: "asset_class", label: "Asset class", l: true },
  { k: "status", label: "Status", l: true, fmt: (v, r) => pill(v, KIND_CLS[r.status_kind]) },
  { k: "price", label: "Asking", val: r => r.price ?? r.ask, fmt: v => f.usd(v), title: "Asking price of the active listing, or the deal's ask" },
  { k: "value_est", label: "Value est.", fmt: v => f.usd(v), title: "Latest value estimate on file (source on the property page)" },
  { k: "assessed", label: "Assessed", fmt: v => f.usd(v), title: "Latest assessed value from the tax record" },
  { k: "lot", label: "Site sf", fmt: v => f.int(v) },
  { k: "sqft", label: "Building sf", fmt: v => f.int(v) },
  { k: "units", label: "Units", fmt: v => f.int(v) },
  { k: "year_built", label: "Built", fmt: v => v ?? f.DASH },
  { k: "rent_est", label: "Rent / mo", val: r => r.reported_rent ?? r.rent_est, fmt: (v, r) => f.usd(r.reported_rent ?? v), title: "Reported monthly rent if entered, otherwise an estimate" },
  { k: "cap_gross", label: "Gross yield", fmt: v => f.pct(v), title: "Estimated annual rent over the asking price (or value): before expenses" },
];

export default {
  id: "properties",
  deps: [],
  async render(root, ctx) {
    const all = await get("/api/properties");
    const classes = [...new Set(all.map(r => r.asset_class))].sort();
    const n = k => all.filter(r => r.status_kind === k).length;
    ctx.sub.innerHTML = chips("status", [{ v: "all", label: "All", sub: all.length }, { v: "owned", label: "Owned", sub: n("owned") }, { v: "deal", label: "Pipeline", sub: n("deal") }, { v: "listed", label: "Listed", sub: n("listed") }], status)
      + `<span class="sep"></span>` + chips("cls", [{ v: "all", label: "All classes" }, ...classes.map(c => ({ v: c, label: c }))], cls)
      + `<span class="sep"></span><label class="fld"><input data-input="q" value="${esc(q)}" placeholder="Filter by address" style="width:170px;text-align:left"></label>`;
    ctx.bar.innerHTML = btn("add", "+ Address", { cls: "pri" }) + btn("csv", "Export");
    const rows = all.filter(r => (status === "all" || r.status_kind === status) && (cls === "all" || r.asset_class === cls)
      && (!q || r.address.toLowerCase().includes(q.toLowerCase()))).map(r => ({ ...r, key: r.id }));
    if (!root.querySelector("#pr-t")) { root.classList.add("fill"); root.innerHTML = `<section class="pnl grow"><div id="pr-t" class="tbl-host grow"></div></section>`; }
    handle = table(root.querySelector("#pr-t"), { id: "pr-t", cols: COLS, rows, sel: S.sel?.kind === "property" ? S.sel.id : null, sort: { k: "status", dir: 1 }, limit: 150,
      empty: all.length ? "Nothing matches the filters" : "No properties yet. Add an address, import listings on Discover, or drop a file on the window.",
      onRow: r => { select({ kind: "property", id: r.id, row: r }); handle?.setSel(r.id); }, onDbl: r => go("property", r.id) });
    const redraw = () => this.render(root, ctx);
    bind(ctx.sub, { "chip:status": v => { status = pref("pr_status", v); redraw(); }, "chip:cls": v => { cls = v; redraw(); }, "input:q": debounce(v => { q = v; redraw().then(() => { const i = ctx.sub.querySelector("[data-input=q]"); i?.focus(); i?.setSelectionRange(q.length, q.length); }); }, 200) });
    bind(ctx.bar, { "act:add": () => addAddress(), "act:csv": () => csv("valora-properties.csv", COLS.map(c => ({ k: c.k, label: c.label, val: c.val })), rows) });
  },
  key(e) { if (e.key === "Enter" && S.sel?.kind === "property") { go("property", S.sel.id); return true; } return false; },
};
