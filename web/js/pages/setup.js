import { S, esc, f, get, go, post, setProp, select } from "../core.js";
import { bind, btn, confirmModal, formModal, panel, pill, toast, useCss } from "../ui.js";
import { bindCredentials, credentialRows, currencyOptions } from "../credentials.js";

const ROUTE = "/api/setup/providers";
const FIELDS = {
  beds: "Bedrooms", baths: "Bathrooms", sqft: "Floor area (sq ft)", lot: "Lot size (sq ft)",
  year_built: "Year built", rent: "Rent estimate / month", value: "Value estimate",
};
const AUTH = [
  { v: "none", label: "No key" }, { v: "bearer", label: "Bearer token" },
  { v: "header", label: "Named header" }, { v: "query", label: "Query parameter" },
];

async function editProvider(existing) {
  const values = await formModal(existing ? `Edit ${existing.name}` : "Connect a custom provider", [
    { k: "name", label: "Provider name", value: existing?.name, req: true },
    { k: "address_param", label: "Address query parameter", value: existing?.address_param, ph: "address", req: true },
    { k: "endpoint", label: "HTTPS endpoint", value: existing?.endpoint, ph: "https://api.example.com/property", full: true, req: true },
    { k: "auth", label: "Authentication", value: existing?.auth || "none", type: "select", options: AUTH },
    { k: "auth_name", label: "Header or query key name", value: existing?.auth_name, ph: "e.g. X-API-Key" },
    { k: "key", label: "API key or token", type: "password", ph: existing ? "Leave blank to keep the stored key" : "Paste credential", full: true },
    { k: "currency", label: "Provider currency for estimates", value: existing?.currency ?? S.state.config.currency, ph: "USD" },
    { k: "field_map", label: "JSON field mapping (one per line)", type: "textarea",
      value: Object.entries(existing?.mapping || {}).map(([field, path]) => `${field}=${path}`).join("\n"),
      ph: "beds=result.bedrooms\nvalue=result.estimatedValue", req: true },
  ], { ok: "Save provider", note: `Assign response fields to ${Object.keys(FIELDS).join(", ")}. Example <code>beds=result.bedrooms</code>. Changing the endpoint clears additional credentials.` });
  if (!values) return null;
  const mapping = Object.fromEntries(values.field_map.split("\n").filter(line => line.trim()).map(line => {
    const equals = line.indexOf("=");
    return equals > 0 ? [line.slice(0, equals).trim(), line.slice(equals + 1).trim()] : [line.trim(), ""];
  }));
  const { field_map, ...body } = values;
  const result = await post(ROUTE, { act: "save", id: existing?.id, ...body, mapping });
  toast(result.error || "Provider saved", result.error ? "bad" : "");
}

async function pullProvider(provider) {
  const props = await get("/api/properties");
  if (!props.length) return toast("Add a property address before pulling provider data", "bad");
  const choice = await formModal(`Pull from ${provider.name}`, [{
    k: "property_id", label: "Saved property", type: "select", full: true,
    value: props.some(p => p.id === S.pid) ? S.pid : props[0].id,
    options: props.map(p => ({ v: p.id, label: p.address })),
  }], { ok: "Pull and preview", note: "InvestStack sends this property's address to the endpoint you configured. Review mapped values before importing." });
  if (!choice) return;
  toast("Requesting provider data…");
  const preview = await post(ROUTE, { act: "preview", id: provider.id, property_id: +choice.property_id }, { quiet: true });
  if (preview.error) return toast(preview.error, "bad");
  const lines = Object.entries(preview.facts).map(([field, value]) =>
    `<li>${esc(FIELDS[field])} <strong>${f.num(value, value % 1 ? 2 : 0)}${["rent", "value"].includes(field) ? " " + esc(preview.currency) : ""}</strong></li>`).join("");
  if (!await confirmModal("Import provider data", `<b>${esc(preview.address)}</b><ul>${lines}</ul>`
    + (preview.currency_mismatch ? "<p>Estimates were omitted because the provider uses a different currency.</p>" : "")
    + "<p>Mapped property facts update the record. Estimates retain their provider attribution.</p>", "Import these values")) return;
  const result = await post(ROUTE, { act: "apply", token: preview.token });
  toast(result.error || "Provider data imported", result.error ? "bad" : "");
}

async function manageKeys(provider) {
  const saved = [
    { v: "new", label: "Add or replace a named credential" },
    ...provider.extra.map((entry, index) => ({ v: index, label: `Remove ${entry.auth_name} (${entry.auth})` })),
  ];
  let action = "new";
  if (provider.extra.length) {
    const options = await formModal(`${provider.name} credentials`, [{
      k: "action", label: "Additional credential", type: "select", options: saved, value: "new", full: true,
    }], { ok: "Continue", note: "Use Edit to change the provider’s primary credential." });
    if (!options) return;
    action = options.action;
  }
  let result;
  if (action === "new") {
    const values = await formModal(`Add a credential for ${provider.name}`, [
      { k: "auth", label: "Credential type", type: "select", options: AUTH.slice(2), value: "header" },
      { k: "auth_name", label: "Header or query name", req: true },
      { k: "key", label: "Credential", type: "password", full: true, req: true },
    ], { ok: "Save credential", note: "Saving a credential with the same name and type replaces its stored key." });
    if (!values) return;
    result = await post(ROUTE, { act: "save-credential", id: provider.id, ...values });
  } else {
    const entry = provider.extra[Number(action)];
    if (!await confirmModal(`Remove ${entry.auth_name}?`, "This key will be removed from future requests.", "Remove key")) return;
    result = await post(ROUTE, { act: "drop-credential", id: provider.id, ...entry });
  }
  toast(result.error || "Credentials updated", result.error ? "bad" : "");
}

