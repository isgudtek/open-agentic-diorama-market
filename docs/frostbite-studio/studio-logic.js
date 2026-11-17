/**
 * studio-logic.js: Miniature Worlds business logic. Pure functions (no DOM), unit-testable in Node.
 * The model proposes; these functions decide what is valid, what it costs, and how far a price may move.
 */

export const SCALE_RULES = {
  "1:12": { detail: 1.6, min: 20, max: 60 },
  "1:35": { detail: 1.0, min: 20, max: 120 },
  "1:64": { detail: 0.85, min: 15, max: 100 },
  "1:72": { detail: 0.8, min: 15, max: 100 },
};
export const TERRAINS = ["desert", "urban", "forest", "snow"];
export const STRUCTURE_TYPES = ["trench", "sandbags", "ruin", "building", "tree", "rock", "tank", "wall"];
/**
 * Shop profile: each storefront (Miniature Worlds, Frostbite, ...) loads its shop.json and calls configureShop().
 * Pricing changes the quote; style changes what the deterministic designer builds.
 */
export const SHOP = { id: "miniature-worlds", labor_rate: 14, material_mult: 1, overhead: 0.08, lead_mult: 1, max_discount: 0.12, density: 1, layout: "classic" };
export function configureShop(cfg = {}) { Object.assign(SHOP, { id: cfg.id || SHOP.id }, cfg.pricing || {}, cfg.style || {}); return SHOP; }
export const MAX_ROUNDS = 3;

const MATERIAL = { trench: 8, sandbags: 3.2, ruin: 6.5, building: 11.5, tree: 2, rock: 1.3, tank: 15.5, wall: 4.5 };
const HOURS = { trench: 1.2, sandbags: 0.35, ruin: 0.8, building: 1.4, tree: 0.25, rock: 0.15, tank: 1.8, wall: 0.5 };
const TERRAIN_MULT = { desert: 1.0, urban: 1.25, forest: 1.15, snow: 1.1 };
const DEFAULT_SIZE = {
  trench: [18, 4, 1.4], sandbags: [6, 1.6, 1.4], ruin: [7, 2, 6], building: [7, 6, 8],
  tree: [3, 3, 7], rock: [2.4, 2, 1.6], tank: [7, 3.6, 3], wall: [10, 1, 3],
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 10) / 10;
const round5 = (v) => Math.round(v / 5) * 5;

export function normalizeScale(s) {
  const m = String(s ?? "").match(/1\s*[:/]\s*(\d{1,3})/);
  return m ? `1:${Number(m[1])}` : null;
}

