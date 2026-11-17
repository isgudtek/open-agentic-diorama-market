#!/usr/bin/env node
/**
 * Static build: copies buyer-hub/, diorama-studio/ and frostbite-studio/ (an overlay on diorama-studio/), each with its
 * own copy of shared/, into one output folder
 * and rewrites the localhost URLs in the manifests for the deployment base URL.
 *
 *   node scripts/build-sites.mjs                                   -> dist/, localhost URLs kept
 *   node scripts/build-sites.mjs --base https://isgudtek.github.io/open-agentic-diorama-market/ --out docs
 *
 * Output: <out>/index.html (landing), <out>/buyer-hub/, <out>/diorama-studio/, <out>/frostbite-studio/, each with .well-known/agent-manifest.json,
 * plus <out>/.nojekyll so GitHub Pages publishes the .well-known folders.
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const out = resolve(ROOT, arg("out", "dist"));
const baseArg = arg("base", null);
const base = baseArg ? new URL(baseArg.endsWith("/") ? baseArg : `${baseArg}/`) : null;

if (!out.startsWith(ROOT) || out === ROOT) throw new Error(`Refusing to write outside the project: ${out}`);
const HUB_URL = base ? new URL("buyer-hub/", base).href : "http://localhost:62260/";
const STUDIO_URL = base ? new URL("diorama-studio/", base).href : "http://localhost:62261/";
const FROST_URL = base ? new URL("frostbite-studio/", base).href : "http://localhost:62262/";
const SUPPLIERS = [STUDIO_URL, FROST_URL].map((u) => u.replace(/\/$/, "")); // registry entries (no trailing slash)
const LOCAL = { "http://localhost:62261/": STUDIO_URL, "http://localhost:62262/": FROST_URL };
const SITES = [
  { dir: "buyer-hub", url: HUB_URL },
  { dir: "diorama-studio", url: STUDIO_URL },
  { dir: "frostbite-studio", base: "diorama-studio", url: FROST_URL },
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);

for (const site of SITES) {
  const dest = join(out, site.dir);
  if (site.base) cpSync(join(ROOT, site.base), dest, { recursive: true }); // shared studio code first
  cpSync(join(ROOT, site.dir), dest, { recursive: true }); // then the shop's own files on top
  cpSync(join(ROOT, "shared"), join(dest, "shared"), { recursive: true });
  const mPath = join(dest, "agent-manifest.json");
  const m = readJson(mPath);
  m.endpoint = site.url;
  if (site.dir === "buyer-hub") {
    m.peers.suppliers = SUPPLIERS;
    const nPath = join(dest, m.networks[0].hocon);
    const n = readJson(nPath);
    for (const a of n.tools) a.tools = (a.tools || []).map((t) => { const k = typeof t === "string" && Object.keys(LOCAL).find((l) => t.startsWith(l)); return k ? LOCAL[k] + t.slice(k.length) : t; });
    writeJson(nPath, n);
  } else {
    m.rpc.trusted_origins = [new URL(HUB_URL).origin];
    // An overlay shop inherits the base studio's network file; keep only the one its manifest names.
    if (site.base && m.networks[0].hocon !== "diorama_studio.network.json") rmSync(join(dest, "diorama_studio.network.json"), { force: true });
  }
  writeJson(mPath, m);
  mkdirSync(join(dest, ".well-known"), { recursive: true });
  writeJson(join(dest, ".well-known", "agent-manifest.json"), m);
}

writeFileSync(join(out, ".nojekyll"), "");

/*
 * Cache busting. GitHub Pages serves everything with Cache-Control: max-age=600, so a browser can keep old modules
 * for 10 minutes after a deploy. Every local .js/.css reference gets ?v=<content hash>; all imports of one module use
 * the same URL, so each module still loads once. The hash also goes into <meta name="oaw-build"> for the UI.
 */
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
for (const site of SITES) walk(join(out, site.dir));
const build = createHash("sha256").update(files.sort().map((f) => readFileSync(f)).join("\u0000")).digest("hex").slice(0, 10);
const stampJs = (src) => src.replace(/((?:from|import)\s*\(?\s*)"(\.{1,2}\/[^"?]+\.js)"/g, `$1"$2?v=${build}"`);
for (const f of files) {
  if (f.endsWith(".js")) writeFileSync(f, stampJs(readFileSync(f, "utf8")));
  if (f.endsWith("index.html")) {
    let html = readFileSync(f, "utf8")
      .replace(/(href|src)="((?!https?:|data:|\/\/)[^"?]+\.(?:css|js))"/g, `$1="$2?v=${build}"`)
      .replace("<meta charset=\"utf-8\">", `<meta charset="utf-8">\n  <meta name="oaw-build" content="${build}">`);
    writeFileSync(f, html);
  }
}
writeFileSync(join(out, "index.html"), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open Agentic Diorama Market: a buyer hub and two competing studios</title>
  <style>
    body { margin: 0; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; background: #12152a; color: #eef0ff; display: grid; place-items: center; min-height: 100vh; }
    main { max-width: 760px; padding: 32px; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    p { color: #b8bfe6; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-top: 22px; }
    a.card { display: block; padding: 18px; border-radius: 14px; text-decoration: none; color: inherit; border: 1px solid #343a66; background: #1b2042; }
    a.card:hover { border-color: #7f8cff; }
    a.card.studio { background: #3b2416; border-color: #6b4430; }
    a.card.frost { background: #1d2833; border-color: #3e5466; }
    strong { display: block; font-size: 18px; margin-bottom: 4px; }
    code { background: rgba(255,255,255,.08); padding: 1px 6px; border-radius: 5px; }
  </style>
</head>
<body>
  <main>
    <h1>Open Agentic Diorama Market</h1>
    <p>Three agentic websites that find each other through their published <code>agent-manifest.json</code> and negotiate in your browser over <code>window.postMessage</code>. Bring your own model with Mozilla Otari, run Gemini Nano on-device, or use Demo Mode with no key.</p>
    <div class="cards">
      <a class="card" href="buyer-hub/"><strong>OpenAgentic Procurement Hub</strong>Type a commission; agents write the RFQ, discover the studio, negotiate within your budget and ask you to approve the order.</a>
      <a class="card studio" href="diorama-studio/"><strong>Miniature Worlds</strong>Artisan studio: fast and premium. Live Three.js designer, quotes, a 12% negotiation floor and a commission board.</a>
      <a class="card frost" href="frostbite-studio/"><strong>Frostbite Miniatures</strong>Workshop for dense natural detail: cheaper, slower, an 8% floor. Same open runtime, its own agents and prices.</a>
    </div>
    <p>Start with the Hub and click <em>Run commission</em>: both studios design their own 3D diorama side by side, you compare the quotes, choose one, and the hub negotiates and asks you to approve the order.</p>
  </main>
</body>
</html>
`);

console.log(`Built ${out}  (build ${build})`);
console.log(`  Hub:    ${HUB_URL}`);
console.log(`  Studios: ${SUPPLIERS.join(" , ")}  (trust ${new URL(HUB_URL).origin})`);
if (!existsSync(join(out, "buyer-hub", "shared", "oaw-core.js"))) throw new Error("shared/ was not copied");
