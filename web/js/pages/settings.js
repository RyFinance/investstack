// Settings — the workspace (demo or yours), API keys (stored in config.toml in the data folder, never shown back),
// the RentCast budget and this month's usage, the home ZIP, the market data download, and where every number comes from.
import { S, f, post, esc, today } from "../core.js";
import { panel, kv, btn, bind, toast, copy, confirmModal, useCss, pill } from "../ui.js";
import { credentialRows, bindCredentials, currencyOptions } from "../credentials.js";
import { setWorkspace, refreshMarket } from "../shell.js";

const SOURCES = [
  ["Zillow Research", "ZHVI home value and ZORI rent indexes by ZIP and metro, monthly", "none", "Free; attribute \"Source: Zillow Research\". Indexes are ZIP-level, not property values."],
  ["FRED (St. Louis Fed)", "30-yr and 15-yr mortgage rates (Freddie Mac PMMS), 10-yr Treasury, rental vacancy, Case-Shiller", "none", "Public domain or source-attributed series; weekly to quarterly."],
  ["US Census geocoder", "Address → coordinates, county and tract", "none", "Free, public. Nominatim (OpenStreetMap, 1 request / second) is the fallback."],
  ["FHFA HPI", "State and metro house price indexes", "none", "Public domain."],
  ["RentCast", "Records, AVMs with comps, listings", "RentCast key", "Paid API beyond the free tier; responses are cached and only refreshed when you ask."],
  ["Census ACS 5-year", "ZIP (ZCTA) demographics", "Census key", "Public domain; 5-year estimates lag by about two years."],
  ["HUD Fair Market Rents", "FMR by ZIP and bedrooms", "HUD token", "Public domain; set once a year (fiscal year)."],
  ["OpenFreeMap / OpenStreetMap", "Map tiles and building footprints and heights for the 3D view", "none", "Free, no key; map data © OpenStreetMap contributors (ODbL). Heights are missing for many buildings."],
  ["Google Maps Embed", "Street View on the Property page", "Google key", "Google Maps Platform terms; shown in an iframe, nothing stored."],
  ["Your files", "Bank CSVs, leases, mortgage statements dropped on the Inbox", "none", "Kept in the data folder below; never uploaded anywhere."],
];

let showSources = true;

