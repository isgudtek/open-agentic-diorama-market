/**
 * Miniature Worlds (Site B): agents, tools, the commission board, the live 3D viewport and the RPC surface.
 */
import { AgentRuntime, serveRpc, exposeGlobal, OawError, uid } from "./shared/oaw-core.js";
import { h, $, money, createStream, createApproval, createConsent, createSettings, createStatusPill, createInspector } from "./shared/oaw-ui.js";
import * as L from "./studio-logic.js";

const embedded = window.parent !== window || new URLSearchParams(location.search).has("embedded");
document.body.classList.toggle("embedded", embedded);

const BUILD = document.querySelector('meta[name="oaw-build"]')?.content || "dev";
const manifest = await (await fetch("./agent-manifest.json", { cache: "no-store" })).json();
const network = await (await fetch(`./${manifest.networks[0].hocon}`, { cache: "no-store" })).json();
const host = (origin) => { try { return new URL(origin).host; } catch { return origin; } };

/* ----------------------------------------------------------- board store */

/** localStorage today. Firebase-ready: swap load/save for Firestore reads/writes with the same card shape. */
class BoardStore {
  constructor(key) { this.key = key; }
  load() { try { const v = JSON.parse(localStorage.getItem(this.key) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }
  save(cards) { localStorage.setItem(this.key, JSON.stringify(cards)); }
}
const COLUMNS = ["Incoming RFQ", "3D Blueprint Approved", "In Fabrication"];
const store = new BoardStore("studio.board.v1");
let cards = store.load();
const quotes = new Map(); // quote_id -> internal quote (includes the floor, never sent to buyers)

/* ------------------------------------------------------------- viewport */

let viewer = null;
const vp = $("#viewport");
try {
  const { createViewer } = await import("./scene.js");
  viewer = createViewer(vp);
} catch (e) {
  $("#vpEmpty").hidden = true;
  vp.append(h("div", { class: "vp-error" }, h("strong", { text: "3D preview unavailable" }), h("span", { text: ` Three.js loads from cdn.jsdelivr.net (${e.message}). Agents, quotes and the board still work.` })));
}
function showScene(scene, label) {
  const stats = viewer ? viewer.render(scene) : null;
  $("#viewer").classList.remove("empty");
  $("#vpTitle").textContent = scene.title;
  $("#vpMeta").textContent = `${label ? `${label} · ` : ""}${scene.terrain_type} · ${scene.base_width}×${scene.base_depth} cm · ${scene.structures.length} structures${scene.water_feature ? " · resin water" : ""}${scene.led_points.length ? ` · ${scene.led_points.length} LEDs` : ""}`;
  $("#vpStats").textContent = stats ? `${stats.triangles.toLocaleString()} triangles` : "";
  return stats;
}
$("#rotateBtn").addEventListener("click", (e) => { const on = e.currentTarget.getAttribute("aria-pressed") !== "true"; e.currentTarget.setAttribute("aria-pressed", String(on)); viewer?.setAutoRotate(on); });
$("#resetBtn").addEventListener("click", () => viewer?.resetView());

/* ---------------------------------------------------------- UI helpers */

const stream = createStream($("#stream"));
const approve = createApproval();
const consent = createConsent();

function drawBoard() {
  for (const col of COLUMNS) {
    const list = $(`[data-col="${col}"] .cards`);
    const items = cards.filter((c) => c.status === col);
    $(`[data-col="${col}"] .count`).textContent = String(items.length);
    list.replaceChildren(...items.map((c) => h("li", { class: "bcard" },
      h("p", { class: "btitle", text: c.title }),
      h("p", { class: "bmeta", text: `${c.scale} · ${c.dims} · ${money(c.price)}` }),
      h("p", { class: "bmeta", text: c.buyer === location.origin ? "Walk-in visitor" : `Buyer agent: ${host(c.buyer)}` }),
      c.slot_date ? h("p", { class: "bmeta", text: `Build slot ${c.slot_date}${c.order_id ? ` · ${c.order_id}` : ""}` }) : null,
      col === "3D Blueprint Approved" ? h("button", { class: "oaw-btn small", type: "button", text: "Start fabrication", onclick: () => act(() => runtime.callTool("start_fabrication", { order_id: c.order_id })) }) : null,
    )));
  }
}

let shownQuote = null;
function drawQuote(q) {
  shownQuote = q;
  const box = $("#quote");
  if (!q) { box.replaceChildren(h("p", { class: "oaw-muted", text: "Describe a diorama to get a 3D blueprint and a quote." })); return; }
  const card = cards.find((c) => c.quote_id === q.quote_id);
  const b = q.breakdown;
  box.replaceChildren(...[
    h("div", { class: "qhead" }, h("div", {}, h("p", { class: "qkicker", text: q.status === "confirmed" ? "Commission confirmed" : q.status === "accepted" ? "Price agreed" : "Quote" }), h("p", { class: "qprice", text: money(q.price) }), q.price !== q.base_price ? h("p", { class: "oaw-muted small", text: `List price ${money(q.base_price)}` }) : null),
      h("dl", { class: "qkv" }, ...[["Scale", q.scale], ["Materials", money(b.materials)], ["Labour", `${b.labor_hours} h × $${b.labor_rate}`], ["Lead time", `${q.lead_time_days} days`], ["Buyer", q.buyer === location.origin ? "walk-in" : host(q.buyer)]].flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })]))),
    q.message ? h("p", { class: "qmsg", text: q.message }) : null,
    q.history.length > 1 ? h("ol", { class: "qhist" }, ...q.history.map((x) => h("li", { class: x.by, text: `${x.by === "buyer" ? "Buyer" : "Studio"}: ${money(x.price)}${x.note ? ` · ${x.note}` : ""}` }))) : null,
    h("div", { class: "oaw-row" },
      !card ? h("button", { class: "oaw-btn", type: "button", text: "Request commission (log RFQ)", onclick: () => act(() => runtime.callTool("log_rfq", { quote_id: q.quote_id })) }) : null,
      q.status !== "confirmed" ? h("button", { class: "oaw-btn primary", type: "button", text: `Approve blueprint & lock slot at ${money(q.price)}`, onclick: () => act(() => runtime.callTool("confirm_commission", { quote_id: q.quote_id, price: q.price, buyer_ref: "walk-in" })) }) : null),
  ].filter(Boolean));
}

