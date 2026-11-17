/**
 * OpenAgentic Procurement & Commission Hub (Site A).
 * intake_agent -> discovery_agent -> negotiator_agent, driving the supplier's agents over postMessage RPC.
 */
import { AgentRuntime, RpcClient, serveRpc, exposeGlobal, fetchJson, validateManifest, OawError } from "./shared/oaw-core.js?v=748213ee79";
import { h, $, money, createStream, createApproval, createConsent, createSettings, createStatusPill, createInspector } from "./shared/oaw-ui.js?v=748213ee79";
import * as H from "./hub-logic.js?v=748213ee79";

const BUILD = document.querySelector('meta[name="oaw-build"]')?.content || "dev";
const manifest = await (await fetch("./agent-manifest.json", { cache: "no-store" })).json();
const network = await (await fetch(`./${manifest.networks[0].hocon}`, { cache: "no-store" })).json();
const host = (u) => { try { return new URL(u).host; } catch { return u; } };
const originOf = (u) => new URL(u).origin;

/* ----------------------------------------------------------------- state */

const SUPPLIERS_KEY = "hub.suppliers.custom.v2"; // only suppliers the visitor added
const ORDERS_KEY = "hub.orders.v1";
const loadJson = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v ?? d; } catch { return d; } };
const isLoopback = (u) => { try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(u).hostname); } catch { return false; } };
const pageIsLocal = isLoopback(location.href);
const trimUrl = (u) => String(u).replace(/\/+$/, "");
const published = (manifest.peers?.suppliers || []).map(trimUrl);
// Older versions stored the whole list (including published defaults) under hub.suppliers.v1: keep only extras.
const legacy = loadJson("hub.suppliers.v1", null);
if (Array.isArray(legacy)) { localStorage.setItem(SUPPLIERS_KEY, JSON.stringify(legacy.map(trimUrl).filter((u) => !published.includes(u)))); localStorage.removeItem("hub.suppliers.v1"); }
let custom = loadJson(SUPPLIERS_KEY, []).map(trimUrl);
const skipped = custom.filter((u) => !pageIsLocal && isLoopback(u)); // a localhost supplier makes no sense on a public page
let registry = [...new Set([...published, ...custom.filter((u) => !skipped.includes(u))])];
const saveCustom = () => localStorage.setItem(SUPPLIERS_KEY, JSON.stringify(custom));
let orders = loadJson(ORDERS_KEY, []);
const discovered = new Map(); // url -> { url, origin, name, ok, manifest, network, checks, capabilities, scales, error, cors }
const contacted = new Set(); // origins approved for this session
let deal = null;
let busy = false;

const stream = createStream($("#stream"));
const approve = createApproval();
const consent = createConsent();

/* ------------------------------------------------- split view + peer windows */

let frame = null, frameOrigin = null, tab = null, tabOrigin = null;
const clients = new Map();

function openSplit(url) {
  const o = originOf(url);
  if (!frame || frameOrigin !== o) {
    const u = new URL(url.endsWith("/") ? url : `${url}/`); // the site's folder, no redirect needed
    u.searchParams.set("embedded", "1");
    if (BUILD !== "dev") u.searchParams.set("v", BUILD); // never reuse a stale cached studio page
    frame = h("iframe", { src: u.href, title: "Supplier site (live)", class: "peer-frame" });
    frameOrigin = o;
    const c = clients.get(o);
    if (c) c.ready = false;
    $("#splitFrame").replaceChildren(frame);
    $("#splitTitle").textContent = host(url);
  }
  document.body.classList.add("split-on");
  $("#splitBtn").setAttribute("aria-pressed", "true");
  $("#splitBtn").textContent = "Close Split-View";
}
function closeSplit() {
  document.body.classList.remove("split-on");
  frame?.remove(); frame = null; frameOrigin = null;
  $("#splitBtn").setAttribute("aria-pressed", "false");
  $("#splitBtn").textContent = "Open Studio Split-View";
}
const defaultSupplier = () => registry[0] || published[0];
$("#splitBtn").addEventListener("click", () => (document.body.classList.contains("split-on") ? closeSplit() : openSplit(defaultSupplier())));
$("#tabBtn").addEventListener("click", () => { tab = window.open(defaultSupplier(), "miniature-worlds"); tabOrigin = originOf(defaultSupplier()); });

