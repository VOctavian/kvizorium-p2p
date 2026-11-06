// Proxy for the SIBrowser pack library (https://www.sibrowser.ru) — the serverless version's pack search.
// SIBrowser can't be read from a browser on another site, so the game asks this worker instead.
// It forwards only SIBrowser's search pages and pack downloads, nothing else.
//
// Cloudflare: Workers & Pages → Create → Worker → paste this file → Deploy. Then put the worker's
// address (https://NAME.SUBDOMAIN.workers.dev) into the repository variable VITE_SIB_PROXY.

const SITE = "https://www.sibrowser.ru";
const PATH = /^\/(packages(\/\d+\/direct_download)?|tags\/[^/]+|categories\/[a-z_]+|authors\/[^/]+)?$/;
// Only the game's own site may use it (add yours; empty = anyone).
const ALLOWED = ["https://voctavian.github.io", "http://localhost:5173", "http://localhost:5174"];

export default {
  async fetch(req) {
    const origin = req.headers.get("Origin") ?? "";
    const allow = !ALLOWED.length || ALLOWED.includes(origin) ? origin || "*" : "";
    const cors = { "Access-Control-Allow-Origin": allow, "Access-Control-Expose-Headers": "Content-Length", Vary: "Origin" };
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    if (!allow) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    if (req.method !== "GET" || !PATH.test(url.pathname)) return new Response("not found", { status: 404, headers: cors });
    const res = await fetch(SITE + url.pathname + url.search, { headers: { "User-Agent": "Kvizorium (pack search)" }, redirect: "follow" });
    const headers = new Headers(cors);
    headers.set("Content-Type", res.headers.get("Content-Type") ?? "application/octet-stream");
    const len = res.headers.get("Content-Length");
    if (len && !res.headers.get("Content-Encoding")) headers.set("Content-Length", len);
    headers.set("Cache-Control", url.pathname.endsWith("direct_download") ? "no-store" : "public, max-age=120");
    return new Response(res.body, { status: res.status, headers });
  },
};