async function act(fn) {
  try {
    const r = await fn();
    if (r?.status === "failed") stream.add({ type: "error", text: r.error });
  } catch (e) { stream.add({ type: "error", text: e.message }); }
}

/* ------------------------------------------------------- agents + tools */

const publicQuote = (q) => ({
  status: q.status === "open" ? "quoted" : q.status, quote_id: q.quote_id, supplier: manifest.name, supplier_origin: location.origin,
  price: q.price, list_price: q.base_price, currency: "USD", scale: q.scale, breakdown: q.breakdown, lead_time_days: q.lead_time_days,
  scene: q.scene, message: q.message, round: q.rounds, max_rounds: L.MAX_ROUNDS, logged: !!cards.find((c) => c.quote_id === q.quote_id),
});
const needQuote = (id) => { const q = quotes.get(id); if (!q) throw new OawError("NO_QUOTE", `Unknown quote ${id}. Quotes live for this browser session.`); return q; };
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
let runtime;

const agentImpl = {
  diorama_designer: {
    prompt: (input) => (input.rfq ? `RFQ from a buyer agent:\n${JSON.stringify(input.rfq)}` : `Commission brief from a visitor:\n${input.brief}`),
    deterministic: (input) => L.designDeterministic(input),
    normalize: (out, input) => L.normalizeScene(out, input),
  },
  diorama_estimator: {
    prompt: (input) => JSON.stringify(input, null, 1),
    deterministic: (input) => L.estimatorDeterministic(input),
    normalize: (out) => ({ decision: ["quote", "accept", "counter"].includes(out?.decision) ? out.decision : "counter", price: Number(out?.price), message: String(out?.message || "").slice(0, 400) }),
  },
  workshop_operator: {
    ruleBased: true,
    async run({ quote_id, log }) {
      const q = needQuote(quote_id);
      await runtime.callTool("render_diorama_preview", { scene: q.scene });
      if (log) await runtime.callTool("log_rfq", { quote_id }, { origin: q.buyer });
      return { rendered: true, logged: !!cards.find((c) => c.quote_id === quote_id) };
    },
  },
};