export default {
  id: "settings",
  deps: [],
  async render(root, ctx) {
    useCss("office");
    const st = S.state;
    if (!st) { root.innerHTML = `<div class="empty"><span class="spin"></span><span>Reading settings…</span></div>`; return; }
    const cfg = st.config || {}, rc = st.rentcast || {}, mk = st.market || {}, job = st.job || {}, rates = st.rates || {};
    ctx.sub.innerHTML = `<span class="lbl">Workspace</span>${pill(st.demo ? "Demo" : "Yours", st.demo ? "amb" : "up")}<span class="sep"></span><span class="lbl">Stored in</span><span class="mut" style="font-size:12px">config.toml in the data folder</span>`;
    ctx.bar.innerHTML = "";

    const used = +rc.used || 0, free = +rc.free || 50, allow = +rc.allowance || free, budget = +cfg.rentcast_budget || 0;
    const pctOf = v => Math.max(0, Math.min(100, (v / Math.max(allow, used, 1)) * 100));
    const meter = `<div class="mtr" title="${f.int(used)} calls used of ${f.int(allow)} allowed this month"><i class="${used > free ? "over" : "free"}" style="width:${pctOf(used)}%"></i><b style="left:${pctOf(free)}%" title="free tier ends here"></b></div>`;
    const rateRow = k => (rates[k] ? `${f.num(rates[k].value, 2)}% <span class="faint">${f.dateY(rates[k].date)}</span>` : f.DASH);

    root.innerHTML = `
      <div class="cols2">
        ${panel({
          title: "Workspace", sub: st.demo ? "sample data around Columbus, Ohio" : "your properties and files", flush: true,
          body: kv([
            { k: "Properties", v: f.int(st.counts?.properties) }, { k: "Owned", v: f.int(st.counts?.owned) },
            { k: "Open deals", v: f.int(st.counts?.deals) }, { k: "Inbox files", v: f.int(st.counts?.inbox) },
          ], { cls: "tight c4" })
            + `<div class="note">Two separate databases. The demo has made-up properties, tenants, ledgers and loans so every page has something to show; nothing in it is real. Your workspace starts empty and is filled from the Inbox, the pipeline and your own entries. Switching never deletes either.</div>`
            + `<div class="st-line"><b>Workspace currency</b><select class="sel" data-input="currency" aria-label="Workspace currency">
              ${currencyOptions(cfg.currency)}
            </select><span class="why">One currency per workspace · changing the setting keeps amounts as entered</span></div>`
            + `<div class="ex-foot">${btn("ws-switch", st.demo ? "Switch to your workspace" : "Switch to the demo", { cls: "pri" })}<span class="grow"></span>${st.demo ? btn("ws-reset", "Reset demo data", { cls: "warn", title: "Rebuild the sample data from scratch (your own workspace is not touched)" }) : ""}</div>`,
        })}
        ${panel({
          title: "RentCast budget", sub: rc.has_key ? `${today().slice(0, 7)} usage` : "no key: nothing is called", flush: true,
          body: kv([
            { k: "Used", v: f.int(used), sub: `${f.int(Math.max(0, free - used))} free left` },
            { k: "Allowed", v: f.int(allow), sub: `${f.int(free)} free + ${f.int(budget)} paid` },
            { k: "Billable", v: f.int(rc.billable), cls: rc.billable ? "amb" : "" },
            { k: "Est. cost", v: `USD ${f.num(rc.est_cost, 2)}`, sub: "USD 0.20 per paid call" },
          ], { cls: "tight c4" })
            + `<div class="pb" style="padding-top:8px">${meter}<span class="faint" style="font-size:11px">A property lookup is 1 call, value + rent estimates are 2, a listings pull is 1. Cached answers are free. Calls past the allowance are refused, never charged.</span></div>`
            + `<div class="st-line"><b>Paid calls / month<small>rentcast_budget</small></b><input class="in" data-input="budget" value="${esc(budget)}" inputmode="numeric">${btn("budget-save", "Save")}<span class="why">beyond the free 50 · 0 = free tier only</span></div>`,
        })}
      </div>
      ${panel({ title: "API keys", sub: "Optional data connections", flush: true, right: '<button class="btn ghost" data-go="setup">Open Setup ↗</button>',
        body: `<div class="strip">Keys are saved in <span class="m">config.toml</span> in the data folder and are never sent anywhere except to their own service. InvestStack shows only whether a key is set; to change one, paste the new key.</div>` + credentialRows(cfg) })}
      <div class="cols2">
        ${panel({
          title: "Home market", sub: "default ZIP for Market and new searches", flush: true,
          body: `<div class="st-line"><b>Home ZIP<small>home_zip</small></b><input class="in" data-input="zip" value="${esc(cfg.home_zip || "")}" placeholder="ZIP" maxlength="5" inputmode="numeric">${btn("zip-save", "Save")}<span class="why">${cfg.home_zip ? `set to ${esc(cfg.home_zip)}` : "not set"} · Market opens here when no property is selected</span></div>`,
        })}
        ${panel({
          title: "Market data", sub: mk.zips ? `Zillow ZIP snapshot as of ${f.dateY(mk.as_of)}` : "not downloaded", flush: true,
          body: kv([
            { k: "ZIPs", v: f.int(mk.zips), cls: mk.zips ? "" : "amb" },
            { k: "Index month", v: mk.as_of ? f.mo(mk.as_of) : f.DASH },
            { k: "30-yr fixed", v: rateRow("MORTGAGE30US") }, { k: "10-yr Treasury", v: rateRow("DGS10") },
          ], { cls: "tight c4" })
            + `<div class="ex-foot">${job.busy ? `<span class="amb"><span class="dot busy"></span>${esc(job.step || "Updating")}…</span>` : job.error ? `<span class="down">Last update failed: ${esc(job.error)}</span>` : `<span class="mut">${job.done_at ? `Last update ${esc(f.ago(job.done_at))}` : mk.zips ? "Zillow publishes mid-month; FRED rates weekly." : "Download Zillow and FRED data (about 130 MB, a few minutes)."}</span>`}`
            + `<span class="grow"></span>${btn("mk-refresh", mk.zips ? "Update now" : "Download market data", { cls: mk.zips ? "" : "pri", dis: !!job.busy })}</div>`,
        })}
      </div>
      ${panel({
        title: "Data folder", sub: "database, config, your files", flush: true,
        body: `<div class="st-row"><b>Location</b><span></span><div class="path">${esc(st.data_dir || f.DASH)}</div><div class="ctl">${btn("dir-copy", "Copy path", { dis: !st.data_dir })}</div></div>`
          + `<div class="note">valora.db is your workspace, valora-demo.db the demo, config.toml holds settings and keys (written on the first save), docs/ the files dropped on the Inbox, cache/ downloaded market data and API answers. Back the folder up like any other; set VALORA_HOME to move it.</div>`,
      })}
      ${panel({
        title: "Sources and terms", sub: "where each number comes from", flush: true, right: btn("src-toggle", showSources ? "Hide" : "Show", { cls: "ghost" }),
        body: showSources ? `<table class="t rp-t"><thead><tr><th class="l">Source</th><th class="l">Used for</th><th class="l">Needs</th><th class="l">Terms</th></tr></thead><tbody>`
          + SOURCES.map(([n, u, k, t]) => `<tr><td class="l"><b>${esc(n)}</b></td><td class="l st-wrap">${esc(u)}</td><td class="l">${k === "none" ? `<span class="mut">no key</span>` : esc(k)}</td><td class="l st-wrap mut">${esc(t)}</td></tr>`).join("")
          + `</tbody></table><div class="note">InvestStack does not scrape listing sites. Listings come from RentCast, or from your own exports and alert emails (Search → Import listings).</div>` : "",
      })}`;

    const saveCfg = async (body, msg) => {
      const r = await post("/api/settings", body);
      if (r.error) return toast(r.error, "bad");
      toast(msg);
    };
    const h = {
      "act:ws-switch": () => setWorkspace(!st.demo),
      "act:ws-reset": async () => {
        if (!(await confirmModal("Reset demo data", "Rebuild the demo workspace from scratch? Changes made in the demo (uploads, accepted rows, edits) are lost. Your own workspace is not touched.", "Reset demo"))) return;
        const r = await post("/api/demo/reset", {});
        toast(r.error || "Demo data rebuilt", r.error ? "bad" : "");
      },
      "change:currency": async value => {
        const result = await post("/api/settings", { currency: value });
        toast(result.error || `Workspace currency set to ${value}`, result.error ? "bad" : "");
      },
      "act:budget-save": () => {
        const v = root.querySelector('[data-input="budget"]')?.value.trim();
        if (!/^\d+$/.test(v || "")) return toast("Enter a whole number of calls (0 or more)", "bad");
        saveCfg({ rentcast_budget: +v }, `Budget: ${f.int(+v)} paid calls a month (about ${f.usd(+v * 0.2, 2)} at most)`);
      },
      "act:zip-save": () => {
        const v = root.querySelector('[data-input="zip"]')?.value.trim() || "";
        if (v && !/^\d{5}$/.test(v)) return toast("A ZIP is five digits", "bad");
        saveCfg({ home_zip: v }, v ? `Home ZIP ${v}` : "Home ZIP cleared");
      },
      "enter:zip": () => h["act:zip-save"](),
      "enter:budget": () => h["act:budget-save"](),
      "act:mk-refresh": () => refreshMarket(),
      "act:dir-copy": () => copy(st.data_dir, "Path copied"),
      "act:src-toggle": () => { showSources = !showSources; this.render(root, ctx); },
    };
    bind(root, h);
    bindCredentials(root);
  },
};