function peerWindow(origin) {
  if (frame && frameOrigin === origin && frame.contentWindow) return frame.contentWindow;
  if (tab && !tab.closed && tabOrigin === origin) return tab;
  return null;
}

async function peer(url) {
  const origin = originOf(url);
  if (!peerWindow(origin)) openSplit(url); // RPC needs a live window of the supplier site
  let c = clients.get(origin);
  if (!c) {
    c = new RpcClient({ origin, getWindow: () => peerWindow(origin), onEvent: (ev) => onRemote(ev, origin) });
    clients.set(origin, c);
  }
  if (!c.ready) {
    const t0 = performance.now();
    const info = await c.connect();
    c.ready = true;
    runtime.emit({ type: "rpc", direction: "out", method: "ping", origin, ms: Math.round(performance.now() - t0), ok: true });
    runtime.emit({ type: "note", text: `Connected to ${info.name} (${host(origin)}) · supplier runs its own agents with: ${info.provider}` });
  }
  return c;
}

async function rpc(url, method, params) {
  const origin = originOf(url);
  const c = await peer(url);
  runtime.emit({ type: "rpc", direction: "out", method, tool: params?.tool || null, origin });
  const t0 = performance.now();
  try {
    const r = await c.call(method, params);
    const failed = r && typeof r === "object" && ["failed", "rejected"].includes(r.status);
    runtime.emit({ type: "rpc", direction: "out", method: failed ? `${method} → ${r.status}` : `${method} ✓`, tool: params?.tool || null, origin, ms: Math.round(performance.now() - t0), ok: !failed });
    return r;
  } catch (e) {
    runtime.emit({ type: "rpc", direction: "out", method, tool: params?.tool || null, origin, ms: Math.round(performance.now() - t0), ok: false });
    throw e;
  }
}

/** Events streamed from the supplier during an RPC call. */
function onRemote(ev, origin) {
  if (ev.type === "rpc" && ev.direction === "in") return; // our own request echoed back
  stream.add(ev, { remote: host(origin) });
  if (ev.type === "approval") {
    const bar = $("#splitAttention");
    if (ev.state === "pending") { bar.hidden = false; bar.textContent = `Action needed on ${host(origin)}: approve or reject "${ev.tool}"${ev.price != null ? ` (${money(ev.price)})` : ""}${document.body.classList.contains("split-on") ? " in the studio pane →" : " in the studio tab"}`; }
    else bar.hidden = true;
  }
}

/* --------------------------------------------------------------- contact */

async function contact(origin, purpose) {
  if (origin === location.origin || contacted.has(origin)) return;
  const d = await consent({ origin, purpose });
  runtime.emit({ type: "consent", origin, decision: d ? (d === "session" ? "allowed for session" : "allowed once") : "denied" });
  if (!d) throw new OawError("CONSENT_DENIED", `You did not allow contact with ${origin}.`);
  if (d === "session") contacted.add(origin);
}

async function discoverOne(url) {
  const origin = originOf(url);
  const base = url.replace(/\/+$/, "");
  const entry = { url: base, origin, name: host(base), ok: false };
  try {
    await contact(origin, `Fetch ${host(base)}'s public agent manifest to see if it can build this commission, then send it the RFQ.`);
    let m;
    try { m = await fetchJson(`${base}/agent-manifest.json`, { emit: (e) => runtime.emit(e) }); }
    catch { m = await fetchJson(`${base}/.well-known/agent-manifest.json`, { emit: (e) => runtime.emit(e) }); }
    entry.manifest = m;
    entry.name = m.name || entry.name;
    const net = m.networks?.[0];
    if (net?.hocon) entry.network = await fetchJson(new URL(net.hocon, `${base}/`).href, { emit: (e) => runtime.emit(e) });
    entry.checks = validateManifest(m, entry.network);
    entry.capabilities = m.capabilities || [];
    entry.scales = m.catalog?.scales || [];
    entry.terrains = m.catalog?.terrains || [];
    entry.cors = "*";
    entry.ok = entry.checks.every((c) => c.ok);
    if (!entry.ok) entry.error = `Manifest failed: ${entry.checks.filter((c) => !c.ok).map((c) => c.check).join("; ")}`;
  } catch (e) { entry.error = e.message; }
  discovered.set(base, entry);
  drawRegistry();
  inspector.refresh();
  return entry;
}

