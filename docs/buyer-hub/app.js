/**
 * OpenAgentic Procurement & Commission Hub (Site A).
 * intake_agent -> discovery_agent -> negotiator_agent, driving the supplier's agents over postMessage RPC.
 */
import { AgentRuntime, RpcClient, serveRpc, exposeGlobal, fetchJson, validateManifest, OawError } from "./shared/oaw-core.js?v=fa9d47957d";
import { h, $, money, createStream, createApproval, createConsent, createSettings, createStatusPill, createInspector } from "./shared/oaw-ui.js?v=fa9d47957d";
import * as H from "./hub-logic.js?v=fa9d47957d";

const BUILD = document.querySelector('meta[name="oaw-build"]')?.content || "dev";
const manifest = await (await fetch("./agent-manifest.json", { cache: "no-store" })).json();
const network = await (await fetch(`./${manifest.networks[0].hocon}`, { cache: "no-store" })).json();
const host = (u) => { try { return new URL(u).host; } catch { return u; } };
const originOf = (u) => new URL(u).origin;

/* ----------------------------------------------------------------- state */

const SUPPLIERS_KEY = "market.hub.suppliers.custom.v1"; // only suppliers the visitor added
const ORDERS_KEY = "market.hub.orders.v1";
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

// One live frame and one RPC client per supplier (keyed by its base URL, not its origin:
// on GitHub Pages several shops share one origin).
const frames = new Map(); // supplierUrl -> { el, wrap, origin }
const clients = new Map(); // supplierUrl -> RpcClient
let tab = null, tabUrl = null;
const shortName = (url) => (discovered.get(trimUrl(url))?.name || host(url)).split(" — ")[0];

function frameFor(url) {
  const key = trimUrl(url);
  let f = frames.get(key);
  if (!f) {
    const u = new URL(`${key}/`); // the site's folder, no redirect needed
    u.searchParams.set("embedded", "1");
    if (BUILD !== "dev") u.searchParams.set("v", BUILD); // never reuse a stale cached studio page
    const el = h("iframe", { src: u.href, title: `${shortName(key)} (live)`, class: "peer-frame" });
    const wrap = h("div", { class: "peer" }, h("div", { class: "peer-label" }, h("strong", { text: shortName(key) }), h("span", { class: "oaw-muted small", text: ` ${host(key)}${new URL(key).pathname}` })), el);
    f = { el, wrap, origin: originOf(key) };
    frames.set(key, f);
    $("#splitFrame").append(wrap);
    const c = clients.get(key);
    if (c) c.ready = false;
  }
  return f;
}
function openSplit(urls) {
  for (const u of [].concat(urls)) frameFor(u);
  $("#splitFrame").dataset.count = String(frames.size);
  $("#splitTitle").textContent = frames.size > 1 ? `${frames.size} suppliers, live` : [...frames.keys()].map(host).join("");
  document.body.classList.add("split-on");
  $("#splitBtn").setAttribute("aria-pressed", "true");
  $("#splitBtn").textContent = "Close Split-View";
}
function closeSplit() {
  document.body.classList.remove("split-on");
  for (const [key, f] of frames) { f.wrap.remove(); const c = clients.get(key); if (c) c.ready = false; }
  frames.clear();
  $("#splitBtn").setAttribute("aria-pressed", "false");
  $("#splitBtn").textContent = "Open Studio Split-View";
}
const defaultSupplier = () => registry[0] || published[0];
$("#splitBtn").addEventListener("click", () => (document.body.classList.contains("split-on") ? closeSplit() : openSplit(registry)));
$("#tabBtn").addEventListener("click", () => { tab = window.open(defaultSupplier(), "agentic-supplier"); tabUrl = trimUrl(defaultSupplier()); });

function peerWindow(url) {
  const key = trimUrl(url);
  const f = frames.get(key);
  if (f?.el.contentWindow) return f.el.contentWindow;
  if (tab && !tab.closed && tabUrl === key) return tab;
  return null;
}

async function peer(url) {
  const key = trimUrl(url);
  if (!peerWindow(key)) openSplit(key); // RPC needs a live window of the supplier site
  let c = clients.get(key);
  if (!c) {
    c = new RpcClient({ origin: originOf(key), getWindow: () => peerWindow(key), onEvent: (ev) => onRemote(ev, key) });
    clients.set(key, c);
  }
  if (!c.ready) {
    const t0 = performance.now();
    const info = await c.connect();
    c.ready = true;
    runtime.emit({ type: "rpc", direction: "out", method: "ping", origin: key, ms: Math.round(performance.now() - t0), ok: true });
    runtime.emit({ type: "note", text: `Connected to ${info.name} (${host(key)}) · supplier runs its own agents with: ${info.provider}` });
  }
  return c;
}

