import { esc, post } from "./core.js";
import { btn, confirmModal, pill, toast } from "./ui.js";

const KEYS = [
  { k: "rentcast_key", has: "has_rentcast_key", name: "RentCast", what: "Property records, AVM value and rent with comps, live sale and rental listings.",
    get: "app.rentcast.io → API → create key. 50 calls / month free.", cost: "Free 50 calls / month, then billed per call by RentCast" },
  { k: "census_key", has: "has_census_key", name: "Census ACS", what: "ZIP-level income, renter share, vacancy and population (risk factors).",
    get: "api.census.gov/data/key_signup.html (free, emailed)", cost: "Free" },
  { k: "hud_token", has: "has_hud_token", name: "HUD FMR", what: "Fair Market Rents by ZIP and bedroom count: a second rent reference.",
    get: "huduser.gov/hudapi/public/register (free)", cost: "Free" },
  { k: "google_key", has: "has_google_key", name: "Google Maps", what: "Embeds Street View on the Property page. Without it the Street View button opens Google Maps in the browser.",
    get: "console.cloud.google.com → enable Maps Embed API → credentials", cost: "Maps Embed API is free (no per-load charge)" },
];

function keyRow(o, cfg) {
  const set = !!cfg[o.has];
  return `<div class="st-row"><b>${esc(o.name)}<small>${esc(o.k)}</small></b>
    <span>${set ? pill("set", "up") : pill("not set")}</span>
    <div class="why">${esc(o.what)}<br><span class="faint">${esc(o.get)} · ${esc(o.cost)}</span></div>
    <div class="ctl"><input type="password" data-key="${o.k}" aria-label="${esc(o.name)} key" placeholder="${set ? "replace the stored key" : "paste key"}" autocomplete="off" spellcheck="false">
    ${btn("key-save", "Save", { attrs: `data-k="${o.k}"` })}${set ? btn("key-clear", "Remove", { cls: "ghost", attrs: `data-k="${o.k}"` }) : ""}</div></div>`;
}


export const credentialRows = cfg => KEYS.map(provider => keyRow(provider, cfg)).join("");

export function currencyOptions(selected = "USD") {
  const options = Intl.supportedValuesOf?.("currency") || ["AUD", "CAD", "CHF", "EUR", "GBP", "INR", "JPY", "NZD", "USD", "ZAR"];
  return [...new Set([...options, selected])].sort()
    .map(code => `<option ${selected === code ? "selected" : ""}>${esc(code)}</option>`).join("");
}

export function bindCredentials(root) {
  for (const row of root.querySelectorAll(".st-row")) {
    const input = row.querySelector("input[data-key]");
    if (!input) continue;
    const provider = KEYS.find(entry => entry.k === input.dataset.key);
    const persist = async value => {
      const result = await post("/api/settings", { [provider.k]: value });
      toast(result.error || (value ? `${provider.name} key saved` : `${provider.name} key removed`), result.error ? "bad" : "");
    };
    const saveKey = () => {
      const value = input.value.trim();
      if (!value) return toast("Paste the key first", "bad");
      if (/\s/.test(value)) return toast("Enter the key on one line", "bad");
      input.value = "";
      return persist(value);
    };
    row.querySelector('[data-act="key-save"]').onclick = saveKey;
    input.onkeydown = event => { if (event.key === "Enter") saveKey(); };
    const remove = row.querySelector('[data-act="key-clear"]');
    if (remove) remove.onclick = async () => {
      if (await confirmModal(`Remove the ${provider.name} key`, "Cached data stays in your workspace.", "Remove key")) await persist("");
    };
  }
}