/* --------------------------------------------------------- agents + tools */

const agentImpl = {
  intake_agent: {
    prompt: ({ request }) => `Commission request:\n${request}`,
    deterministic: (input) => H.intakeDeterministic(input),
    normalize: (out, input) => H.normalizeRfq(out, input),
  },
  discovery_agent: {
    prompt: ({ rfq, suppliers }) => `RFQ:\n${JSON.stringify(rfq)}\n\nSuppliers:\n${JSON.stringify(suppliers, null, 1)}`,
    deterministic: (input) => H.discoveryDeterministic(input),
    normalize: (out, input) => (input.suppliers.some((s) => s.url === out?.supplier_url) ? { supplier_url: out.supplier_url, reason: String(out.reason || "").slice(0, 300) } : { ...H.discoveryDeterministic(input), reason: `Model chose an unknown supplier; using ${input.suppliers[0]?.name}.` }),
  },
  negotiator_agent: {
    prompt: ({ rfq, quote, round, history }) => `Round ${round} of ${H.MAX_ROUNDS}.\nRFQ: ${JSON.stringify(rfq)}\nSupplier's current quote: ${JSON.stringify(quote)}\nHistory: ${JSON.stringify(history)}`,
    deterministic: (input) => H.negotiatorDeterministic(input),
    normalize: (out) => ({ action: ["accept", "counter", "walk_away"].includes(out?.action) ? out.action : "counter", counter_price: Number.isFinite(Number(out?.counter_price)) ? Number(out.counter_price) : null, message: String(out?.message || "").slice(0, 300) }),
  },
};

const tools = {
  discover_suppliers: {
    effect: "read", title: "Discover suppliers",
    input_schema: { type: "object", properties: {} },
    async handler() {
      const list = [];
      for (const url of registry) list.push(await discoverOne(url));
      return { suppliers: list.map(({ manifest: _m, network: _n, ...s }) => s) };
    },
  },
  request_supplier_quote: {
    effect: "read", title: "Request a quote",
    input_schema: { type: "object", required: ["supplier_url", "rfq"], properties: { supplier_url: { type: "string" }, rfq: { type: "object" } } },
    async handler({ supplier_url, rfq }) {
      const r = await rpc(supplier_url, "callTool", { tool: "request_quote", args: { rfq, caller_agent: "negotiator_agent" } });
      if (r.status !== "succeeded") throw new OawError("SUPPLIER_ERROR", r.error || `Supplier returned ${r.status}`);
      return r.result;
    },
  },
  send_counter_offer: {
    effect: "read", title: "Send a counter-offer",
    input_schema: { type: "object", required: ["supplier_url", "quote_id", "counter_price"], properties: { supplier_url: { type: "string" }, quote_id: { type: "string" }, counter_price: { type: "number" }, message: { type: "string" } } },
    async handler({ supplier_url, quote_id, counter_price, message }) {
      const r = await rpc(supplier_url, "callTool", { tool: "negotiate_quote", args: { quote_id, counter_price, message } });
      if (r.status !== "succeeded") throw new OawError("SUPPLIER_ERROR", r.error || `Supplier returned ${r.status}`);
      return r.result;
    },
  },
  place_order: {
    effect: "write", title: "Place commission order",
    input_schema: { type: "object", required: ["supplier_url", "quote_id", "price"], properties: { supplier_url: { type: "string" }, quote_id: { type: "string" }, price: { type: "number" }, max_budget: { type: ["number", "null"] } } },
    precheck({ price, max_budget }) { if (max_budget != null && price > max_budget) throw new OawError("OVER_BUDGET", `Refusing to order at ${money(price)}: your budget is ${money(max_budget)}.`); },
    describe(args) {
      const q = deal?.quote || {};
      return {
        target: originOf(args.supplier_url), price: args.price,
        summary: `Place a binding commission order with ${q.supplier || host(args.supplier_url)}. The studio will then ask its owner to lock a build slot.`,
        lines: [["Supplier", q.supplier || host(args.supplier_url)], ["Quote", args.quote_id], ["Diorama", q.scene?.title || "—"], ["Scale · size", `${q.scale || "—"} · ${q.scene ? `${q.scene.base_width}×${q.scene.base_depth} cm` : "—"}`], ["Lead time", q.lead_time_days ? `${q.lead_time_days} days` : "—"], ["Your budget", money(args.max_budget)], ["First quote", money(deal?.first_price)]],
      };
    },
    async handler({ supplier_url, quote_id, price }) {
      const r = await rpc(supplier_url, "callTool", { tool: "confirm_commission", args: { quote_id, price, buyer_ref: "hub-order" } });
      if (r.status === "declined") throw new OawError("SUPPLIER_DECLINED", "The studio owner rejected locking the build slot. No order was placed.");
      if (r.status !== "succeeded") throw new OawError("SUPPLIER_ERROR", r.error || `Supplier returned ${r.status}`);
      const o = { ...r.result, quote_id, supplier_url, title: deal?.quote?.scene?.title, placed: new Date().toISOString() };
      orders.unshift(o);
      localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
      drawOrders();
      return o;
    },
  },
  list_orders: {
    effect: "read", rpc: true, title: "List orders",
    input_schema: { type: "object", properties: {} },
    handler: () => ({ orders: orders.map((o) => ({ ...o })) }),
  },
};

