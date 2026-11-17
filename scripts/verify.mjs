#!/usr/bin/env node
/**
 * Conformance check over HTTP for both sites (no dependencies).
 *   node scripts/verify.mjs                                    -> http://localhost:62260/ and :62261/
 *   node scripts/verify.mjs https://host/path/buyer-hub/ https://host/path/diorama-studio/
 * Checks: manifests are valid JSON with CORS *, .well-known alias, network definitions resolve,
 * conformance rules (shared/oaw-core.js validateManifest), and that the hub's registered supplier
 * publishes the capability the hub requires.
 */
import { validateManifest } from "../shared/oaw-core.js";

const [hubArg, studioArg] = process.argv.slice(2);
const sites = [
  { name: "Buyer Hub", url: hubArg || "http://localhost:62260/" },
  { name: "Diorama Studio", url: studioArg || "http://localhost:62261/" },
];
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`); if (!cond) failed++; return cond; };

async function get(url) {
  const res = await fetch(url, { headers: { Origin: "https://judge.example" } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, cors: res.headers.get("access-control-allow-origin"), type: res.headers.get("content-type") || "", json };
}

const loaded = {};
for (const s of sites) {
  console.log(`\n${s.name}  ${s.url}`);
  let m;
  try { m = await get(new URL("agent-manifest.json", s.url).href); } catch (e) { ok(false, `reachable (${e.message})`); continue; }
  ok(m.status === 200, `GET agent-manifest.json → ${m.status}`);
  ok(m.json !== null, "manifest is valid JSON");
  ok(m.cors === "*", `Access-Control-Allow-Origin: ${m.cors}`);
  const wk = await get(new URL(".well-known/agent-manifest.json", s.url).href);
  ok(wk.status === 200 && JSON.stringify(wk.json) === JSON.stringify(m.json), `.well-known/agent-manifest.json alias → ${wk.status}`);
  const net = m.json?.networks?.[0];
  let n = null;
  if (net) {
    n = await get(new URL(net.hocon, s.url).href);
    ok(n.status === 200 && n.json && n.cors === "*", `network ${net.hocon} → ${n.status}, CORS ${n.cors}`);
  }
  const page = await get(s.url);
  ok(page.status === 200 && page.type.includes("text/html"), `index.html → ${page.status}`);
  const core = await get(new URL("shared/oaw-core.js", s.url).href);
  ok(core.status === 200, `shared/oaw-core.js → ${core.status}`);
  for (const c of validateManifest(m.json, n?.json)) ok(c.ok, `${c.check}${c.detail ? ` (${c.detail})` : ""}`);
  loaded[s.name] = m.json;
}

console.log("\nCross-site");
const hub = loaded["Buyer Hub"], studio = loaded["Diorama Studio"];
if (hub && studio) {
  const supplier = hub.peers?.suppliers?.[0];
  ok(!!supplier, `hub registers a supplier: ${supplier}`);
  const sm = supplier ? await get(`${supplier.replace(/\/+$/, "")}/agent-manifest.json`) : null;
  ok(sm?.status === 200, "hub's supplier manifest is reachable");
  ok((sm?.json?.capabilities || []).includes(hub.peers.required_capability), `supplier publishes ${hub.peers.required_capability}`);
  const hubOrigin = new URL(sites[0].url).origin;
  ok((studio.rpc?.trusted_origins || []).includes(hubOrigin), `studio trusts the hub origin ${hubOrigin} for RPC`);
}
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
