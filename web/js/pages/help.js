// Help — keys, commands, how every number is computed, where the data comes from and what it cannot tell you.
import { S, f, esc, PAGES } from "../core.js";
import { panel, btn, bind, useCss } from "../ui.js";

const K = s => s.split(" ").map(k => `<kbd>${esc(k)}</kbd>`).join(" ");

function keys() {
  const pageKeys = PAGES.filter(p => p.key).map(p => `<dt>${K(p.key)}</dt><dd>${esc(p.label)}</dd>`).join("");
  return panel({
    title: "Keys", sub: "anywhere outside a text field", flush: true,
    body: `<dl>${pageKeys}
      <dt>${K("⌘ K")}</dt><dd>Command palette: pages, owned properties, deals, recent addresses, actions</dd>
      <dt>${K("/")}</dt><dd>Focus the search bar</dd>
      <dt>${K("A")}</dt><dd>Look up an address</dd>
      <dt>${K("I")}</dt><dd>Inbox</dd>
      <dt>${K("T")}</dt><dd>Paper / blueprint theme</dd>
      <dt>${K("← →")} ${K("[ ]")}</dt><dd>Previous / next page (two-finger swipe on a trackpad does the same)</dd>
      <dt>${K("↑ ↓")} ${K("j k")}</dt><dd>Move through the rows of the main table</dd>
      <dt>${K("Esc")}</dt><dd>Clear the inspector selection; close a dialog</dd>
      <dt>${K("?")}</dt><dd>This page (again to go back)</dd>
      <dt>${K("Enter")} ${K("X")}</dt><dd>On Inbox: accept / ignore the selected bank row</dd></dl>`,
  });
}

function commands() {
  return panel({
    title: "Search bar", sub: "type, then Enter", flush: true,
    body: `<dl>
      <dt>1234 Main St, Columbus OH</dt><dd>Open that property; looks it up (geocoded free, records with a RentCast key) if it is new</dd>
      <dt>43201</dt><dd>Market page for a ZIP</dd>
      <dt>43201 SEARCH</dt><dd>A word after a ZIP or address picks the page: SEARCH, SCREEN, MKT, COMPS, UW, PIPE, PORT, RR, LEDGER, BOOKS, INBOX, TAX, KEYS, HELP</dd>
      <dt>UW · COMPS · DES</dt><dd>Alone: open that page for the selected property</dd>
      <dt>DEMO · LIVE</dt><dd>Switch to the demo or to your own workspace</dd>
      <dt>THEME</dt><dd>Switch theme</dd></dl>
      <p>Files dropped anywhere on the window go to the Inbox: bank CSVs, lease and mortgage-statement PDFs. A listings CSV (for example a Redfin "Download All" export) or a saved alert email (.eml) is imported as listings instead.</p>`,
  });
}

function formulas() {
  return panel({
    title: "How the numbers are computed", sub: "engine: valora/uw.py, valora/portfolio.py", flush: true,
    body: `<dl>
      <dt>EGI</dt><dd><span class="fx">gross rent + other income − vacancy</span></dd>
      <dt>NOI</dt><dd><span class="fx">EGI − (taxes + insurance + HOA + utilities + management % of EGI + repairs % of rent)</span>. Capex reserve and debt service sit below NOI.</dd>
      <dt>Cap rate</dt><dd><span class="fx">year-1 NOI ÷ price</span></dd>
      <dt>Cash-on-cash</dt><dd><span class="fx">(NOI − capex − debt service) ÷ (down payment + closing + rehab)</span></dd>
      <dt>DSCR</dt><dd><span class="fx">NOI ÷ annual principal and interest</span></dd>
      <dt>GRM · 1%</dt><dd><span class="fx">price ÷ annual rent</span> · <span class="fx">monthly rent ÷ price</span></dd>
      <dt>IRR</dt><dd>On annual levered cash flows: −cash in, each year's cash flow, and in the exit year the sale (next-year NOI ÷ exit cap, or price grown at the appreciation rate) less selling costs and the loan balance.</dd>
      <dt>Max offer</dt><dd>The price at which CoC reaches 6 / 8 / 10%, or DSCR reaches 1.25, with every other input held.</dd>
      <dt>Quick returns</dt><dd>Search and Screen rows: 25% down at FRED's 30-yr rate + 0.75 points (investor loan), rent from the best estimate on file, tax from the record or 1.2% of price (assumed), insurance 0.5% of price (at least $900).</dd>
      <dt>Score</dt><dd>Weighted average of six 0–100 factors: cash flow (CoC −5% → 0, 12% → 100), cap (3% → 10%), discount (value ÷ price −10% → +15%), momentum (ZIP value + rent 1-yr change −4% → 8%), negotiable (days on market 0 → 120), risk (how much of the data is real rather than assumed). Weights are yours on Screen.</dd>
      <dt>Comps</dt><dd>Each sale comp is adjusted toward the subject: size at half its $/sf, $7,500 a bedroom, $5,000 a bath, $400 a year of age, $2 per lot sf (capped ±$50,000). Reconciled value = mean of included adjusted prices weighted by <span class="fx">1 ÷ (0.05 + gross adjustment % + 0.1 × miles)</span>; low / high are the lowest and highest adjusted prices.</dd>
      <dt>Ledger</dt><dd>Rent posts on the due day; a late fee posts after the grace days; payments apply oldest charge first; ageing is by charge date (0–30, 31–60, 61–90, 90+).</dd>
      <dt>Schedule E</dt><dd>Rents = payments received in the year. Mortgage interest from each loan's amortisation. Depreciation 27.5-year straight line on 80% of (price + closing) plus rehab, mid-month first year. Not tax advice.</dd></dl>`,
  });
}