const runtime = new AgentRuntime({ site: "hub", manifest, network, agentImpl, tools, settingsKey: "hub.oaw.settings.v1", approve });
runtime.on((e) => stream.add(e));

/* ------------------------------------------------------------- deal flow */

const STEPS = ["Intake", "Discovery", "Quote", "Negotiate", "Approve", "Confirmed"];
function step(name, state) { deal.steps[name] = state; drawDeal(); }
const buyerView = (q) => ({ quote_id: q.quote_id, supplier: q.supplier, price: q.price, list_price: q.list_price, currency: q.currency, lead_time_days: q.lead_time_days, scale: q.scale, final: !!q.final, accepted: !!q.accepted, round: q.round, message: q.message, blueprint: q.scene ? { terrain: q.scene.terrain_type, size_cm: [q.scene.base_width, q.scene.base_depth], structures: q.scene.structures.length, water: q.scene.water_feature, leds: q.scene.led_points.length } : null });
const ok = (r, what) => { if (r.status === "succeeded") return r.result; throw new OawError(r.code || "TOOL_FAILED", `${what}: ${r.error || r.status}`); };

async function runCommission(prompt) {
  if (busy) throw new OawError("BUSY", "A commission is already running.");
  busy = true;
  setBusy(true);
  deal = { prompt, steps: {}, history: [], rfq: null, supplier: null, quote: null, first_price: null, result: null };
  drawDeal();
  runtime.emit({ type: "run_start", prompt });
  try {
    step("Intake", "active");
    const rfq = await runtime.runAgent("intake_agent", { request: prompt }, { from: "user" });
    deal.rfq = rfq;
    step("Intake", "done");

    step("Discovery", "active");
    const found = ok(await runtime.callTool("discover_suppliers", {}), "Discovery").suppliers;
    const eligible = found.filter((s) => s.ok && s.capabilities.includes(manifest.peers.required_capability));
    if (!eligible.length) throw new OawError("NO_SUPPLIER", `No registered supplier publishes ${manifest.peers.required_capability}. ${found.map((s) => `${s.name}: ${s.error || "missing capability"}`).join("; ")}`);
    const pick = await runtime.runAgent("discovery_agent", { rfq, suppliers: eligible.map(({ url, name, capabilities, scales, terrains }) => ({ url, name, capabilities, scales, terrains })) }, { from: "intake_agent" });
    deal.supplier = eligible.find((s) => s.url === pick.supplier_url) || eligible[0];
    runtime.emit({ type: "note", agent: "discovery_agent", text: `Chose ${deal.supplier.name}: ${pick.reason}` });
    step("Discovery", "done");

    step("Quote", "active");
    runtime.emit({ type: "handoff", from: "discovery_agent", to: "negotiator_agent" });
    let quote = ok(await runtime.callTool("request_supplier_quote", { supplier_url: deal.supplier.url, rfq }), "Quote request");
    if (quote.status === "rejected") throw new OawError("SUPPLIER_REJECTED", `${quote.supplier} cannot build this: ${quote.reason}`);
    deal.quote = quote; deal.first_price = quote.price;
    deal.history.push({ by: "supplier", price: quote.price, note: "first quote" });
    step("Quote", "done");

    step("Negotiate", "active");
    let accepted = false;
    for (let round = 1; round <= H.MAX_ROUNDS + 1 && !accepted; round++) {
      const d = await runtime.runAgent("negotiator_agent", { rfq, quote: buyerView(quote), round, history: deal.history }, { from: round === 1 ? "negotiator_agent" : `diorama_estimator@${host(deal.supplier.url)}` });
      const dec = H.enforceBuyerPolicy(d, { price: quote.price, budget: rfq.max_budget, final: quote.final, round });
      if (dec.policy) runtime.emit({ type: "note", agent: "negotiator_agent", text: `Buyer policy: ${dec.policy}` });
      if (dec.action === "accept") { accepted = true; runtime.emit({ type: "negotiation", text: `Buyer accepts ${money(quote.price)}` }); break; }
      if (dec.action === "walk_away") { runtime.emit({ type: "negotiation", text: `Buyer walks away at ${money(quote.price)} (budget ${money(rfq.max_budget)})` }); break; }
      runtime.emit({ type: "negotiation", text: `Buyer counters ${money(dec.counter_price)}${dec.message ? `: “${dec.message}”` : ""}` });
      deal.history.push({ by: "buyer", price: dec.counter_price, note: dec.message });
      quote = ok(await runtime.callTool("send_counter_offer", { supplier_url: deal.supplier.url, quote_id: quote.quote_id, counter_price: dec.counter_price, message: dec.message }), "Counter-offer");
      deal.quote = quote;
      deal.history.push({ by: "supplier", price: quote.price, note: quote.accepted ? "accepted" : quote.final ? "final offer" : "counter" });
      drawDeal();
      if (quote.accepted) accepted = true;
    }
    step("Negotiate", accepted ? "done" : "failed");
    if (!accepted) {
      deal.result = { ok: false, text: `No deal. ${deal.quote.supplier}'s offer of ${money(deal.quote.price)} stays above your budget of ${money(rfq.max_budget)}.` };
      runtime.emit({ type: "run_end", ok: false, error: deal.result.text });
      return deal.result;
    }

    step("Approve", "active");
    const r = await runtime.callTool("place_order", { supplier_url: deal.supplier.url, quote_id: quote.quote_id, price: quote.price, max_budget: rfq.max_budget });
    if (r.status === "declined") {
      step("Approve", "failed");
      deal.result = { ok: false, text: "You rejected the order. Nothing was committed." };
      runtime.emit({ type: "run_end", ok: false, error: deal.result.text });
      return deal.result;
    }
    if (r.status !== "succeeded") { step("Approve", "failed"); throw new OawError(r.code || "ORDER_FAILED", r.error); }
    step("Approve", "done");
    step("Confirmed", "done");
    deal.result = { ok: true, order: r.result, text: `Commission confirmed: order ${r.result.order_id}, ${money(r.result.price)}, build slot ${r.result.slot_date}.` };
    runtime.emit({ type: "run_end", ok: true, summary: deal.result.text });
    return deal.result;
  } catch (e) {
    deal.result = { ok: false, text: `${e.code || "ERROR"}: ${e.message}` };
    for (const s of STEPS) if (deal.steps[s] === "active") deal.steps[s] = "failed";
    runtime.emit({ type: "run_end", ok: false, error: deal.result.text });
    throw e;
  } finally {
    busy = false;
    setBusy(false);
    $("#splitAttention").hidden = true;
    drawDeal();
  }
}

