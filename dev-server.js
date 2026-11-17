#!/usr/bin/env node
/**
 * Zero-dependency dev server for the two interconnected agentic sites.
 *   http://localhost:62260 -> buyer-hub/       (OpenAgentic Procurement & Commission Hub)
 *   http://localhost:62261 -> diorama-studio/  (Miniature Worlds 3D Diorama Studio)
 *   http://localhost:62262 -> frostbite-studio/ over diorama-studio/ (Frostbite Miniatures: same code, own profile)
 * Both serve /shared/* from shared/, alias /.well-known/agent-manifest.json to /agent-manifest.json,
 * and send Access-Control-Allow-Origin: * so the sites can fetch each other's public artifacts.
 * Env: HUB_PORT, STUDIO_PORT, FROSTBITE_PORT, HOST (default 127.0.0.1).
 */
import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const HOST = process.env.HOST || "127.0.0.1";
const SITES = [
  { name: "Buyer Hub", dir: "buyer-hub", port: Number(process.env.HUB_PORT || 62260) },
  { name: "3D Diorama Studio", dir: "diorama-studio", port: Number(process.env.STUDIO_PORT || 62261) },
  { name: "Frostbite Miniatures", dir: "frostbite-studio", base: "diorama-studio", port: Number(process.env.FROSTBITE_PORT || 62262) },
];
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
};
const BASE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** Map a URL path to a file inside the allowed roots, or null. Blocks traversal and dotfiles. */
function resolveFile(site, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split("?")[0]); } catch { return null; }
  if (p === "/.well-known/agent-manifest.json") p = "/agent-manifest.json";
  if (p.endsWith("/")) p += "index.html";
  const shared = p.startsWith("/shared/");
  const rel = shared ? p.slice("/shared/".length) : p.slice(1);
  if (rel.split("/").some((seg) => seg.startsWith(".") || seg === "")) return null;
  // An overlay site (site.base) serves its own files first, then the base site's.
  const roots = shared ? [join(ROOT, "shared")] : [join(ROOT, site.dir), ...(site.base ? [join(ROOT, site.base)] : [])];
  for (const base of roots) {
    const file = normalize(join(base, rel));
    if (!file.startsWith(base + sep)) return null;
    try { if (statSync(file).isFile()) return file; } catch { /* try the next root */ }
  }
  return null;
}

function handler(site) {
  return (req, res) => {
    const t0 = Date.now();
    const done = (status) => process.env.QUIET || console.log(`${site.port} ${req.method} ${req.url} ${status} ${Date.now() - t0}ms`);
    if (req.method === "OPTIONS") { res.writeHead(204, BASE_HEADERS); res.end(); return done(204); }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { ...BASE_HEADERS, Allow: "GET, HEAD, OPTIONS" }); res.end(); return done(405); }
    const file = resolveFile(site, req.url || "/");
    if (!file) {
      res.writeHead(404, { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return done(404);
    }
    const { size } = statSync(file);
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": MIME[extname(file)] || "application/octet-stream", "Content-Length": size });
    if (req.method === "HEAD") { res.end(); return done(200); }
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
    done(200);
  };
}

for (const site of SITES) {
  const server = http.createServer(handler(site));
  server.on("error", (e) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${site.port} is already in use (${site.name}). Stop that process or set ${{ "buyer-hub": "HUB_PORT", "diorama-studio": "STUDIO_PORT", "frostbite-studio": "FROSTBITE_PORT" }[site.dir]}.` : e.message);
    process.exit(1);
  });
  server.listen(site.port, HOST, () => console.log(`${site.name.padEnd(18)} http://localhost:${site.port}/   (${site.dir}/)`));
}