function sources() {
  const st = S.state || {};
  return panel({
    title: "Data and its limits", flush: true,
    body: `<p><b>Every estimate names its source and date.</b> A green dot is a verified record (assessor, sale, your bank file); amber an estimate (AVM, ZIP index); blue something you entered; grey an assumption or demo data.</p>
      <p><b>ZIP indexes are not property values.</b> Zillow ZHVI and ZORI describe the typical home in a ZIP. Without a RentCast key, a property's value and rent come from them (rent adjusted for bedrooms) and are marked rough.</p>
      <p><b>AVMs have ranges.</b> RentCast value and rent estimates are shown with low–high and the number of comps; a wide range means few or poor comps.</p>
      <p><b>No scraping.</b> Listings come from RentCast, or from files you export yourself (listings CSV, alert email). Days on market and price cuts are only as fresh as the last pull.</p>
      <p><b>Market data</b>: ${st.market?.zips ? `${f.int(st.market.zips)} ZIPs, index month ${esc(f.mo(st.market.as_of))}` : "not downloaded yet (Settings → Market data)"}. Rates: FRED, weekly.</p>
      <p><b>Inbox reading</b> uses the text inside the file. A scanned PDF has none; the Inbox then asks for the handful of fields it needs. Bank rows are matched on tenant name and rent amount; nothing is posted until you accept it.</p>
      <p><b>Demo workspace</b>: every property, tenant, payment and loan in it is invented around Columbus, Ohio, so the pages have something to show. It is labelled DEMO in the rail. Your own workspace starts empty.</p>`,
  });
}

function start() {
  return panel({
    title: "Getting data in", flush: true,
    body: `<dl>
      <dt>Prospecting</dt><dd>Search → Import listings (a CSV or alert email), Paste addresses, or Pull live listings with a RentCast key.</dd>
      <dt>One property</dt><dd>Type its address in the search bar.</dd>
      <dt>What you own</dt><dd>Portfolio → Add, or move a pipeline deal to Acquired.</dd>
      <dt>Tenants and rent</dt><dd>Drop each lease PDF on the Inbox and Apply; drop the bank export monthly and accept the matched payments.</dd>
      <dt>Loans</dt><dd>Drop a mortgage statement PDF; Apply adds the loan to Books → Debt.</dd>
      <dt>Expenses</dt><dd>Come in with the bank export (payee → Schedule E line); add the rest on Books.</dd></dl>`,
  });
}

function maps() {
  const g = !!S.state?.config?.has_google_key;
  return panel({
    title: "Maps, 3D and Street View", flush: true,
    body: `<dl>
      <dt>3D</dt><dd>The 3D button on any map tilts the camera and raises the buildings from their footprints. Drag with the right button (or Ctrl-drag) to turn the view; 3D again to flatten. The Property page map opens in 3D.</dd>
      <dt>Building heights</dt><dd>OpenStreetMap via OpenFreeMap tiles (no key). Where OSM has no height tag a building is drawn at a default height, so treat the massing as indicative, not surveyed.</dd>
      <dt>Street View</dt><dd>The Street View button (Property page, inspector, Comps) opens Google Street View at the property's coordinates in your browser. ${g ? "A Google Maps key is set, so the Property page also embeds it inline." : "With a Google Maps key in Settings (Maps Embed API, free) the Property page embeds it inline."} Imagery date is Google's, shown inside the viewer.</dd>
      <dt>Offline</dt><dd>Without network the map keeps the points on a blank background; Street View needs a connection.</dd></dl>`,
  });
}

export default {
  id: "help",
  deps: [],
  async render(root, ctx) {
    useCss("office");
    ctx.sub.innerHTML = `<span class="mut" style="font-size:12px">InvestStack · ${S.state?.demo ? "demo workspace" : "your workspace"} · data in ${esc(S.state?.data_dir || f.DASH)}</span>`;
    ctx.bar.innerHTML = btn("hp-settings", "Settings");
    bind(ctx.bar, { "act:hp-settings": () => { location.hash = "#/settings"; } });
    root.innerHTML = `<div class="hp">${keys()}${commands()}${start()}${maps()}${formulas()}${sources()}</div>`;
  },
};