async function rpc(url, method, params) {
  const key = trimUrl(url);
  const c = await peer(key);
  runtime.emit({ type: "rpc", direction: "out", method, tool: params?.tool || null, origin: key });
  const t0 = performance.now();
  try {
    const r = await c.call(method, params);
    const failed = r && typeof r === "object" && ["failed", "rejected"].includes(r.status);
    runtime.emit({ type: "rpc", direction: "out", method: failed ? `${method} → ${r.status}` : `${method} ✓`, tool: params?.tool || null, origin: key, ms: Math.round(performance.now() - t0), ok: !failed });
    return r;
  } catch (e) {
    runtime.emit({ type: "rpc", direction: "out", method, tool: params?.tool || null, origin: key, ms: Math.round(performance.now() - t0), ok: false });
    throw e;
  }
}

/** Events streamed from a supplier during an RPC call, labelled with the shop's name. */
const pendingAt = new Map(); // supplierUrl -> pending approval text
function onRemote(ev, key) {
  if (ev.type === "rpc" && ev.direction === "in") return; // our own request echoed back
  stream.add(ev, { remote: shortName(key) });
  if (ev.type === "approval") {
    if (ev.state === "pending") pendingAt.set(key, `${shortName(key)}: approve or reject "${ev.tool}"${ev.price != null ? ` (${money(ev.price)})` : ""}`);
    else pendingAt.delete(key);
    const bar = $("#splitAttention");
    bar.hidden = !pendingAt.size;
    bar.textContent = pendingAt.size ? `Action needed · ${[...pendingAt.values()].join(" · ")}${document.body.classList.contains("split-on") ? " in its studio pane →" : " in the studio tab"}` : "";
    frames.get(key)?.wrap.classList.toggle("attention", ev.state === "pending");
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
    normalize: (out, input) => H.normalizeShortlist(out, input),
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
      // Comparison quote: the studio designs, prices and renders, but writes nothing until this buyer confirms.
      const r = await rpc(supplier_url, "callTool", { tool: "request_quote", args: { rfq, caller_agent: "negotiator_agent", log_rfq: false } });
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
        lines: [["Supplier", q.supplier || host(args.supplier_url)], ...(deal?.quotes?.length > 1 ? [["Compared with", deal.quotes.filter((x) => x.url !== trimUrl(args.supplier_url)).map((x) => `${x.short} ${x.quote ? money(x.quote.price) : "(no quote)"}`).join(", ")]] : []), ["Quote", args.quote_id], ["Diorama", q.scene?.title || "—"], ["Scale · size", `${q.scale || "—"} · ${q.scene ? `${q.scene.base_width}×${q.scene.base_depth} cm` : "—"}`], ["Lead time", q.lead_time_days ? `${q.lead_time_days} days` : "—"], ["Your budget", money(args.max_budget)], ["First quote", money(deal?.first_price)]],
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

const STEPS = ["Intake", "Discovery", "Quotes", "Choose", "Negotiate", "Approve", "Confirmed"];

/** Wait for the human (or "Let the agent pick") to choose one of the comparison quotes. */
function awaitChoice(options) {
  return new Promise((resolve) => {
    deal.choice = { options, resolve: (url, by) => { deal.choice = null; resolve({ url, by }); } };
    drawDeal();
    $("#deal").scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}
function chooseQuote(which) {
  const c = deal?.choice;
  if (!c) throw new OawError("NO_CHOICE", "There is no comparison waiting for a choice.");
  if (which === "agent") return c.resolve(H.rankQuotes(c.options.map((o) => ({ ...o.quote, url: o.url })), deal.rfq.max_budget)[0].url, "agent");
  const o = typeof which === "number" ? c.options[which] : c.options.find((x) => x.url === trimUrl(which));
  if (!o) throw new OawError("BAD_CHOICE", `No quote ${which}.`);
  c.resolve(o.url, "you");
}
function step(name, state) { deal.steps[name] = state; drawDeal(); }
const buyerView = (q) => ({ quote_id: q.quote_id, supplier: q.supplier, price: q.price, list_price: q.list_price, currency: q.currency, lead_time_days: q.lead_time_days, scale: q.scale, final: !!q.final, accepted: !!q.accepted, round: q.round, message: q.message, blueprint: q.scene ? { terrain: q.scene.terrain_type, size_cm: [q.scene.base_width, q.scene.base_depth], structures: q.scene.structures.length, water: q.scene.water_feature, leds: q.scene.led_points.length } : null });
const ok = (r, what) => { if (r.status === "succeeded") return r.result; throw new OawError(r.code || "TOOL_FAILED", `${what}: ${r.error || r.status}`); };

async function runCommission(prompt) {
  if (busy) throw new OawError("BUSY", "A commission is already running.");
  busy = true;
  setBusy(true);
  deal = { prompt, steps: {}, history: [], rfq: null, supplier: null, quote: null, quotes: [], choice: null, first_price: null, result: null };
  for (const f of frames.values()) f.wrap.classList.remove("chosen", "passed");
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
    const shortlist = pick.shortlist.map((u) => eligible.find((s) => s.url === u)).filter(Boolean);
    runtime.emit({ type: "note", agent: "discovery_agent", text: `Shortlisted ${shortlist.map((s) => shortName(s.url)).join(", ")}: ${pick.reason}` });
    step("Discovery", "done");

    step("Quotes", "active");
    runtime.emit({ type: "handoff", from: "discovery_agent", to: "negotiator_agent" });
    openSplit(shortlist.map((s) => s.url)); // every shop renders its own 3D blueprint side by side
    deal.quotes = shortlist.map((s) => ({ url: s.url, name: s.name, short: shortName(s.url), quote: null, error: null, pending: true }));
    drawDeal();
    await Promise.all(deal.quotes.map(async (row) => {
      try {
        const q = ok(await runtime.callTool("request_supplier_quote", { supplier_url: row.url, rfq }), `Quote from ${row.short}`);
        if (q.status === "rejected") row.error = `Cannot build this: ${q.reason}`;
        else row.quote = q;
      } catch (e) { row.error = e.message; }
      row.pending = false;
      drawDeal();
    }));
    const options = deal.quotes.filter((r) => r.quote);
    if (!options.length) throw new OawError("NO_QUOTES", `No supplier could quote this. ${deal.quotes.map((r) => `${r.short}: ${r.error}`).join("; ")}`);
    runtime.emit({ type: "note", agent: "negotiator_agent", text: `Quotes: ${deal.quotes.map((r) => `${r.short} ${r.quote ? `${money(r.quote.price)}, ${r.quote.lead_time_days} days` : "no quote"}`).join(" · ")}` });
    step("Quotes", "done");

    step("Choose", "active");
    let chosen;
    if (options.length === 1) { chosen = { url: options[0].url, by: "only quote" }; runtime.emit({ type: "note", text: `Only ${options[0].short} quoted; continuing with it.` }); }
    else {
      runtime.emit({ type: "approval", state: "pending", tool: "choose_quote" });
      chosen = await awaitChoice(options);
      runtime.emit({ type: "approval", state: "approved", tool: `choose_quote → ${shortName(chosen.url)} (picked by ${chosen.by})` });
    }
    const row = options.find((o) => o.url === chosen.url);
    deal.supplier = eligible.find((s) => s.url === row.url);
    for (const [key, f] of frames) { f.wrap.classList.toggle("chosen", key === row.url); f.wrap.classList.toggle("passed", key !== row.url && deal.quotes.some((q) => q.url === key)); }
    let quote = row.quote;
    deal.quote = quote; deal.first_price = quote.price;
    deal.history.push({ by: "supplier", price: quote.price, note: "first quote" });
    step("Choose", "done");

    step("Negotiate", "active");
    let accepted = false;
    for (let round = 1; round <= H.MAX_ROUNDS + 1 && !accepted; round++) {
      const d = await runtime.runAgent("negotiator_agent", { rfq, quote: buyerView(quote), round, history: deal.history }, { from: round === 1 ? "negotiator_agent" : `diorama_estimator@${shortName(deal.supplier.url)}` });
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
    deal.quotes.length ? drawComparison() : null,
    deal.supplier ? h("p", { class: "oaw-muted small", text: `Chosen supplier: ${deal.supplier.name} · ${deal.supplier.url}` }) : null,
    q ? h("div", { class: "card quote" },
      h("div", { class: "qrow" }, h("div", {}, h("p", { class: "kicker", text: q.accepted ? "Agreed price" : "Current quote" }), h("p", { class: "price", text: money(q.price) }), deal.first_price && deal.first_price !== q.price ? h("p", { class: "oaw-muted small", text: `First quote ${money(deal.first_price)} · saved ${money(deal.first_price - q.price)}` }) : null),
        q.scene ? h("dl", { class: "kv" }, ...[["Blueprint", q.scene.title], ["Terrain", q.scene.terrain_type], ["Structures", String(q.scene.structures.length)], ["Water", q.scene.water_feature ? "resin" : "none"], ["LEDs", String(q.scene.led_points.length)], ["Lead time", `${q.lead_time_days} days`]].flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])) : null),
      q.message ? h("p", { class: "msg", text: `“${q.message}”` }) : null,
      deal.history.length > 1 ? h("ol", { class: "hist" }, ...deal.history.map((x) => h("li", { class: x.by, text: `${x.by === "buyer" ? "You" : deal.supplier ? shortName(deal.supplier.url) : "Supplier"}: ${money(x.price)}${x.note ? ` · ${x.note}` : ""}` }))) : null) : null,
    deal.result ? h("p", { class: `result ${deal.result.ok ? "ok" : "bad"}`, text: deal.result.text }) : null,
  ].filter(Boolean));
}

/** Side-by-side quote cards. While a choice is pending they carry the "Choose this quote" buttons. */
function drawComparison() {
  const budget = deal.rfq?.max_budget;
  const quoted = deal.quotes.filter((r) => r.quote).map((r) => r.quote);
  const waiting = !!deal.choice;
  const best = waiting ? H.rankQuotes(deal.quotes.filter((r) => r.quote).map((r) => ({ ...r.quote, url: r.url })), budget)[0]?.url : null;
  return h("div", { class: "compare" },
    h("p", { class: "kicker", text: waiting ? "Compare the quotes and choose one · both 3D blueprints are live in the split view" : `Quotes from ${deal.quotes.length} supplier${deal.quotes.length > 1 ? "s" : ""}` }),
    h("div", { class: "qgrid" }, ...deal.quotes.map((r, i) => {
      const q = r.quote;
      const chosen = deal.supplier?.url === r.url;
      return h("div", { class: `qcard ${chosen ? "chosen" : ""} ${deal.supplier && !chosen ? "passed" : ""}` },
        h("p", { class: "qshop", text: r.short }),
        r.pending ? h("p", { class: "oaw-muted small", text: "Designing the 3D blueprint and pricing it…" }) : null,
        r.error ? h("p", { class: "oaw-bad small", text: r.error }) : null,
        q ? h("p", { class: "price", text: money(q.price) }) : null,
        q ? h("div", { class: "tags" }, ...H.quoteBadges(q, quoted, budget).map((t) => h("span", { class: `tag ${/Over/.test(t) ? "bad" : /Within/.test(t) ? "ok" : ""}`, text: t }))) : null,
        q ? h("dl", { class: "kv" }, ...[["Lead time", `${q.lead_time_days} days`], ["Blueprint", q.scene?.title || "—"], ["Structures", String(q.scene?.structures.length ?? "—")], ["Water · LEDs", `${q.scene?.water_feature ? "resin" : "none"} · ${q.scene?.led_points.length ?? 0}`], ["Labour", `${q.breakdown.labor_hours} h × $${q.breakdown.labor_rate}`]].flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])) : null,
        waiting && q ? h("button", { class: "oaw-btn primary", type: "button", text: "Choose this quote", "aria-label": `Choose ${r.short} at ${money(q.price)}`, onclick: () => chooseQuote(i) }) : null,
        waiting && q && r.url === best ? h("p", { class: "oaw-muted small", text: "Agent's pick: within budget, then lowest price, then fastest." }) : null,
        chosen ? h("p", { class: "small chosen-note", text: "✓ Chosen" }) : null);
    })),
    waiting ? h("div", { class: "oaw-row" }, h("button", { class: "oaw-btn ghost", type: "button", text: "Let the agent pick", onclick: () => chooseQuote("agent") })) : null);
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
  extra: { openSplitView: (url) => openSplit(url || registry), chooseQuote: (which) => chooseQuote(which) },
});

/* ----------------------------------------------------------------- boot */

drawDeal();
drawRegistry();
drawOrders();
await runtime.probeNano();
stream.add({ type: "note", text: `Build ${BUILD} · network "${network.metadata.name}" loaded from agent-manifest.json · ${runtime.describeProvider().label} · suppliers: ${registry.map((u) => host(u) + new URL(u).pathname.replace(/\/$/, "")).join(", ")}` });
if (skipped.length) stream.add({ type: "note", text: `Ignored saved localhost supplier(s) on this public page: ${skipped.join(", ")}` });
document.body.dataset.ready = "true";