/* -------------------------------------------------------------------- UI */

function setBusy(b) {
  $("#runBtn").disabled = b;
  $("#request").disabled = b;
  $("#runBtn").textContent = b ? "Agents working…" : "Run commission";
}

function drawDeal() {
  const el = $("#deal");
  if (!deal) { el.replaceChildren(h("p", { class: "oaw-muted", text: "Describe a commission and the agents will find a supplier, get a 3D blueprint and negotiate the price." })); return; }
  const r = deal.rfq, q = deal.quote;
  el.replaceChildren(...[
    h("ol", { class: "steps" }, ...STEPS.map((s) => h("li", { class: deal.steps[s] || "todo", text: s }))),
    r ? h("div", { class: "card" }, h("p", { class: "kicker", text: "RFQ · intake_agent" }),
      h("dl", { class: "kv" }, ...[["Theme", r.theme], ["Scale", r.scale || "—"], ["Size", `${r.dimensions_cm.width}×${r.dimensions_cm.depth} cm`], ["Terrain", r.terrain_hint || "—"], ["Features", r.features.join(", ") || "—"], ["Budget", money(r.max_budget)]].flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })]))) : null,
    deal.supplier ? h("p", { class: "oaw-muted small", text: `Supplier: ${deal.supplier.name} · ${deal.supplier.url}` }) : null,
    q ? h("div", { class: "card quote" },
      h("div", { class: "qrow" }, h("div", {}, h("p", { class: "kicker", text: q.accepted ? "Agreed price" : "Current quote" }), h("p", { class: "price", text: money(q.price) }), deal.first_price && deal.first_price !== q.price ? h("p", { class: "oaw-muted small", text: `First quote ${money(deal.first_price)} · saved ${money(deal.first_price - q.price)}` }) : null),
        q.scene ? h("dl", { class: "kv" }, ...[["Blueprint", q.scene.title], ["Terrain", q.scene.terrain_type], ["Structures", String(q.scene.structures.length)], ["Water", q.scene.water_feature ? "resin" : "none"], ["LEDs", String(q.scene.led_points.length)], ["Lead time", `${q.lead_time_days} days`]].flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])) : null),
      q.message ? h("p", { class: "msg", text: `“${q.message}”` }) : null,
      deal.history.length > 1 ? h("ol", { class: "hist" }, ...deal.history.map((x) => h("li", { class: x.by, text: `${x.by === "buyer" ? "You" : "Supplier"}: ${money(x.price)}${x.note ? ` · ${x.note}` : ""}` }))) : null) : null,
    deal.result ? h("p", { class: `result ${deal.result.ok ? "ok" : "bad"}`, text: deal.result.text }) : null,
  ].filter(Boolean));
}