function customRows(providers) {
  return providers.map(provider => `<div class="st-row su-provider">
    <b>${esc(provider.name)}</b>
    <span>${pill(provider.extra.length + Number(provider.auth !== "none") ? `${provider.extra.length + Number(provider.auth !== "none")} saved` : "Keyless")}</span>
    <div class="why"><span class="su-endpoint">${esc(provider.endpoint)}</span><br>${esc(Object.keys(provider.mapping).map(k => FIELDS[k]).join(" · "))}</div>
    <div class="ctl">${btn("pull", "Pull data", { attrs: `data-id="${esc(provider.id)}"` })}
    ${btn("edit", "Edit", { cls: "ghost", attrs: `data-id="${esc(provider.id)}"` })}
    ${btn("manage-keys", "Keys", { cls: "ghost", attrs: `data-id="${esc(provider.id)}"` })}
    ${btn("remove", "Remove", { cls: "ghost", attrs: `data-id="${esc(provider.id)}"` })}</div></div>`).join("");
}

export default {
  id: "setup",
  deps: [],
  async render(root, ctx) {
    useCss("office");
    useCss("setup");
    const state = S.state;
    if (!state) return;
    const cfg = state.config || {};
    const listing = await post(ROUTE, { act: "list" }, { quiet: true });
    const providers = listing.providers || [];
    ctx.sub.textContent = "Workspace and data connections";
    ctx.bar.innerHTML = '<button type="button" class="btn ghost" data-go="settings">Settings ↗</button>';
    const finish = state.demo ? btn("live", "Start my workspace", { cls: "pri" }) + btn("demo", "Explore the demo")
      : btn("live", "Go to Overview", { cls: "pri" });
    root.innerHTML = `<div class="su">
      <section class="su-intro">
        <div><h2>Your workspace. Your data sources.</h2>
        <p>InvestStack uses an open data model. Start with sample data, use public sources where coverage exists, import your own files, or connect providers you choose.</p></div>
        <div class="su-actions">${finish}</div>
      </section>
      ${panel({ title: "Workspace", sub: state.demo ? "Demo is active" : "Your workspace is active", flush: true, body:
        `<div class="st-line"><b>Workspace currency</b><select class="sel" data-input="currency" aria-label="Workspace currency">${currencyOptions(cfg.currency)}</select>
        <span class="why">One currency per workspace. The demo uses USD.</span></div>
        <div class="st-line"><b>RentCast paid calls / month</b><input class="in" data-input="paid-calls" value="${esc(cfg.rentcast_budget)}" aria-label="RentCast paid calls per month" inputmode="numeric">
        ${btn("save-budget", "Save")}<span class="why">Set 0 to use the free allowance only.</span></div>` })}
      ${panel({ title: "Built-in providers", sub: "Optional API keys", flush: true,
        body: '<div class="su-note">Credentials are saved in the local configuration file and sent to the provider you connect.</div>' + credentialRows(cfg) })}
      ${panel({ title: "Custom providers", sub: "Connect an HTTPS JSON property API", flush: true,
        right: btn("add", "Add provider", { cls: "pri" }),
        body: listing.error ? `<div class="su-note down">${esc(listing.error)}</div>` :
          providers.length ? customRows(providers) :
            '<div class="su-note">Add a provider with a public HTTPS endpoint, an address parameter and the JSON fields to import. It can use a bearer token, a named header, a query key or public access.</div>' })}
      ${panel({ title: "Sources you can use without a key", flush: true, body:
        `<dl class="su-sources">
          <div><dt>Municipal records</dt><dd>Auto-fill available facts for supported locations, including Surrey and the Township of Langley.</dd></div>
          <div><dt>Maps and research</dt><dd>OpenStreetMap mapping, published housing indexes and public rate series.</dd></div>
          <div><dt>Your files</dt><dd>Import bank CSVs, lease documents or mortgage statements into your local workspace.</dd></div>
        </dl>` })}
    </div>`;
    async function complete(demo) {
      const result = await post("/api/settings", { demo, setup_complete: true });
      if (result.error) return toast(result.error, "bad");
      if (demo !== state.demo) {
        await setProp(null);
        select(null);
      }
      go("overview");
    }
    async function saveBudget() {
      const amount = root.querySelector('[data-input="paid-calls"]').value.trim();
      if (!/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount))) return toast("Enter a whole number of calls", "bad");
      const result = await post("/api/settings", { rentcast_budget: +amount });
      toast(result.error || "RentCast allowance saved", result.error ? "bad" : "");
    }
    const providerOf = element => providers.find(provider => provider.id === element.dataset.id);
    bind(root, {
      "act:live": () => complete(false),
      "act:demo": () => complete(true),
      "change:currency": async currency => {
        const result = await post("/api/settings", { currency });
        toast(result.error || "Workspace currency saved", result.error ? "bad" : "");
      },
      "act:save-budget": saveBudget,
      "enter:paid-calls": saveBudget,
      "act:add": () => editProvider(),
      "act:edit": element => editProvider(providerOf(element)),
      "act:manage-keys": element => manageKeys(providerOf(element)),
      "act:pull": element => pullProvider(providerOf(element)).catch(error => toast(error.message, "bad")),
      "act:remove": async element => {
        const provider = providerOf(element);
        if (!await confirmModal(`Remove ${provider.name}?`, "The connector and its stored credential are removed. Imported values remain in the property record.", "Remove provider")) return;
        const result = await post(ROUTE, { act: "remove", id: provider.id });
        toast(result.error || "Provider removed", result.error ? "bad" : "");
      },
    });
    bindCredentials(root);
  },
};
