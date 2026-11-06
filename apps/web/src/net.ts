import { tr } from "./i18n.ts";
import { preloadRound, stopPreload } from "./preload.ts";
import { onHave, onRtc, onSwarm, preparePack, setupShare, ShareError, stopShare } from "./share.ts";
import { useSyncExternalStore } from "react";
import type { LobbyStats, ChatItem, ClientMsg, Gender, RoomSummary, RoomView, ServerMsg } from "@kvz/protocol";

declare global {
  interface Window {
    kvz?: { desktop: true; serverUrl?: string; steamName?: string; toggleFullscreen?: () => void };
  }
}

export interface Profile { name: string; avatar?: string; gender?: Gender }

export interface State {
  status: "idle" | "connecting" | "open" | "closed";
  me?: { id: string; name: string; avatar?: string };
  demoPacks: { id: string; name: string }[];
  rooms: RoomSummary[];
  /** Games page: top packs and latest games. */
  stats?: LobbyStats;
  room?: RoomView;
  chat: ChatItem[];
  /** serverTime - localTime, ms */
  offset: number;
  toast?: { text: string; at: number; tone?: "bad" | "info" };
  /** Pack upload in progress from this client. */
  upload?: { name: string; progress: number };
}

/** A pack chosen in the "new game" dialog, sent as soon as the room exists. */
let pendingPack: { file?: File; demoId?: string } | null = null;
export function setPendingPack(p: { file?: File; demoId?: string } | null) { pendingPack = p; }

/**
 * The leader's browser unpacks and encrypts the pack, then shares it: the server gets only the
 * questions and the file list, the media go from this browser to the others directly.
 */
export async function sendPack(_roomId: string, file: File) {
  set({ upload: { name: file.name, progress: 0 } });
  try {
    const { xml, files } = await preparePack(file, (progress) => set({ upload: { name: file.name, progress } }));
    send({ t: "sharePack", xml, files });
  } catch (e) {
    const t = tr();
    toast(e instanceof ShareError ? (e.code === "tooBig" ? t.packTooBig : t.packTextTooBig) : `${t.packFailed}: ${(e as Error).message}`);
  } finally {
    set({ upload: undefined });
  }
}

function flushPendingPack(room: RoomView) {
  if (!pendingPack || room.ownerId !== state.me?.id || room.phase !== "lobby") return;
  const p = pendingPack;
  pendingPack = null;
  if (p.demoId) send({ t: "useDemoPack", id: p.demoId });
  else if (p.file) void sendPack(room.id, p.file);
}

const LS = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage full or blocked */ } },
};

function token(): string {
  let t = LS.get("kvz.token");
  if (!t || t.length < 16) {
    t = crypto.randomUUID() + crypto.randomUUID();
    LS.set("kvz.token", t);
  }
  return t;
}

export function serverBase(): string {
  return (LS.get("kvz.server") || window.kvz?.serverUrl || location.origin).replace(/\/+$/, "");
}
export function setServerBase(url: string | null) { LS.set("kvz.server", url); }
export const abs = (url?: string) => (url && url.startsWith("/") ? serverBase() + url : url);

export function loadProfile(): Profile | null {
  const name = LS.get("kvz.name");
  const g = LS.get("kvz.gender");
  return name ? { name, avatar: LS.get("kvz.avatar") ?? undefined, gender: g === "m" || g === "f" ? g : undefined } : null;
}
export function saveProfile(p: Profile) {
  LS.set("kvz.name", p.name);
  LS.set("kvz.avatar", p.avatar ?? null);
  LS.set("kvz.gender", p.gender ?? null);
}

let state: State = { status: "idle", demoPacks: [], rooms: [], chat: [], offset: 0 };
const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => (listeners.add(l), () => { listeners.delete(l); });
const whole = (s: State) => s;
/**
 * Subscribe to a slice of the state. The selector must return something that already lives in
 * the state (not a fresh object), so components re-render only when that slice changes.
 */
export function useStore(): State;
export function useStore<T>(select: (s: State) => T): T;
export function useStore<T>(select: (s: State) => T = whole as (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}
export const getState = () => state;

/**
 * Structural sharing: parts of the new snapshot that are deep-equal to the previous one keep
 * their old object identity, so memoized components skip re-rendering.
 */
function share<T>(prev: unknown, next: T): T {
  if (prev === next) return next;
  if (typeof prev !== "object" || typeof next !== "object" || !prev || !next) return next;
  if (Array.isArray(prev) !== Array.isArray(next)) return next;
  if (Array.isArray(next)) {
    const p = prev as unknown[];
    let same = p.length === next.length;
    const out = next.map((v, i) => { const s = share(p[i], v); if (s !== p[i]) same = false; return s; });
    return (same ? prev : out) as T;
  }
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const keys = Object.keys(n);
  let same = keys.length === Object.keys(p).length;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = share(p[k], n[k]);
    if (out[k] !== p[k]) same = false;
  }
  return (same ? prev : out) as T;
}