function drawRegistry() {
  $("#suppliers").replaceChildren(...registry.map((url) => {
    const d = discovered.get(url.replace(/\/+$/, ""));
    const status = !d ? "not checked" : d.ok ? `✓ ${d.capabilities.length} capabilities · ${d.scales.join(", ")}` : `✗ ${d.error}`;
    return h("li", { class: d ? (d.ok ? "ok" : "bad") : "" },
      h("div", {}, h("strong", { text: d?.name || host(url) }), h("p", { class: "oaw-muted small", text: url }), h("p", { class: "small status", text: status })),
      h("div", { class: "oaw-row" },
        h("button", { class: "oaw-btn small", type: "button", text: "Check", onclick: () => discoverOne(url).catch(() => {}) }),
        published.includes(url) ? h("span", { class: "oaw-badge", text: "published", title: "Listed in this hub's agent-manifest.json" }) : h("button", { class: "oaw-btn small ghost", type: "button", text: "Remove", "aria-label": `Remove ${url}`, onclick: () => { custom = custom.filter((x) => x !== url); registry = registry.filter((x) => x !== url); saveCustom(); drawRegistry(); } })));
  }));
}
$("#addSupplier").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#supplierUrl").value.trim().replace(/\/+$/, "");
  try {
    const u = new URL(v);
    if (!["http:", "https:"].includes(u.protocol)) throw new Error();
    if (u.protocol === "http:" && !["localhost", "127.0.0.1"].includes(u.hostname)) throw new Error("Use https:// for live sites (http:// only for localhost).");
    if (!pageIsLocal && isLoopback(v)) throw new Error("This hub is public; a localhost supplier only works when the hub itself runs on localhost (npm start).");
  } catch (err) { $("#supplierMsg").textContent = err.message || "Enter a valid http(s) URL."; return; }
  $("#supplierMsg").textContent = "";
  if (!registry.includes(v)) { registry.push(v); if (!published.includes(v)) { custom.push(v); saveCustom(); } }
  $("#supplierUrl").value = "";
  drawRegistry();
});