/** Seeded RNG so the same brief gives the same diorama. */
export function rng(seedText) {
  let h = 2166136261;
  for (const ch of String(seedText)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Pull what the studio needs out of free text (used by Demo Mode and as a safety net). */
export function parseBrief(text) {
  const t = String(text || "");
  const lower = t.toLowerCase();
  const dims = t.match(/(\d{1,3}(?:\.\d+)?)\s*(?:cm)?\s*[x×*]\s*(\d{1,3}(?:\.\d+)?)\s*cm/i) || t.match(/(\d{1,3})\s*[x×]\s*(\d{1,3})/);
  const budget = t.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/) || t.match(/budget[^\d]{0,12}(\d[\d,]*)/i);
  const terrain = /\b(snow\w*|winter|ice|icy|arctic|frozen)\b/.test(lower) ? "snow" : /\b(desert|sand\w*|dunes?|africa|el alamein)\b/.test(lower) ? "desert"
    : /\b(city|urban|streets?|town|bombed|stalingrad|village)\b/.test(lower) ? "urban" : /\b(forest|woods?|jungle|pines?|trees?)\b/.test(lower) ? "forest" : null;
  const features = [];
  if (/river|water|lake|stream|resin|canal|pond/.test(lower)) features.push(/river/.test(lower) ? "resin river" : "resin water");
  if (/led|light|explosion|fire|lantern|glow/.test(lower)) features.push(/explosion|fire/.test(lower) ? "LED explosions" : "LED lighting");
  if (/weather|rust|mud/.test(lower)) features.push("weathering");
  // Theme = the words before "diorama" without verbs, articles or the scale: "Commission a 1:35 WWII Desert Trench diorama" -> "WWII Desert Trench".
  const before = (t.match(/^(.*?)\bdiorama/i) || [])[1] || "";
  const theme = before.replace(/\b(please|commission|build|make|create|design|order|quote|i want|i'd like|get me)\b/gi, " ").replace(/\b(an?|the|me|for|at)\b/gi, " ").replace(/1\s*[:/]\s*\d+/g, " ").replace(/[,.:;]+/g, " ").replace(/\s+/g, " ").trim();
  return {
    scale: normalizeScale(t),
    theme: theme || t.replace(/1\s*[:/]\s*\d+|\d+\s*[x×]\s*\d+\s*cm|\bat\b/gi, " ").split(/[,.;]/)[0].replace(/\s+/g, " ").trim().slice(0, 60),
    terrain_hint: terrain,
    dimensions_cm: dims ? { width: Number(dims[1]), depth: Number(dims[2]) } : null,
    features,
    max_budget: budget ? Number(budget[1].replace(/,/g, "")) : null,
  };
}

function briefOf(input) {
  if (isObj(input?.rfq)) {
    const r = input.rfq;
    return {
      text: [r.theme, r.terrain_hint, ...(r.features || []), r.notes].filter(Boolean).join(" "),
      scale: normalizeScale(r.scale),
      terrain: TERRAINS.includes(r.terrain_hint) ? r.terrain_hint : parseBrief(r.theme).terrain_hint,
      width: num(r.dimensions_cm?.width, null), depth: num(r.dimensions_cm?.depth, null),
      features: Array.isArray(r.features) ? r.features.map(String) : [],
      title: r.theme,
    };
  }
  const p = parseBrief(input?.brief);
  return { text: String(input?.brief || ""), scale: p.scale, terrain: p.terrain_hint, width: p.dimensions_cm?.width ?? null, depth: p.dimensions_cm?.depth ?? null, features: p.features, title: p.theme };
}

const wantsWater = (b) => /river|water|lake|stream|resin|canal|pond/i.test(`${b.text} ${b.features.join(" ")}`);
const wantsLeds = (b) => /led|light|explosion|fire|lantern|glow/i.test(`${b.text} ${b.features.join(" ")}`);
const titleCase = (s) => String(s || "").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 80);

/** Deterministic designer: a themed layout from a brief or RFQ (Demo Mode, and fallback parts for normalization). */
export function designDeterministic(input) {
  const b = briefOf(input);
  const w = clamp(num(b.width, 30), 10, 120), d = clamp(num(b.depth, 30), 10, 120);
  const terrain = b.terrain || "desert";
  const R = rng(`${SHOP.id}|${b.text}|${w}x${d}|${terrain}`);
  const n = (k) => Math.max(1, Math.round(k * SHOP.density)); // shop style: how busy a base is
  const wild = SHOP.layout === "wild"; // diagonal trenches, scattered rubble, a tree line at the back
  const t = b.text.toLowerCase();
  const war = /ww|war|trench|front|battle|tank|bunker|soldier/.test(t);
  const s = [];
  const put = (type, x, z, extra = {}) => { const [sw, sd, sh] = DEFAULT_SIZE[type]; s.push({ type, x: r1(x), z: r1(z), width: extra.width ?? sw, depth: extra.depth ?? sd, height: extra.height ?? sh, rotation: extra.rotation ?? Math.round((R() - 0.5) * 30) }); };
  const rx = (m = 0.8) => (R() - 0.5) * w * m, rz = (m = 0.8) => (R() - 0.5) * d * m;
  if (war || /trench/.test(t)) {
    const tz = -d * 0.12;
    put("trench", wild ? -w * 0.05 : 0, tz, { width: r1(w * (wild ? 0.7 : 0.62)), rotation: wild ? 18 : 0 });
    for (let i = 0; i < n(5); i++) put("sandbags", -w * 0.28 + i * (w * 0.56) / Math.max(1, n(5) - 1), tz - 3.2 + (wild ? (i - n(5) / 2) * 0.9 : 0), { rotation: wild ? 18 : 0 });
    if (/tank|armou?r|ww/.test(t)) put("tank", w * 0.2, d * 0.22, { rotation: -20 });
    put("ruin", -w * 0.3, d * 0.25);
  }
  if (terrain === "urban") { for (let i = 0; i < 3; i++) put("building", -w * 0.3 + i * w * 0.3, d * 0.3, { height: 6 + Math.round(R() * 6) }); put("ruin", rx(), rz(0.3)); put("wall", 0, -d * 0.32, { width: r1(w * 0.4), rotation: 0 }); }
  if (terrain === "forest") for (let i = 0; i < n(9); i++) put("tree", rx(0.85), rz(0.85), { height: 5 + Math.round(R() * 4) });
  if (terrain === "snow") { for (let i = 0; i < n(7); i++) put("tree", rx(0.85), rz(0.85), { height: 5 + Math.round(R() * 4) }); if (!war) put("building", w * 0.22, -d * 0.2, { height: 5 }); }
  if (terrain === "desert" && !war) { put("ruin", rx(0.5), rz(0.5)); put("wall", rx(0.5), rz(0.5)); }
  for (let i = 0; i < n(3); i++) put("rock", rx(0.85), rz(0.85), { rotation: Math.round(R() * 180) });
  if (wild && terrain !== "urban") for (let i = 0; i < 5; i++) put("tree", -w * 0.4 + i * w * 0.2, -d * 0.4, { height: 6 + Math.round(R() * 3) });
  if (wild && war) put("ruin", w * 0.3, -d * 0.28);

  const water = wantsWater(b);
  const water_path = water ? [[-w / 2, r1(d * 0.32)], [r1(-w * 0.1), r1(d * 0.12)], [r1(w * 0.12), r1(d * 0.02)], [w / 2, r1(-d * 0.3)]] : [];
  if (water) for (const st of s) if (distToPath(st.x, st.z, water_path) < 4) st.z = r1(clamp(st.z + 7, -d / 2 + 2, d / 2 - 2));

  const led_points = [];
  if (wantsLeds(b)) {
    const fire = /explosion|fire|battle|war/.test(`${t} ${b.features.join(" ")}`.toLowerCase());
    const colors = fire ? ["#ff6a00", "#ffb000", "#ff3b1f"] : terrain === "snow" ? ["#ffd27a"] : ["#fff2c4", "#ffd27a"];
    const anchors = s.filter((x) => ["trench", "ruin", "building", "tank"].includes(x.type));
    const n = fire ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const a = anchors[i % Math.max(1, anchors.length)];
      led_points.push({ x: r1(clamp((a?.x ?? rx()) + (R() - 0.5) * 6, -w / 2 + 1, w / 2 - 1)), y: r1(fire ? 2 + R() * 4 : 3 + R() * 3), z: r1(clamp((a?.z ?? rz()) + (R() - 0.5) * 6, -d / 2 + 1, d / 2 - 1)), color: colors[i % colors.length] });
    }
  }
  return { title: titleCase(b.title || `${terrain} diorama`), base_width: w, base_depth: d, terrain_type: terrain, water_feature: water, water_path, led_points, structures: s };
}

function distToPath(x, z, path) {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, az] = path[i], [bx, bz] = path[i + 1];
    const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1;
    const u = clamp(((x - ax) * dx + (z - az) * dz) / L, 0, 1);
    best = Math.min(best, Math.hypot(x - (ax + u * dx), z - (az + u * dz)));
  }
  return best;
}