async function designAndQuote({ rfq, brief }, ctx = {}) {
  const from = ctx.remote ? `${ctx.callerAgent || "peer"}@${host(ctx.origin)}` : "user";
  const parsed = rfq || { ...L.parseBrief(brief), theme: L.parseBrief(brief).theme };
  const scene = await runtime.runAgent("diorama_designer", rfq ? { rfq } : { brief }, { from });
  const est = L.estimate(scene, parsed.scale);
  if (!est.ok) {
    showScene(scene, "Not quotable");
    runtime.emit({ type: "note", agent: "diorama_estimator", text: est.reason });
    return { status: "rejected", reason: est.reason, supplier: manifest.name, scene };
  }
  const msg = await runtime.runAgent("diorama_estimator", { mode: "quote", quote: { price: est.price, breakdown: est.breakdown, lead_time_days: est.lead_time_days, scale: est.scale } }, { from: "diorama_designer" });
  const q = {
    quote_id: uid("MWQ"), rfq: parsed, scene, scale: est.scale, base_price: est.price, price: est.price, floor: L.floorPrice(est.price),
    breakdown: est.breakdown, lead_time_days: est.lead_time_days, rounds: 0, status: "open", buyer: ctx.origin || location.origin,
    message: msg.message || L.estimatorDeterministic({ mode: "quote", quote: est }).message, history: [{ by: "studio", price: est.price, note: "list price" }], created: Date.now(),
  };
  quotes.set(q.quote_id, q);
  await runtime.runAgent("workshop_operator", { quote_id: q.quote_id, log: !!ctx.logRfq }, { from: "diorama_estimator" });
  drawQuote(q);
  return publicQuote(q);
}