let ws: WebSocket | undefined;
let retry = 0;
let wanted = false;

/**
 * Peer mode (the GitHub Pages build): no game server, the rooms live in the players' browsers.
 * See p2p.ts.
 */
export const PEER_MODE = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_P2P === "1";
let peer: typeof import("./p2p.ts") | undefined;

function peerId(): string {
  let id = LS.get("kvz.p2p.id");
  if (!id || !/^[0-9a-f]{12}$/.test(id)) {
    id = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
    LS.set("kvz.p2p.id", id);
  }
  return id;
}

/** A built-in pack in peer mode: the leader's browser fetches it from the site and shares it. */
async function useDemoPack(id: string) {
  const room = state.room;
  if (!room) return;
  try {
    const res = await fetch(`packs/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(String(res.status));
    await sendPack(room.id, new File([await res.blob()], id));
  } catch (e) {
    toast(`${tr().packFailed}: ${(e as Error).message}`);
  }
}

/** Sends without complaining; false when there is no connection. */
function rawSend(m: ClientMsg): boolean {
  if (preview) return true;
  if (PEER_MODE) { peer?.send(m); return !!peer; }
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(m));
  return true;
}

export function connect() {
  wanted = true;
  const profile = loadProfile();
  if (!profile) return;
  if (PEER_MODE) {
    if (peer) return;
    set({ status: "connecting" });
    void import("./p2p.ts").then((mod) => {
      peer = mod;
      mod.start({ id: peerId(), name: profile.name, gender: profile.gender, deliver: onMessage, onDemoPack: (id) => void useDemoPack(id) });
      set({ status: "open" });
    });
    return;
  }
  ws?.close();
  set({ status: "connecting" });
  const url = serverBase().replace(/^http/, "ws") + "/ws";
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    set({ status: "open" });
    sock.send(JSON.stringify({ t: "hello", token: token(), name: profile.name, avatar: profile.avatar, gender: profile.gender } satisfies ClientMsg));
  };
  sock.onmessage = (e) => onMessage(JSON.parse(e.data) as ServerMsg);
  sock.onclose = (e) => {
    if (ws !== sock) return;
    set({ status: "closed" });
    if (e.code === 4001) { toast(tr().otherDevice); return; }
    if (wanted) setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
  };
}

function onMessage(m: ServerMsg) {
  switch (m.t) {
    case "welcome": return set({ me: m.you, demoPacks: m.demoPacks });
    case "rooms": return set({ rooms: share(state.rooms, m.rooms) });
    case "stats": return set({ stats: m.stats });
    case "room": {
      const { serverNow, ...rest } = m.room;
      // serverNow changes every message; keep it out of the shared tree so unchanged rooms stay identical.
      const room = share(state.room, { ...rest, serverNow: 0 });
      const offset = serverNow - Date.now();
      set({ room, offset: Math.abs(offset - state.offset) > 150 ? offset : state.offset });
      return flushPendingPack(room);
    }
    case "preload":
      return preloadRound(m.round, m.urls, !!m.next, (u) => abs(u)!, (round) => { rawSend({ t: "preloaded", round }); });
    case "swarm": return void onSwarm(m);
    case "have": return onHave(m.from, m.files, m.reset);
    case "rtc": return void onRtc(m.from, m.data as Parameters<typeof onRtc>[1]);
    case "left":
      stopPreload();
      stopShare();
      set({ room: undefined, chat: [] });
      if (m.reason) toast(m.text ? tr().tx(m.text) : m.reason);
      return;
    case "chat": {
      if (m.reset) return set({ chat: m.items });
      // An item with a known id is an update (e.g. the host corrected a score).
      const byId = new Map(m.items.map((i) => [i.id, i]));
      const updated = state.chat.map((c) => byId.get(c.id) ?? c);
      const fresh = m.items.filter((i) => !state.chat.some((c) => c.id === i.id));
      return set({ chat: [...updated, ...fresh].slice(-300) });
    }
    case "error":
      pendingPack = null;
      return toast(m.text ? tr().tx(m.text) : m.message);
  }
}

/** Showcase mode: a made-up room is shown and nothing is sent anywhere. */
let preview = false;
export function enterPreview(room: RoomView, chat: ChatItem[]) {
  preview = true;
  wanted = false;
  ws?.close();
  set({ room, chat, me: { id: room.me.id, name: "Вы" }, offset: 0, status: "open" });
}

export function send(m: ClientMsg) {
  if (!rawSend(m)) toast(tr().noConnection);
}

export function toast(text: string, tone: "bad" | "info" = "bad") { set({ toast: { text, at: Date.now(), tone } }); }


setupShare({
  send: (m) => { rawSend(m); },
  me: () => state.me?.id,
});
