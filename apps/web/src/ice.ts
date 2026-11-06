/**
 * Servers that help two browsers connect. STUN tells a browser its public address; TURN carries
 * the traffic when no direct way works (strict NATs, some mobile networks), so then the game,
 * pictures, sound and video all still go through.
 *
 * TURN comes from the build setting VITE_TURN: either a JSON list of RTCIceServer, or a link that
 * returns one (e.g. Metered's "credentials" link with its API key). localStorage "kvz.turn" takes
 * its place, for trying a server out. Without either, only STUN (and the spare route over the relays).
 */
export const ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }];

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const CACHE = "kvz.turn.cache";
/** A fetched list is kept this long, so the link isn't asked on every visit. */
const CACHE_MS = 6 * 3600_000;
const FETCH_MS = 4000;

const setting = () => {
  try { return localStorage.getItem("kvz.turn") || env.VITE_TURN || ""; } catch { return env.VITE_TURN || ""; }
};

function valid(list: unknown): RTCIceServer[] {
  const arr = Array.isArray(list) ? list : Array.isArray((list as { iceServers?: unknown })?.iceServers) ? (list as { iceServers: unknown[] }).iceServers : [];
  return arr.filter((s): s is RTCIceServer => {
    const urls = (s as RTCIceServer)?.urls;
    const all = Array.isArray(urls) ? urls : [urls];
    return all.length > 0 && all.every((u) => typeof u === "string" && /^(stun|turns?):/.test(u));
  });
}

async function fetchList(url: string): Promise<RTCIceServer[]> {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE) ?? "null") as { url: string; at: number; list: unknown } | null;
    if (c && c.url === url && Date.now() - c.at < CACHE_MS) return valid(c.list);
  } catch { /* no cache */ }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const list = valid(await res.json());
    if (list.length) try { localStorage.setItem(CACHE, JSON.stringify({ url, at: Date.now(), list })); } catch { /* full */ }
    return list;
  } catch { return []; } finally { clearTimeout(t); }
}

let loading: Promise<void> | undefined;
/** Adds the TURN servers (once). The list is changed in place: connections made after this use them. */
export function loadTurn(): Promise<void> {
  return (loading ??= (async () => {
    const s = setting().trim();
    if (!s) return;
    let list: RTCIceServer[] = [];
    if (s.startsWith("http")) list = await fetchList(s);
    else { try { list = valid(JSON.parse(s)); } catch { list = []; } }
    for (const server of list) if (!ICE.some((x) => JSON.stringify(x.urls) === JSON.stringify(server.urls))) ICE.push(server);
  })());
}

/** Whether a TURN server is in use. */
export const hasTurn = () => ICE.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => u.startsWith("turn")));