const tools = {
  request_quote: {
    effect: "preview", rpc: true, title: "Design and quote a diorama",
    input_schema: { type: "object", required: ["rfq"], properties: { rfq: { type: "object" }, caller_agent: { type: "string" } } },
    handler: (args, ctx) => designAndQuote({ rfq: args.rfq }, { ...ctx, callerAgent: args.caller_agent, logRfq: true }),
  },
  negotiate_quote: {
    effect: "preview", rpc: true, title: "Counter-offer",
    input_schema: { type: "object", required: ["quote_id", "counter_price"], properties: { quote_id: { type: "string" }, counter_price: { type: "number", minimum: 1 }, message: { type: "string" } } },
    async handler({ quote_id, counter_price, message }, ctx) {
      const q = needQuote(quote_id);
      if (q.status !== "open") return { ...publicQuote(q), accepted: q.status === "accepted", final: true };
      q.rounds++;
      const counter = Math.round(counter_price);
      q.history.push({ by: "buyer", price: counter, note: message ? String(message).slice(0, 80) : "" });
      runtime.emit({ type: "negotiation", text: `Round ${q.rounds}/${L.MAX_ROUNDS}: buyer offers ${money(counter)} against ${money(q.price)}` });
      const out = await runtime.runAgent("diorama_estimator", { mode: "negotiate", quote: { price: q.price, list_price: q.base_price }, counter_price: counter, floor_price: q.floor, round: q.rounds, max_rounds: L.MAX_ROUNDS, buyer_message: message || "" }, { from: ctx.remote ? `negotiator_agent@${host(ctx.origin)}` : "user" });
      const r = L.enforceNegotiation(out, { counter, floor: q.floor, current: q.price, round: q.rounds });
      if (r.policy) runtime.emit({ type: "note", agent: "diorama_estimator", text: `Studio policy: ${r.policy}` });
      q.price = r.price;
      if (r.accepted) q.status = "accepted";
      q.message = r.policy || !out.message ? L.estimatorDeterministic({ mode: "negotiate", counter_price: counter, floor_price: q.floor, quote: { price: r.accepted ? counter : r.price } }).message : out.message;
      q.history.push({ by: "studio", price: q.price, note: r.accepted ? "accepted" : r.final ? "final offer" : "counter" });
      runtime.emit({ type: "negotiation", text: r.accepted ? `Studio accepts ${money(q.price)}` : `Studio counters ${money(q.price)}${r.final ? " (final offer)" : ""}` });
      drawQuote(q);
      return { ...publicQuote(q), accepted: r.accepted, final: r.final };
    },
  },
  render_diorama_preview: {
    effect: "preview", rpc: true, title: "Render 3D preview",
    input_schema: { type: "object", required: ["scene"], properties: { scene: { type: "object" } } },
    handler({ scene }) {
      const s = L.normalizeScene(scene, {});
      const stats = showScene(s);
      return stats ? { rendered: true, ...stats } : { rendered: false, reason: "3D viewport not available in this browser." };
    },
  },
  get_board: {
    effect: "read", rpc: true, title: "Read the board",
    input_schema: { type: "object", properties: {} },
    handler: () => ({ columns: COLUMNS, cards: cards.map((c) => ({ ...c })) }),
  },
  log_rfq: {
    effect: "write", rpc: false, title: "Log incoming RFQ on the commission board",
    input_schema: { type: "object", required: ["quote_id"], properties: { quote_id: { type: "string" } } },
    precheck({ quote_id }) { needQuote(quote_id); if (cards.find((c) => c.quote_id === quote_id)) throw new OawError("DUPLICATE", "This RFQ is already on the board."); },
    describe({ quote_id }) {
      const q = quotes.get(quote_id);
      return { price: q.price, summary: "Add this RFQ to the Incoming RFQ column of the commission board.", lines: [["Diorama", q.scene.title], ["Scale · size", `${q.scale} · ${q.scene.base_width}×${q.scene.base_depth} cm`], ["Buyer", q.buyer === location.origin ? "walk-in visitor" : q.buyer]] };
    },
    handler({ quote_id }) {
      const q = needQuote(quote_id);
      const card = { id: uid("card"), quote_id, title: q.scene.title, scale: q.scale, dims: `${q.scene.base_width}×${q.scene.base_depth} cm`, price: q.price, buyer: q.buyer, status: "Incoming RFQ", created: new Date().toISOString() };
      cards.push(card); store.save(cards); drawBoard(); drawQuote(q);
      return { card_id: card.id, column: card.status };
    },
  },
  confirm_commission: {
    effect: "write", rpc: true, title: "Lock a build slot and approve the 3D blueprint",
    input_schema: { type: "object", required: ["quote_id", "price"], properties: { quote_id: { type: "string" }, price: { type: "number" }, buyer_ref: { type: "string" } } },
    precheck({ quote_id, price }) {
      const q = needQuote(quote_id);
      if (q.status === "confirmed") throw new OawError("ALREADY_CONFIRMED", "This commission is already confirmed.");
      if (Math.abs(Number(price) - q.price) > 0.5) throw new OawError("PRICE_MISMATCH", `Price ${money(price)} does not match the agreed price ${money(q.price)}.`);
    },
    describe({ quote_id, price }, ctx) {
      const q = quotes.get(quote_id);
      return { price, summary: "Lock a build slot and move this commission to 3D Blueprint Approved.", lines: [["Diorama", q.scene.title], ["Scale · size", `${q.scale} · ${q.scene.base_width}×${q.scene.base_depth} cm`], ["Build slot", addDays(q.lead_time_days)], ["Lead time", `${q.lead_time_days} days`], ["Buyer", ctx.origin && ctx.origin !== location.origin ? ctx.origin : "walk-in visitor"]] };
    },
    handler({ quote_id, price, buyer_ref }) {
      const q = needQuote(quote_id);
      let card = cards.find((c) => c.quote_id === quote_id);
      if (!card) { card = { id: uid("card"), quote_id, title: q.scene.title, scale: q.scale, dims: `${q.scene.base_width}×${q.scene.base_depth} cm`, buyer: q.buyer, created: new Date().toISOString() }; cards.push(card); }
      Object.assign(card, { status: "3D Blueprint Approved", price, order_id: uid("MW").toUpperCase(), slot_date: addDays(q.lead_time_days), buyer_ref: buyer_ref || null });
      q.status = "confirmed";
      store.save(cards); drawBoard(); drawQuote(q);
      return { order_id: card.order_id, slot_date: card.slot_date, status: card.status, price, supplier: manifest.name };
    },
  },
  start_fabrication: {
    effect: "write", rpc: false, title: "Start fabrication",
    input_schema: { type: "object", required: ["order_id"], properties: { order_id: { type: "string" } } },
    precheck({ order_id }) { const c = cards.find((x) => x.order_id === order_id); if (!c || c.status !== "3D Blueprint Approved") throw new OawError("NOT_READY", "Only approved blueprints can start fabrication."); },
    describe({ order_id }) { const c = cards.find((x) => x.order_id === order_id); return { price: c.price, summary: "Move this order to In Fabrication.", lines: [["Order", order_id], ["Diorama", c.title]] }; },
    handler({ order_id }) { const c = cards.find((x) => x.order_id === order_id); c.status = "In Fabrication"; c.started = new Date().toISOString(); store.save(cards); drawBoard(); return { order_id, status: c.status }; },
  },
};

