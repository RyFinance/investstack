# Valora — build contract

Valora is a desktop real-estate desk (Mac + Windows): prospect properties, underwrite them, run an acquisition
pipeline, and manage the properties you own.

**Design language (2026-11-16, current): Concrete / Charcoal, a technical tool.** Monochrome surfaces
(navigation #222321 · workspace #292A28 · panels #333531 · elevated #41433E · borders #51534D · text #E6E5DF /
#A4A59D / #777970 · highlight #C0C0B6), all as tokens in `web/style.css` `:root`. Status colours only where they
mean something: muted sage (up), brick (down), ochre (warning). No gold, navy, gradients or neon. Inter for the
interface, IBM Plex Mono for figures. Continuous surfaces with hairline separators and 2–3px corners, not rounded
cards; panel headers are 40px bars with small-caps titles; tables are first-class (30px header, 34px rows).
The sidebar is plain navigation (workspace name, sections, flat 30px rows, a 2px left marker on the active row): no
logo. Editable parameters are boxed inputs; calculated figures are plain text with a "calculated" marker; every
important figure can show its source, unit, date, method and status (verified / estimate / entered / assumed /
illustrative). Illustrative data is always labelled. The Development Studio (`pages/studio.js`) is the reference
for this language.

- Engine: Python 3.12 in `.venv`, package `valora/`, SQLite in the OS data folder, stdlib HTTP server on 127.0.0.1:8780.
- Frontend: `web/` vanilla ES modules, **no build step, no npm, no frameworks**. One module per page in `web/js/pages/<id>.js`.
- Two workspaces: **demo** (sample market + portfolio around Columbus OH, on by default) and the user's own.

## Running and testing (no server needed)

```bash
.venv/bin/python -m valora api GET  /api/portfolio            # print any GET route's JSON
.venv/bin/python -m valora api POST /api/underwrite '{"strategy":"rental","inputs":{"price":200000,"rent_month":2000}}'
tools/snap "index.html#/portfolio" /tmp/x.png --w 1440 --h 900 --strict --text     # headless render; prints console + JS errors
tools/snap "index.html#/property/5" out.png --js "document.querySelector('[data-act=save]').click()" --after 1 --eval "document.title"
```

`tools/snap` MUST be run with the sandbox disabled (it needs WebKit). It answers `/api/*` through the CLI, so POSTs
made by the page really write to the demo database — that is fine, but do not delete demo data in tests; to restore
it run `.venv/bin/python -m valora demo`. Always look at the PNG you produce (Read tool) — a page with zero JS errors
can still look broken. Check paper (default), `--dark`, and `--w 1100`.

**Always inspect the real JSON** of a route with the CLI before writing code against it. Shapes below are summaries.

## Units

Money: dollars (float). Rates and percentages: fractions (0.065). Dates: `YYYY-MM-DD`. Rent: per month unless named `_year`.
`null` means unknown — show `—` (f.DASH), never 0, and never invent a number.

## Honesty rules (the product's edge)

1. Every estimate shows its **source and date** (`src()` helper or a muted sub-line): "RentCast AVM 2026-11-01", "Zillow ZORI (ZIP) × bedroom factor — rough", "1.2% of price (assumed)", "DEMO estimate".
2. An AVM is shown with its **range** and comp count, never as a bare number. ZIP indexes are labelled as ZIP-level.
3. Missing data never blocks: show the result with what exists and list what is missing and where to get it (`profile.missing`).
4. Data entry starts from files the user already has (Inbox). Forms are the fallback, kept short.
5. "Schedule-E style, not tax advice." "Demo data" wherever source is DEMO.

## Shell (already built — do not edit `core.js`, `ui.js`, `shell.js`, `charts.js`, `map.js`, `style.css`, `css/valora.css`, `index.html`)

If you need something they lack, add it in your own page module (or `web/css/<pageid>.css` loaded with `useCss("<pageid>")`).
Layout: left rail · search header · toolbar (`#sub` = page controls, `#bar-r` = right-hand actions; keep them few so the row does not overflow at 1100px) ·
main page · right **ticket** inspector (332px, hidden under 1180px width) · status bar.

### Page module contract

```js
// web/js/pages/<id>.js
import { S, f, get, post, go, select, on, pref, esc } from "../core.js";
import { table, panel, kv, chips, field, btn, bind, toast, formModal } from "../ui.js";
import * as C from "../charts.js";
export default {
  id: "<id>",
  deps: ["sel"],            // extra events that should re-render this page: "sel" | "prefs" | "theme"  ("data" and, for prop pages, "prop" always do)
  async render(root, ctx) { // ctx = { reason: "show"|"data"|"prop"|"sel"|"prefs"|"theme", sub: #sub element, bar: #bar-r element }
    // root is this page's <div class="page">; set root.innerHTML, then mount tables/charts into it.
    // Put filters/toggles in ctx.sub (chips(), field(), btn()) and wire them with bind(ctx.sub, {...}).
  },
  leave() {},               // optional: page hidden (destroy maps here)
  key(e) { return false; }, // optional: page-specific keys; return true if handled
};
```

- `render` is called again on every relevant event. Keep module-level state (filters, selected tab) in module variables or `pref()`.
  Avoid full re-renders on `sel` unless needed (use `table().setSel(id)`); never rebuild a MapLibre map on re-render — keep the instance in a module variable and call `setPoints`.
- Pages in group `prop` (property, comps, underwrite) are only rendered when `S.prop` exists (`S.prop` = GET /api/property/<id>).
- Reads: `await get("/api/…")` (cached until the next write). Writes: `await post("/api/…", body)` → invalidates, reloads `S.state`/`S.prop`, emits `data` (your page re-renders). Check `r.error` and `toast(r.error, "bad")`.
- Links: `<a data-prop="12" data-go="underwrite">` opens a property on a page; `<a data-go="market">` opens a page. `propLink(row, page)` builds one.
- Ticket: `select({ kind, id, row })` shows a detail in the right panel; kinds: `property` (id = property id), `deal`, `lease`, `unit`, `zip`, `txn`, `comp`, `debt`. `select(null)` clears.

### core.js exports

`S` { page, pid, prop, state, sel, prefs, v } · `PAGES`, `pageOf` · `on(evt, fn)`, `emit` · `api(path, body?)` raw ·
`get(path)` cached GET · `post(path, body, {quiet})` write · `changed()` · `setProp(pid)` · `select(x)` · `go(page, pid?)` ·
`lookup(address, page?)` · `upload(files, extra?)` · `pref(k, v?)` · `load/save(k, v)` localStorage · `isDark()`, `setTheme` · `inApp()` ·
`daysTo(date)`, `today()` · `esc(s)` ·
`f`: `num(v,dp) int usd(v,dp) susd cusd pct(v,dp) spct x(v,dp) compact date dateY mo sqft bb(p) street(addr) city(addr) cls(v) days ago score ok DASH`.

`S.state` (GET /api/state): `{ config:{rentcast_budget, demo, home_zip, has_rentcast_key, has_census_key, has_hud_token, has_google_key}, demo, job:{busy, step, error, done_at}, rentcast:{has_key, used, free, allowance, billable, est_cost}, counts:{listings, properties, owned, deals, tasks_due, inbox, txns}, rates:{MORTGAGE30US:{date,value}, MORTGAGE15US, DGS10}, market:{zips, as_of}, today, data_dir }` (rates values are percent numbers like 7.11).

### ui.js exports

`table(el, cfg)` sortable table (see the long comment above `export function table` in ui.js: cols `{k,label,title,l,c,val,fmt,cls,heat,sort,hide,w}`, `rows`, `key`, `sel`, `sort`, `limit`, `onRow`, `onDbl`, `rowCls`, `empty`, `maxH`, `head`, `foot`, `cls`, `nav`; returns `{setSel, move, view}`) — give every table a unique `id`, rows need a `key` field or `key: r => …`.
`chips(name, items, value, {label})` · `field(name, value, {label, pre, suf, w})` · `selectBox(name, items, value, {label})` · `btn(act, label, {cls:"pri"|"warn"|"ghost", title})` · `sep()` · `lbl(text)` ·
`bind(root, { "chip:name": (v)=>…, "act:name": (el)=>…, "input:name": (v)=>…, "change:name", "enter:name" })` ·
`kv([{k, v, sub, cls, title}], {cls:"tight"})` · `panel({title, sub, right, body, flush, cls, id})` · `empty(title, sub)` · `loading(what)` ·
`heat(v, lo, hi, {mid, flip})` → cell style · `propLink(row, page)` · `scoreBar(v)` · `src(text, kind)` (kind v|e|m|x) · `pill(text, cls)` ·
`csv(name, cols, rows)` · `saveFile(name, text, type)` · `copy(text)` · `toast(msg, "bad"?)` · `debounce` · `parseNum("1.5k")` · `useCss(id)` ·
`formModal(title, fields, {ok, note, danger})` → Promise<{k: value}|null> (fields `{k,label,type:"text|number|date|select|textarea",value,options,full,ph,req}`) · `confirmModal(title, text, ok)` · `pickFiles(accept)`.

CSS classes available: `.pnl .ph .pb .note .strip(.warn) .tag(.amb.acc.up.down.mut) .empty .kv(.tight) .cols2(.w32 .w21 .stretch) .cols3 .page.fill + .grow` (page whose table fills the height) `.up .down .mut .amb .acc .faint .m` (mono) `.big .hero .hero-l .facts .pill .miss .prov .form .uw-in .board .col .card .chk .ev .aging .dz .sc`. Ticket classes: `.tk-h .sym .sub2 .tk-sec h4 .row3 .verdict(.good .bad .check) .btn.wide`.
Look at `web/style.css` and `web/css/valora.css` before inventing styles. Colour tokens: `--bg --panel --panel-2 --raise --line --line-2 --tx --tx-2 --mut --faint --up --down --acc --amber --gold --violet --cyan` (+ `-bg` variants for up/down/acc/amber).

### charts.js (inline SVG, theme-aware)

`C.line(el, { h, legend, series:[{name, pts:[[x,y]…], color:"acc|amber|up|down|violet|cyan|mut|tx-2", width, dash, dots}], ribbons:[{lo:[[x,y]], hi:[[x,y]], color, opacity}], hmarks:[{y,label,color}], x:{type:"date"|"num", fmt, label}, y:{fmt, label} })` — dates as `YYYY-MM-DD` strings on a date axis.
`C.bars(el, { h, cats:[…], series:[{name, vals:[…], color}], stacked, horizontal, y:{fmt}, onClick })` ·
`C.scatter(el, { h, pts:[{x,y,label,color,r}], x:{fmt,label}, y:{fmt,label}, onClick })` ·
`C.heat(el, { rows:[…], cols:[…], z:[[…]], scale:"seq"|"div", mid, fmt, cellH })` · `C.spark(values, {w,h,color})` → SVG string · `C.bar(value, {max,…})` → SVG string.
Read the option handling in `web/js/charts.js` before using a chart; reference usages: `~/CCP/tenor/web/js/pages/*.js` (same library, an options terminal — also the reference for density and tone).

### map.js

`const m = await mapView(el, { points:[{id,lat,lon,v,label,html,kind}], onClick:id=>…, onHover, legend:["low","high"], labels:true, selected })` → `{ setPoints(points,{fit}), select(id), flyTo(lat,lon,zoom), destroy(), off }`. `v` 0–100 colours red→amber→green; `kind:"subject"` is gold and larger. Give the element a height (e.g. `style="height:340px"` or flex grow). In the headless snap tool tiles may not load; points still draw. Every map already has a built-in **3D** button (tilted camera + extruded buildings); pass `tilt3d: true` to start in 3D (do this on the Property page hero map) or call `m.set3d(true)`.

### Street view

`const sv = await get(streetView(lat, lon))` (core.js) → `{ link, maps, embed }`. `link` opens Google Street View in the browser: use `openExternal(sv.link)` (core.js) from a "Street View" button on the Property page, the ticket's property view and the Comps page. When `sv.embed` is not null (the user set a Google Maps key in Settings; the Maps Embed API is free) show it inline on the Property page as `<iframe class="sv" src="…" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>` in a "Street view" panel; otherwise show the button and one muted line saying a Google Maps key in Settings embeds it here. Settings must include the `google_key` field (`config.has_google_key`).

## API

GET
- `/api/state` · `/api/streetview?lat=&lon=` → `{link, maps, embed|null}`
- `/api/listings?kind=sale&zip=&city=&type=&min_price=&max_price=&min_beds=&min_baths=&min_sqft=&max_sqft=&min_year=&min_units=` → `{ rows:[property fields + price, status, listed, dom, rent_est, rent_src, value_est, ppsf, cap, coc, cf (cash flow / month), dscr, grm, one_pct, score (0–100), score_parts:{cashflow,cap,discount,momentum,negotiable,risk}, discount, momentum], notes:[…], weights:{…} }`. Quick underwriting uses 25% down at the current investor rate.
- `/api/property/<id>` → profile `{ property, listing, listings, parcels:[{year,assessed_total,assessed_land,assessed_impr,tax_amount}], sales, value:{value,low,high,n,source,as_of}|null, rent:{…}|null, comps:[{id,kind:"sale"|"rent",address,price,beds,baths,sqft,year_built,date,distance,days_old,correlation,included,lat,lon}], zip:{zhvi:{latest,chg1y,chg5y,as_of,name,metro}, zori:{…}}, zhvi:[{date,value}], zori:[…], deal|null, scenarios:[{id,name,strategy,inputs(JSON string),outputs(JSON string),updated}], owned|null, docs, ctx:{rate,rate_src}, quick:{…same fields as listings}|undefined, tax:{amount,src}, missing:[{k,how}] }`
- `/api/comps/<id>` → `{ sale:[{id,price,adjusted,lines:[{k,v}],gross_adj,dist_mi,included}], rent:[…], value:{value,low,high,n}|null, rent_value:{…}|null }`
- `/api/find?q=` → properties · `/api/searches` → saved searches `[{id,name,query(JSON string)}]`
- `/api/market?zip=&metro=` → `{ rates:{MORTGAGE30US:[{date,value}],DGS10,RRVRUSQ156N,CSUSHPINSA}, zip:{zhvi:[…],zori:[…]}, zip_snap:[…], metro:{zhvi,zori}, metro_snap }`
- `/api/zips?state=OH&metro=Columbus` → `[{zip,city,state,metro,value,value_1y,value_5y,rent,rent_1y,rent_5y,yield,as_of}]` (all US ZIPs when unfiltered: ~26k rows — always filter or limit what you draw)
- `/api/pipeline` → `{ stages:[{id,label}], deals:[deal + address,city,zip,beds,baths,sqft,units,type,lat,lon,open_tasks,next_due], tasks:[{id,deal_id,property_id,title,due,done,address}] }` · `/api/deal/<id>` → `{ deal, events:[{ts,kind,text}], tasks }`
- `/api/portfolio` → `{ properties:[property + value,value_src,debt,equity,ltv,noi,income,opex,ds,cf,cap_on_value,units_n,occupied,occupancy,rent_roll,arrears,cost,gain,dscr,debts:[…],purchase_price,purchase_date], total:{value,debt,equity,noi,ds,cf,units,occupied,arrears,rent_roll,cost,ltv,occupancy,cap,dscr}, expiring:[{property_id,address,unit,tenant,end,days,rent,lease_id}], monthly:[{month,income,opex,noi,debt,cf}] }` (noi/income/opex are trailing 12 months of actual ledger payments and expenses)
- `/api/rentroll?property=` → units `[{id,property_id,address,name,beds,baths,market_rent,status,lease_id,tenant,tenant_id,start,end,rent,current_rent,deposit,balance,aging:{"0-30","31-60","61-90","90+"},days_left,loss_to_lease,escalation,late_fee,due_day,lease_status}]`
- `/api/ledger` → all entries (newest first) with tenant, unit, address · `/api/ledger/<lease_id>` → `{ entries:[{date,type:"rent|late_fee|charge|payment|credit",amount,memo,running}], balance, aging, prepaid, lease }`
- `/api/expenses?property=&year=` → `{ rows:[{id,property_id,address,date,category,amount,vendor,memo}], categories:[Schedule E lines] }` · `/api/debts` → `[debt + address, months_paid, payment, balance, pi_year, escrow, schedule:[{year,interest,principal,balance}]]` · `/api/maintenance` · `/api/tenants` · `/api/units` · `/api/owned_props`
- `/api/inbox` → `{ docs:[{id,name,kind:"bank_csv|lease|mortgage|brochure|pdf|other",pages,imported,status:"new|read|no_text|applied",property_id}], extractions:[{id,document_id,page,line,field,raw,value,confidence,status}], txns:[{id,account,date,amount,description,line,document_id,matched:{kind:"payment|expense|debt|income|ignore",lease_id,property_id,category,why,confidence,done}}], leases, properties, categories }` · `/api/doc/<id>` → document with extracted `text`
- `/api/schedule_e?year=` → `{ year, properties:[{property_id,address,rents,lines:{<Schedule E line>:amount},expenses,net,basis}], lines:[…] }`

POST (all return JSON; `{error}` on refusal)
- `/api/lookup {address, refresh?}` → `{id, notes}` · `/api/estimate {id, refresh?}` (RentCast value+rent, 2 calls) · `/api/listings {kind, zip|city+state, refresh?}` (pull live listings: 1 RentCast call; then same shape as GET)
- `/api/property/add {address, city, state, zip, type, beds, baths, sqft, year_built, units, price?}` → `{id}` · `/api/property/edit {id, data:{beds,baths,sqft,lot,year_built,units,type,notes,tags}}` · `/api/property/value {id, kind:"value"|"rent", value, source}`
- `/api/comp {act:"toggle", id, included}` | `{act:"add", subject_id, kind, address, price, beds, baths, sqft, year_built, date, distance}`
- `/api/underwrite {strategy:"rental", inputs:{price, rent_month, other_income_month, vacancy, taxes_year, insurance_year, hoa_month, mgmt, maint, capex, utilities_month, other_exp_year, closing, rehab, down, rate, years, io, rent_growth, exp_growth, appreciation, exit_cap|null, hold, sell_cost}, sens:{row:"price", col:"rent_month", metric:"coc"|"irr"|"dscr"|"cap"|"cash_flow_month"}}` → `{ loan, cash_in, payment, debt_year, noi, cap, cash_flow, cash_flow_month, coc, dscr, grm, one_pct, breakeven_occ, opex_ratio, sale, net_sale, irr, multiple, flows:[…], proforma:[{year,gross,vacancy,egi,opex,noi,capex,debt,cash_flow,balance,taxes,insurance,mgmt,maint}], sens:{row:[k,[…]], col:[k,[…]], metric, grid}, amort:[…], offer_coc_6, offer_coc_8, offer_coc_10, offer_dscr_125, inputs }`. `{strategy:"brrrr", inputs:{price, rehab, arv, rent_month, opex_month, refi_ltv, refi_rate, years, closing, refi_cost, hold_months, carry_month}}` → `{all_in, loan, cash_out, left_in, payment, cash_flow_month, coc, infinite, equity}`. `{strategy:"flip", inputs:{price, rehab, arv, months, closing, sell_cost, carry_month, loan_ltc, rate, points}}` → `{profit, costs, cash, roi, annualized, rule70, margin}`. Pure calculation, no write (use `api()` not `post()` so nothing re-renders).
- `/api/scenario {property_id, name, strategy, inputs, outputs}` · `/api/weights {cashflow, cap, discount, momentum, negotiable, risk}` · `/api/searches {name, query}` | `{delete:id}`
- `/api/pipeline {act:"add", property_id, ask, strategy, score}` | `{act:"move", id, stage, reason}` | `{act:"update", id, offer|ask|notes|strategy}` | `{act:"note", id, text}` | `{act:"task", id, property_id, title, due}` | `{act:"task_done", task_id, done}` | `{act:"delete", id}`. Stages: discovered, researching, underwriting, diligence, offer, acquired, rejected. Moving to a stage adds its checklist tasks; `acquired` marks the property owned.
- `/api/portfolio {act:"add"|"edit"|"delete", table:"unit"|"tenant"|"lease"|"entry"|"expense"|"debt"|"maint"|"owned", id?, data:{columns…}, tenant_name?}` | `{act:"end_lease", id, end}` | `{act:"renew", id, rent, years}`. Columns: see `valora/db.py`. (`owned` rows are keyed by property_id; adding one marks the property owned.)
- `/api/import/text {text, source?}` → `{rows, new, updated, sold, found:[addresses]}` — pasted addresses / listing text / alert-email text become listings (geocoded free). A listings CSV (e.g. Redfin's own "Download All" export) or a saved alert email (.eml) dropped on the window is imported the same way: `/api/upload` then returns `{kind:"listings", rows, new, updated, sold, source}` instead of a document. Search must offer "Import listings" (pickFiles(".csv,.eml,.txt") → upload()) and "Paste addresses" (formModal textarea → /api/import/text), and say in its empty state that these two plus a RentCast key are the ways to get listings in (no site scraping).
- `/api/upload {name, data: base64}` (use `upload(files)` from core) · `/api/inbox {act:"accept_txn", id, override:{kind, lease_id|property_id, category}}` | `{act:"accept_all", min:0.6}` | `{act:"apply_doc", id, values:{…fields}, property_id, unit_id?}` | `{act:"kind", id, kind}` | `{act:"extract", id}` | `{act:"delete_doc", id}`
- `/api/settings {rentcast_key?, census_key?, hud_token?, google_key?, rentcast_budget?, demo?, home_zip?}` → state · `/api/market/refresh {force}` · `/api/demo/reset`

## Pages

Every page: dense, information first, a `kv` strip of headline figures on top where it makes sense, tables that sort,
CSV export where a table is the main content (`csv()` button in `ctx.bar`), sensible empty states that say what to do next.

1. **search** — listings: map (left or top, ~45%) + dense table. Filters in `#sub`: sale/rent kind, ZIP or city, price range, beds, type, min score. Columns: address (street + ZIP), price, $/sf, beds/baths, sqft, year, DOM, rent est, cap, CoC, cash flow/mo, score bar. Map points coloured by score, hover popup, click = select (ticket) ; double-click row = open Property. "Pull live listings" button (POST /api/listings with zip/city; needs RentCast key — say so when missing, show `notes`). Save search / saved searches. "+ Pipeline" action on the selected row. Add a property by hand (formModal → /api/property/add).
2. **screen** — ranked opportunities: same rows ranked by score with the factor contributions as heat-shaded columns (score_parts), a weight editor (six sliders or number fields → POST /api/weights, re-rank), strategy presets (Cash flow, Value add, Appreciation), scatter of cap rate vs price coloured by score, and "what would have to be true" columns (max offer for 8% CoC is NOT in rows; skip unless cheap). Filters: min CoC, min cap, max price, min DSCR.
3. **market** — ZIP/metro explorer: pick ZIP (pref "zip", default the selected property's ZIP or config.home_zip or 43201) → home value index and rent index lines (ZIP vs metro), 1y/5y changes, gross yield, price-to-rent; mortgage rate and 10y lines; table of ZIPs in the same metro/state (value, rent, yield, 1y, 5y) sortable, click → select zip / switch; "Source: Zillow Research (ZHVI, ZORI), FRED" note. If market data is not downloaded (`S.state.market.zips === 0`) show a clear state with a button to download (POST /api/market/refresh).
4. **property** — the profile: hero (address, facts grid, map with subject + comps), value estimate with range and source, rent estimate with range and source, asking price vs value, quick returns (cap, CoC, cash flow, DSCR) with the assumptions line, score with factor breakdown, tax/assessment history table + chart, sale history, ZIP trend charts, what's missing list (`missing`), documents, actions (Underwrite, Comps, + Pipeline, Mark as owned (formModal → /api/portfolio owned), Refresh estimates, Edit facts, Set my own value/rent).
5. **comps** — sale comps and rent comps tabs: adjustment grid (comp price, each adjustment line, adjusted price, gross adjustment %, distance, date), include/exclude checkbox per comp (POST /api/comp toggle), reconciled value with low/high vs AVM vs asking, map of subject + comps, add a comp by hand, $/sf comparison chart.
6. **underwrite** — the model: left column of inputs (grouped: Purchase, Income, Expenses, Financing, Growth & exit) prefilled from the profile (asking price or value, rent estimate, tax, insurance 0.5%, rate from ctx) with gold outline (`input.src`) on fields that came from data and a tooltip naming the source; right: headline kv (cap, CoC, DSCR, IRR, equity multiple, cash flow/mo, cash in), year-by-year pro forma table, cash-flow bar chart, sensitivity heat grid (choose row/col/metric), max offer for 6/8/10% CoC and 1.25 DSCR, amortisation, tabs for Rental / BRRRR / Flip, save/load named scenarios (/api/scenario, profile.scenarios), compare saved scenarios table. Recalculate on input change (debounced, `api()` not `post()`).
7. **pipeline** — kanban board of the 7 stages (cards draggable between columns → move; rejected asks a reason via formModal), toggle to table view, selected deal detail (below or via ticket): tasks checklist with due dates (overdue in red), event log, add note/task, offer/ask fields, links to Property/Underwrite. Top kv: active deals, total ask, tasks due this week, avg days in stage. A "Tasks" panel across all deals sorted by due date.
8. **portfolio** — dashboard of what you own: kv (value, debt, equity, LTV, NOI ttm, cash flow ttm, cap on value, DSCR, occupancy, rent owed), monthly income/opex/debt/cash-flow chart (24 months), properties table (value + source, equity, NOI, cash flow, cap, DSCR, occupancy, arrears, gain since purchase), lease expiries in the next 90 days, equity by property bars, add an owned property. Empty state explains the three ways in (drop files, mark a deal acquired, add by hand).
9. **rentroll** — units/tenants/leases: table (property, unit, tenant, lease start–end, days left with colour, rent, market rent, loss to lease, deposit, balance owed, status), filter by property, vacancy list, actions: add unit, new lease (formModal with tenant_name), renew, end lease, edit; totals row in kv (scheduled rent, market rent, loss to lease, occupancy, deposits held). Selecting a row → select({kind:"lease"}).
10. **ledger** — rent collection: arrears ageing table per lease (0–30, 31–60, 61–90, 90+), selected lease ledger with running balance, record payment / charge / credit (formModal → /api/portfolio entry), all-entries table with filters (type, property, month), collected vs charged this month, CSV export.
11. **books** — three tabs: Expenses (table by date, filter property/year/category, add/edit, totals by Schedule E category bars), Debt (loans table: lender, original, rate, payment, balance, payoff year; amortisation chart and schedule for the selected loan; add/edit), Maintenance (tickets: status open/scheduled/closed, priority, cost, vendor; add, close).
12. **inbox** — files in, proposals out: drop zone + "Choose files" (pickFiles → upload), documents list with kind (changeable) and status, bank transactions review table (date, description, amount, proposed match with reason + confidence, source file/line; accept, change lease/property/category, ignore; "Accept all ≥ 60%"), lease / mortgage extraction review (each field with value, the source line `raw`, page/line; edit, pick the property/unit, Apply → /api/inbox apply_doc), "couldn't read (scanned PDF) — enter these N fields" fallback form, document text viewer.
13. **reports** — Schedule-E style report per property for a year (rents, each expense line, mortgage interest, depreciation, net) with year picker, portfolio totals, CSV export and a printable view; plus an owner statement (monthly income/expense for a property) and a rent-roll export. Label "not tax advice".
14. **settings** — workspace switch (demo ↔ yours, reset demo), API keys (RentCast, Census, HUD: password inputs; only show "set"/"not set"), RentCast monthly budget + usage meter with cost, home ZIP, market data status + update button, data folder path, data sources and their terms.
15. **help** — keys, commands, how numbers are computed (NOI, cap, CoC, DSCR, IRR, score, comps), data sources and limits, what is demo.
16. **ticket** (`web/js/ticket.js`, `export default { async render(el, ctx) }`, re-rendered on `sel`, `prop`, `data`) — by `S.sel.kind`: property (photo-less summary: price, value range, rent, cap/CoC/cash flow, score parts as small bars, verdict box, actions: Open, Underwrite, + Pipeline), deal (stage, days in stage, tasks, move buttons), lease (tenant, rent, balance, ageing, recent ledger, record payment), zip (value, rent, yield, changes, sparkline), txn, comp, debt. With no selection: the selected property (`S.prop`) summary, or a short "how to start" list when nothing is selected.

## Formulas (engine: valora/uw.py)

NOI = effective gross income − operating expenses (taxes, insurance, HOA, utilities, management % of EGI, repairs % of rent); capex reserve and debt service are below NOI. Cap = year-1 NOI / price. Cash-on-cash = (NOI − capex − debt service) / (down + closing + rehab). DSCR = NOI / annual P&I. IRR on annual levered flows; sale = next-year NOI / exit cap (or price grown at appreciation) less selling costs and loan balance. Score = weighted average of six 0–100 factors (cashflow: CoC −5%…12%; cap: 3%…10%; discount: value/price −10%…+15%; momentum: ZIP value+rent 1y −4%…8%; negotiable: DOM 0…120; risk: data confidence).