function drawOrders() {
  $("#orders").replaceChildren(...(orders.length ? orders.map((o) => h("li", {}, h("strong", { text: o.order_id }), ` · ${o.title || "diorama"} · ${money(o.price)} · slot ${o.slot_date} · ${o.supplier || host(o.supplier_url)}`)) : [h("li", { class: "oaw-muted", text: "No orders yet." })]));
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#request").value.trim();
  if (v) runCommission(v).catch(() => { /* shown in the stream and the deal panel */ });
});
for (const ex of [
  "Commission a 1:35 WWII Desert Trench diorama, 40x40cm, with resin river and LED explosions, budget $450",
  "1:72 snowy pine forest diorama, 30x20cm, frozen lake and 3 lanterns, budget $280",
  "1:48 jungle diorama 30x30cm, budget $200",
]) $("#examples").append(h("button", { class: "chip", type: "button", text: ex, onclick: () => { $("#request").value = ex; $("#request").focus(); } }));

/* ---------------------------------------------------- settings + inspector */

createStatusPill($("#pill"), runtime);
const settings = createSettings({ runtime });
$("#settingsBtn").addEventListener("click", () => settings.open());
const inspector = createInspector({
  getEntries: () => [
    { label: "This hub", url: new URL("agent-manifest.json", location.href).href, manifest, network, cors: "*" },
    ...[...discovered.values()].map((d) => ({ label: d.name, url: `${d.url}/agent-manifest.json`, manifest: d.manifest, network: d.network, cors: d.cors, error: d.error })),
  ],
});
$("#manifestBtn").addEventListener("click", () => inspector.open());

/* ------------------------------------------------------- interoperability */

function getState() {
  return { site: "buyer-hub", busy, provider: runtime.describeProvider(), suppliers: registry.map((u) => { const d = discovered.get(u); return { url: u, name: d?.name, ok: d?.ok ?? null, error: d?.error || null }; }), deal: deal && { prompt: deal.prompt, steps: deal.steps, rfq: deal.rfq, quote: deal.quote && buyerView(deal.quote), history: deal.history, result: deal.result }, orders: orders.map((o) => ({ ...o })), stats: { ...runtime.stats } };
}
serveRpc({
  runtime,
  trustedOrigins: manifest.rpc.trusted_origins || [],
  consent: (r) => consent({ ...r, direction: "inbound" }),
  methods: {
    ping: () => ({ site: "buyer-hub", name: manifest.name, ready: true, provider: runtime.describeProvider().label }),
    manifest: () => manifest,
    getState: () => getState(),
    run: ({ prompt }) => runCommission(String(prompt || "")),
    callTool: ({ tool, args }, ctx) => runtime.callTool(String(tool), args || {}, ctx),
  },
});
exposeGlobal({
  manifest,
  run: (prompt) => runCommission(prompt),
  callTool: (name, args) => runtime.callTool(name, args, { origin: location.origin }),
  getState,
  extra: { openSplitView: (url) => openSplit(url || defaultSupplier()) },
});

/* ----------------------------------------------------------------- boot */

drawDeal();
drawRegistry();
drawOrders();
await runtime.probeNano();
stream.add({ type: "note", text: `Build ${BUILD} · network "${network.metadata.name}" loaded from agent-manifest.json · ${runtime.describeProvider().label} · suppliers: ${registry.map((u) => host(u) + new URL(u).pathname.replace(/\/$/, "")).join(", ")}` });
if (skipped.length) stream.add({ type: "note", text: `Ignored saved localhost supplier(s) on this public page: ${skipped.join(", ")}` });
document.body.dataset.ready = "true";