const TYPE_ALIASES = { trenches: "trench", sandbag: "sandbags", bags: "sandbags", ruins: "ruin", rubble: "ruin", house: "building", houses: "building", cabin: "building", bunker: "building", trees: "tree", pine: "tree", rocks: "rock", boulder: "rock", vehicle: "tank", tanks: "tank", fence: "wall", walls: "wall" };

/**
 * Make any model-produced scene safe to render and price: known types only, everything inside the base,
 * sizes in range, counts capped, and the RFQ's dimensions and requested features respected.
 */
export function normalizeScene(raw, input = {}) {
  const fb = designDeterministic(input);
  const b = briefOf(input);
  const s = isObj(raw) ? raw : {};
  const w = b.width ? clamp(b.width, 10, 120) : clamp(num(s.base_width, fb.base_width), 10, 120);
  const d = b.depth ? clamp(b.depth, 10, 120) : clamp(num(s.base_depth, fb.base_depth), 10, 120);
  const terrain = TERRAINS.includes(s.terrain_type) ? s.terrain_type : fb.terrain_type;
  const inX = (v) => r1(clamp(num(v, 0), -w / 2 + 1, w / 2 - 1)), inZ = (v) => r1(clamp(num(v, 0), -d / 2 + 1, d / 2 - 1));
  let structures = (Array.isArray(s.structures) ? s.structures : []).map((x) => {
    if (!isObj(x)) return null;
    const type = STRUCTURE_TYPES.includes(x.type) ? x.type : TYPE_ALIASES[String(x.type || "").toLowerCase()];
    if (!type) return null;
    const [sw, sd, sh] = DEFAULT_SIZE[type];
    return { type, x: inX(x.x), z: inZ(x.z), width: r1(clamp(num(x.width, sw), 0.8, w * 0.9)), depth: r1(clamp(num(x.depth, sd), 0.8, d * 0.9)), height: r1(clamp(num(x.height, sh), 0.5, 20)), rotation: Math.round(num(x.rotation, 0)) % 360 };
  }).filter(Boolean).slice(0, 24);
  if (structures.length < 3) structures = fb.structures;
  let water = typeof s.water_feature === "boolean" ? s.water_feature : fb.water_feature;
  if (wantsWater(b)) water = true; // the buyer asked for it
  let water_path = Array.isArray(s.water_path) ? s.water_path.filter((p) => Array.isArray(p) && p.length >= 2 && p.every((v) => Number.isFinite(Number(v)))).map(([x, z]) => [r1(clamp(Number(x), -w / 2, w / 2)), r1(clamp(Number(z), -d / 2, d / 2))]).slice(0, 6) : [];
  if (water && water_path.length < 2) water_path = fb.water_path.length ? fb.water_path : [[-w / 2, 0], [w / 2, 0]];
  if (!water) water_path = [];
  let led_points = (Array.isArray(s.led_points) ? s.led_points : []).filter(isObj).map((p) => ({ x: inX(p.x), y: r1(clamp(num(p.y, 3), 0.5, 20)), z: inZ(p.z), color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color.toLowerCase() : "#ffb000" })).slice(0, 8);
  if (wantsLeds(b) && !led_points.length) led_points = fb.led_points;
  return { title: String(s.title || fb.title).slice(0, 80), base_width: w, base_depth: d, terrain_type: terrain, water_feature: water, water_path, led_points, structures };
}