runtime = new AgentRuntime({ site: "studio", manifest, network, agentImpl, tools, settingsKey: "studio.oaw.settings.v1", approve });
runtime.on((e) => stream.add(e));

/* ---------------------------------------------------- settings + inspector */

createStatusPill($("#pill"), runtime);
const settings = createSettings({ runtime });
$("#settingsBtn").addEventListener("click", () => settings.open());
const inspector = createInspector({ getEntries: () => [{ label: "This studio", url: new URL("agent-manifest.json", location.href).href, manifest, network, cors: "*" }] });
$("#manifestBtn").addEventListener("click", () => inspector.open());

/* ---------------------------------------------------------- direct use */

async function runDirect(prompt) {
  runtime.emit({ type: "run_start", prompt });
  try {
    const q = await designAndQuote({ brief: prompt }, { logRfq: false });
    runtime.emit({ type: "run_end", ok: q.status !== "rejected", summary: q.status === "rejected" ? q.reason : `${q.scene.title}: ${money(q.price)}`, error: q.reason });
    return q;
  } catch (e) {
    runtime.emit({ type: "run_end", ok: false, error: `${e.code || "ERROR"}: ${e.message}` });
    throw e;
  }
}
$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = $("#prompt").value.trim();
  if (!v) return;
  const btn = $("#designBtn");
  btn.disabled = true;
  try { await runDirect(v); } catch { /* shown in the stream */ } finally { btn.disabled = false; }
});
for (const ex of ["1:35 WWII desert trench diorama, 40x40cm, with a resin river and LED explosions", "1:72 snowy pine forest diorama, 30x20cm, frozen lake and 3 lanterns", "1:64 bombed city street diorama, 35x25cm, with street lights"]) {
  $("#examples").append(h("button", { class: "chip", type: "button", text: ex, onclick: () => { $("#prompt").value = ex; $("#prompt").focus(); } }));
}

/* ------------------------------------------------------- interoperability */

const trusted = Array.isArray(manifest.rpc?.trusted_origins) ? manifest.rpc.trusted_origins : [];
serveRpc({
  runtime,
  trustedOrigins: trusted,
  consent: (r) => consent({ ...r, direction: "inbound" }),
  methods: {
    ping: () => ({ site: "diorama-studio", name: manifest.name, ready: true, provider: runtime.describeProvider().label }),
    manifest: () => manifest,
    getState: () => getState(),
    run: ({ prompt }, ctx) => designAndQuote({ brief: String(prompt || "") }, { ...ctx, logRfq: false }),
    callTool: ({ tool, args }, ctx) => runtime.callTool(String(tool), args || {}, ctx),
  },
});
function getState() {
  return { site: "diorama-studio", provider: runtime.describeProvider(), board: { columns: COLUMNS, cards: cards.map((c) => ({ ...c })) }, quotes: [...quotes.values()].map(publicQuote), scene: viewer?.scene?.title || null, stats: { ...runtime.stats } };
}
exposeGlobal({
  manifest,
  run: (prompt) => runDirect(prompt),
  callTool: (name, args) => runtime.callTool(name, args, { origin: location.origin }),
  getState,
  extra: { snapshot: () => viewer?.snapshot() || null },
});

/* ----------------------------------------------------------------- boot */

drawBoard();
drawQuote(null); // the viewport shows "The model you requested will appear here" until a quote renders
await runtime.probeNano();
stream.add({ type: "note", text: `Build ${BUILD} · network "${network.metadata.name}" loaded from agent-manifest.json · ${runtime.describeProvider().label}${embedded ? " · embedded by a buyer site" : ""}` });
document.body.dataset.ready = "true";
