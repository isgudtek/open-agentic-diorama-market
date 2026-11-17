/**
 * hub-logic.js: buyer-side rules for the procurement hub. Pure functions, unit-testable in Node.
 * The negotiator model proposes; this code guarantees the buyer's limits (never accept above budget).
 */

export const MAX_ROUNDS = 3;
const TERRAINS = ["desert", "urban", "forest", "snow"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => (v === null || v === "" || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round5 = (v) => Math.round(v / 5) * 5;

export function normalizeScale(s) {
  const m = String(s ?? "").match(/1\s*[:/]\s*(\d{1,3})/);
  return m ? `1:${Number(m[1])}` : null;
}

export function terrainOf(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(snow\w*|winter|ice|icy|arctic|frozen)\b/.test(t)) return "snow";
  if (/\b(desert|sand\w*|dunes?|africa|el alamein)\b/.test(t)) return "desert";
  if (/\b(city|urban|streets?|town|bombed|stalingrad|village)\b/.test(t)) return "urban";
  if (/\b(forest|woods?|jungle|pines?|trees?)\b/.test(t)) return "forest";
  return null;
}

/** Demo intake: regex extraction of the RFQ. */
export function intakeDeterministic({ request }) {
  const t = String(request || "");
  const lower = t.toLowerCase();
  const dims = t.match(/(\d{1,3}(?:\.\d+)?)\s*(?:cm)?\s*[x×*]\s*(\d{1,3}(?:\.\d+)?)\s*cm/i) || t.match(/(\d{1,3})\s*[x×]\s*(\d{1,3})/);
  const budget = t.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/) || t.match(/budget[^\d]{0,12}(\d[\d,]*)/i);
  const features = [];
  if (/river|water|lake|stream|resin|canal|pond/.test(lower)) features.push(/river/.test(lower) ? "resin river" : "resin water");
  if (/led|light|explosion|fire|lantern|glow/.test(lower)) features.push(/explosion|fire/.test(lower) ? "LED explosions" : "LED lighting");
  if (/weather|rust|mud/.test(lower)) features.push("weathering");
  const before = (t.match(/^(.*?)\bdiorama/i) || [])[1] || t.split(/[,.;]/)[0];
  const theme = before.replace(/\b(please|commission|build|make|create|design|order|quote|i want|i'd like|get me|need)\b/gi, " ").replace(/\b(an?|the|me|for|at)\b/gi, " ").replace(/1\s*[:/]\s*\d+/g, " ").replace(/[,.:;]+/g, " ").replace(/\s+/g, " ").trim();
  return {
    scale: normalizeScale(t),
    theme: theme || "Custom diorama",
    terrain_hint: terrainOf(t),
    dimensions_cm: dims ? { width: Number(dims[1]), depth: Number(dims[2]) } : { width: 30, depth: 30 },
    features,
    max_budget: budget ? Number(budget[1].replace(/,/g, "")) : null,
    currency: "USD",
    notes: "",
  };
}

/** Repair whatever the intake model returned, using the regex reading of the request as the safety net. */
export function normalizeRfq(out, input) {
  const fb = intakeDeterministic(input);
  const o = isObj(out) ? out : {};
  const w = num(o.dimensions_cm?.width ?? o.width), d = num(o.dimensions_cm?.depth ?? o.depth);
  const budget = num(o.max_budget);
  return {
    scale: normalizeScale(o.scale) || fb.scale,
    theme: String(o.theme || fb.theme).slice(0, 80),
    terrain_hint: TERRAINS.includes(o.terrain_hint) ? o.terrain_hint : terrainOf(o.theme) || fb.terrain_hint,
    dimensions_cm: { width: w && w >= 5 && w <= 200 ? w : fb.dimensions_cm.width, depth: d && d >= 5 && d <= 200 ? d : fb.dimensions_cm.depth },
    features: (Array.isArray(o.features) ? o.features.map((f) => String(f).slice(0, 40)) : fb.features).slice(0, 8),
    max_budget: budget && budget > 0 ? budget : fb.max_budget, // the request's own number wins if the model drops it
    currency: "USD",
    notes: String(o.notes || "").slice(0, 200),
  };
}

const shopName = (s) => String(s.name || s.url).split(" — ")[0];

/** Demo discovery: shortlist every supplier that builds the RFQ's scale (all of them if none match), max 4. */
export function discoveryDeterministic({ rfq, suppliers }) {
  const fit = suppliers.filter((s) => !rfq.scale || (s.scales || []).includes(rfq.scale));
  const list = (fit.length ? fit : suppliers).slice(0, 4);
  return { shortlist: list.map((s) => s.url), reason: list.length ? `${list.map(shopName).join(" and ")} publish diorama.quote${rfq.scale && fit.length ? ` and build ${rfq.scale}` : ""}; asking ${list.length > 1 ? "each" : "it"} for a quote.` : "No supplier available." };
}

/** Keep only shortlisted URLs that are real suppliers; fall back to the deterministic shortlist. */
export function normalizeShortlist(out, input) {
  const known = new Set(input.suppliers.map((s) => s.url));
  const list = [...new Set((Array.isArray(out?.shortlist) ? out.shortlist : [out?.supplier_url]).filter((u) => known.has(u)))].slice(0, 4);
  if (!list.length) return { ...discoveryDeterministic(input), reason: "Model shortlisted no known supplier; asking every matching one." };
  return { shortlist: list, reason: String(out?.reason || "").slice(0, 300) };
}

/**
 * Rank comparison quotes for the "Let the agent pick" option and the badges:
 * quotes within budget first, then the lowest price, then the shortest lead time.
 */
export function rankQuotes(quotes, budget) {
  const inBudget = (q) => (budget == null || q.price <= budget ? 0 : 1);
  return [...quotes].sort((a, b) => inBudget(a) - inBudget(b) || a.price - b.price || a.lead_time_days - b.lead_time_days);
}
export function quoteBadges(q, quotes, budget) {
  const tags = [];
  if (quotes.length > 1 && q.price === Math.min(...quotes.map((x) => x.price))) tags.push("Lowest price");
  if (quotes.length > 1 && q.lead_time_days === Math.min(...quotes.map((x) => x.lead_time_days))) tags.push("Fastest");
  if (budget != null) tags.push(q.price <= budget ? "Within budget" : `Over budget by $${Math.round(q.price - budget)}`);
  return tags;
}

/** Demo negotiator: open about 14% under the quote (never above budget), then move to the budget. */
export function negotiatorDeterministic({ rfq, quote, round }) {
  const budget = rfq.max_budget;
  if (budget == null || quote.price <= budget) return { action: "accept", counter_price: null, message: "That works for us." };
  if (quote.final) return { action: "walk_away", counter_price: null, message: `Thanks, but ${quote.price} is above our budget.` };
  const counter = round === 1 ? Math.min(budget, round5(quote.price * 0.86)) : budget;
  return { action: "counter", counter_price: counter, message: round === 1 ? "Could you work with this number?" : `${counter} is the most we can spend.` };
}

/**
 * Buyer policy on any negotiator proposal:
 *  - no budget, or price within budget -> accept
 *  - never accept above budget (converted to a counter at the budget)
 *  - counters stay between 60% of the current price and min(budget, price - 1); a missing counter means the budget
 *  - a final offer above budget, or too many rounds -> walk away
 */
export function enforceBuyerPolicy(out, { price, budget, final, round }) {
  if (budget == null || price <= budget) return { action: "accept", counter_price: null, message: out?.message || "Accepted.", policy: out?.action && out.action !== "accept" ? "Price is within budget; accepting." : null };
  if (final || round > MAX_ROUNDS) return { action: "walk_away", counter_price: null, message: out?.message || "Above budget.", policy: out?.action !== "walk_away" ? `Final offer ${price} is above the budget ${budget}; walking away.` : null };
  if (out?.action === "walk_away") return { action: "walk_away", counter_price: null, message: out.message || "", policy: null };
  const raw = out?.counter_price;
  let c = raw === null || raw === undefined || raw === "" ? NaN : Number(raw); // Number(null) would be 0
  let policy = null;
  if (out?.action === "accept") { c = budget; policy = `Negotiator tried to accept ${price}, above the budget ${budget}; countering at the budget instead.`; }
  if (!Number.isFinite(c) || c <= 0) { c = budget; policy = policy || "No counter price given; using the budget."; }
  const hi = Math.min(budget, price - 1);
  const lo = Math.min(hi, Math.round(price * 0.6)); // no insulting lowballs
  const clamped = Math.round(Math.min(hi, Math.max(lo, c)));
  if (clamped !== Math.round(c) && !policy) policy = `Counter ${Math.round(c)} adjusted to ${clamped} (within budget and below the current price).`;
  return { action: "counter", counter_price: clamped, message: String(out?.message || "").slice(0, 300), policy };
}