/** Materials + labour. Returns { ok, price, breakdown, lead_time_days, scale } or { ok:false, reason }. */
export function estimate(scene, rfqScale) {
  const scale = normalizeScale(rfqScale) || "1:35";
  const rule = SCALE_RULES[scale];
  if (!rule) return { ok: false, scale, reason: `Scale ${scale} is not offered. Miniature Worlds builds 1:12, 1:35, 1:64 and 1:72.` };
  const w = scene.base_width, d = scene.base_depth;
  if (Math.min(w, d) < rule.min || Math.max(w, d) > rule.max) return { ok: false, scale, reason: `At ${scale} a base must be ${rule.min}-${rule.max} cm per side; ${w}×${d} cm is outside that.` };
  const area = w * d;
  const tm = TERRAIN_MULT[scene.terrain_type] || 1;
  const waterLen = pathLength(scene.water_path || []);
  const nLed = scene.led_points.length;
  const mat = {
    base_and_terrain: area * 0.039 * tm,
    structures: scene.structures.reduce((a, x) => a + MATERIAL[x.type] * (x.type === "trench" ? Math.max(1, x.width / 18) : 1), 0) * SHOP.material_mult,
    water: scene.water_feature ? 34 + waterLen * 0.4 : 0,
    leds: nLed ? nLed * 5 + 16 : 0,
  };
  const hrs = {
    base_and_terrain: 3 + (area / 400) * 1.2,
    structures: scene.structures.reduce((a, x) => a + HOURS[x.type], 0) * rule.detail,
    water: scene.water_feature ? 2 : 0,
    leds: nLed ? nLed * 0.3 + 0.8 : 0,
  };
  const materials = Object.values(mat).reduce((a, v) => a + v, 0);
  const labor_hours = Object.values(hrs).reduce((a, v) => a + v, 0);
  const labor = labor_hours * SHOP.labor_rate;
  const subtotal = materials + labor;
  const price = round5(subtotal * (1 + SHOP.overhead));
  return {
    ok: true, scale, price, currency: "USD",
    breakdown: { materials: Math.round(materials), labor_hours: r1(labor_hours), labor_rate: SHOP.labor_rate, labor: Math.round(labor), overhead_pct: Math.round(SHOP.overhead * 100), items: Object.fromEntries(Object.entries(mat).map(([k, v]) => [k, Math.round(v)])) },
    lead_time_days: Math.ceil((Math.ceil(labor_hours / 6) + 3) * SHOP.lead_mult),
  };
}
const pathLength = (p) => p.reduce((a, pt, i) => (i ? a + Math.hypot(pt[0] - p[i - 1][0], pt[1] - p[i - 1][1]) : a), 0);

export const floorPrice = (basePrice) => Math.ceil(basePrice * (1 - SHOP.max_discount));

/** Demo estimator decision. */
export function estimatorDeterministic(input) {
  if (input.mode !== "negotiate") return { decision: "quote", price: input.quote.price, message: `Quoted ${money(input.quote.price)}: about ${input.quote.breakdown.labor_hours} hours of bench work plus ${money(input.quote.breakdown.materials)} in materials. Ready in roughly ${input.quote.lead_time_days} days.` };
  const { counter_price: c, floor_price: f, quote } = input;
  if (c >= f) return { decision: "accept", price: c, message: `We can do ${money(c)}. Deal.` };
  const meet = Math.max(f, round5((c + quote.price) / 2));
  return { decision: "counter", price: meet, message: meet === f ? `${money(f)} is the lowest we can go for this build.` : `We can come down to ${money(meet)}.` };
}

/**
 * Enforce the studio's policy on whatever the estimator proposed.
 * Accept only at or above the floor; counter only between max(floor, counter) and the current price.
 */
export function enforceNegotiation(out, { counter, floor, current, round }) {
  const proposed = Number(out?.price);
  if (counter >= floor && (out?.decision === "accept" || counter >= current)) return { accepted: true, price: Math.max(counter, floor), final: true, policy: null };
  if (out?.decision === "accept" && counter < floor) {
    return { accepted: false, price: floor, final: true, policy: `Counter ${counter} is below the studio floor; offering the floor instead.` };
  }
  let price = Number.isFinite(proposed) ? Math.round(proposed) : floor;
  const lo = Math.max(floor, counter), hi = current;
  const clamped = clamp(price, lo, hi);
  const policy = clamped !== price ? `Estimator proposed ${price}; clamped to ${clamped} (floor and current offer).` : null;
  if (clamped <= counter) return { accepted: true, price: Math.max(counter, floor), final: true, policy };
  return { accepted: false, price: clamped, final: clamped === floor || round >= MAX_ROUNDS, policy };
}

export const money = (v) => `$${Math.round(Number(v)).toLocaleString("en-US")}`;
