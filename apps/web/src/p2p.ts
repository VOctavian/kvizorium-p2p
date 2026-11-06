/**
 * Peer mode: the game with no game server (for GitHub Pages).
 *
 * - Browsers find each other through public Nostr relays (Trystero) and talk over WebRTC.
 * - The list of rooms goes through the same relays as small messages (the "board"): each room's
 *   keeper announces its room every few seconds, and a newcomer asks everyone to announce now.
 *   No direct connection is needed to see the rooms.
 * - A room is kept by one member's browser (the keeper), which runs the same room logic as the
 *   server. It copies the room's state and pack to every member, so if its browser leaves, the next
 *   member takes over from the latest copy. A host who drops out simply comes back as a member.
 * - Every member also keeps the latest copy on disk: when everyone has left, whoever comes back
 *   first brings the room back.
 * - Two browsers that can't connect directly (strict NATs) talk through a third one: every message
 *   is an envelope addressed to a person, passed on by whoever is connected to both.
 * - Someone nobody can connect to at all plays through the relays themselves (the "spare route"):
 *   slower, and without the media files, but in the game.
 */
import { createEvent, joinRoom, subscribe as nostrSubscribe } from "trystero";
import { buildSharedPack, errorMsg, handleRoomMsg, Room, type Hub, type LoadedPack, type PackHooks, type RoomSnapshot, type User } from "@kvz/game";
import { gotPicture, onMissingPicture, smallPicture } from "./share.ts";
import { ICE, loadTurn } from "./ice.ts";
import { formatText, roomNameKey, text, type ClientMsg, type Gender, type RoomSummary, type ServerMsg, type SharedFile, type Text } from "@kvz/protocol";

type Mesh = ReturnType<typeof joinRoom>;
type Json = never;

const APP_ID = "kvizorium-p2p-2";
/**
 * Relays for finding each other. Trystero's own pick for an app id may include dead ones, and big
 * relays (damus) ban the burst of messages a connection takes, so: small relays from Trystero's
 * list that were checked to pass these messages, several, so one down or blocked doesn't cut anyone off.
 */
const RELAYS = ["wss://nos.lol", "wss://nostr.rblb.it", "wss://nostr.red5d.dev", "wss://relay.nostr.dev.br", "wss://relay.layer.systems", "wss://relay.nostrmap.net", "wss://relay.hackshed.dev"];
/** The room list is a few small messages a minute: big relays are fine for it too. */
const BOARD_RELAYS = ["wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom", "wss://nostr.rblb.it", "wss://relay.layer.systems"];
const MESH = { appId: APP_ID, rtcConfig: { iceServers: ICE }, relayConfig: { urls: RELAYS } };
/** The keeper says it's alive this often; silent for KEEPER_SILENT, it's replaced. */
const BEAT_MS = 2000;
const KEEPER_SILENT = 7000;
/**
 * How long a newcomer waits to get through to a room. Over the internet a first connection can
 * take a while; a room on the board is known to exist, so it's worth waiting longer for.
 */
const JOIN_WAIT = 15_000;
const JOIN_WAIT_LISTED = 35_000;
/** A room not announced for this long leaves the list. */
const LISTED_TTL = 35_000;
const ANNOUNCE_MS = 10_000;
/** Can't get through to the keeper this long: rejoin the room's mesh to retry the connections. */
const REJOIN_MS = 15_000;
/** A copy saved on disk can bring a room back for this long. */
const SAVED_TTL = 24 * 3600_000;
/**
 * The spare route through the relays. A member with no direct way to the keeper for FAR_AFTER says
 * "hi" over the relays every FAR_HI_MS, and the keeper answers; heard that way within FAR_TTL, a
 * person can be reached that way. Messages go in batches (FAR_BATCH_MS, at least FAR_GAP apart),
 * zipped, each event at most FAR_MAX characters.
 */
const FAR_AFTER = 5000;
const FAR_HI_MS = 3000;
const FAR_TTL = 12_000;
const FAR_BATCH_MS = 120;
const FAR_GAP = 300;
const FAR_MAX = 32_000;
/** Over the spare route, the room's full copy is asked for at most this often. */
const FAR_STATE_MS = 20_000;

/* ---------- who I am ---------- */

let me = { id: "", name: "", gender: undefined as Gender | undefined };
let deliver: (m: ServerMsg) => void = () => {};
let notify: (t: Text) => void = () => {};
let onDemoPack: (id: string) => void = () => {};
let onAvatars: () => void = () => {};
/** How this browser hears its room: fine, through the relays, or not at all for now. */
export type LinkState = "ok" | "far" | "lost";
let onLink: (s: LinkState) => void = () => {};
let demoPacks: { id: string; name: string }[] = [];

export function start(opts: {
  id: string; name: string; gender?: Gender; avatar?: string;
  deliver: (m: ServerMsg) => void; notify: (t: Text) => void; onDemoPack: (id: string) => void; onAvatars: () => void;
  onLink?: (s: LinkState) => void;
}) {
  me = { id: opts.id, name: opts.name, gender: opts.gender };
  deliver = opts.deliver;
  notify = opts.notify;
  onDemoPack = opts.onDemoPack;
  onAvatars = opts.onAvatars;
  if (opts.onLink) onLink = opts.onLink;
  onMissingPicture(wantPicture);
  if (opts.avatar) void setMyAvatar(opts.avatar);
  openBoard();
  void fetch("packs/index.json").then((r) => (r.ok ? r.json() : []), () => []).then((list: { id: string; name: string }[]) => {
    demoPacks = Array.isArray(list) ? list : [];
    welcome();
  });
  welcome();
  deliver({ t: "stats", stats: { top: [], recent: [] } });
  // After a reload: back into the room this tab was in (once the TURN servers are known).
  const current = localStorage.getItem("kvz.p2p.current");
  void loadTurn().finally(() => { if (current && !game) joinGame(current, undefined, false, true); });
}

function welcome() { deliver({ t: "welcome", you: { id: me.id, name: me.name, avatar: avatars.get(me.id)?.d }, demoPacks }); }

/* ---------- the board: the room list, straight through the relays ---------- */

interface Listed { summary: RoomSummary; at: number; changedAt: number }
const listed = new Map<string, Listed>();
let roomsTimer: ReturnType<typeof setTimeout> | undefined;
const BOARD_TOPIC = `${APP_ID}/rooms`;
const boardSockets = new Map<string, WebSocket>();
type BoardMsg = { r?: { id: string; at: number; s?: RoomSummary; gone?: boolean }[]; q?: 1 };

function openBoard() {
  for (const url of BOARD_RELAYS) connectBoard(url, 0);
  setInterval(() => {
    const now = Date.now();
    let dropped = false;
    for (const [id, e] of listed) if (now - e.changedAt > LISTED_TTL) { listed.delete(id); dropped = true; }
    if (dropped) showRooms();
  }, 5000);
}

function connectBoard(url: string, attempt: number) {
  let ws: WebSocket;
  try { ws = new WebSocket(url); } catch { return; }
  boardSockets.set(url, ws);
  ws.onopen = () => {
    attempt = 0;
    ws.send(nostrSubscribe(`kvzb${Math.random().toString(36).slice(2, 10)}`, BOARD_TOPIC));
    if (game) farSubscribe(game, ws);
    // A newcomer: whoever keeps a room, announce it now.
    void boardSend({ q: 1 }, ws);
  };
  ws.onmessage = (e) => {
    try {
      const m = JSON.parse(String(e.data));
      if (m[0] !== "EVENT" || typeof m[2]?.content !== "string") return;
      if (game && m[1] === game.farSub) void onFar(game, m[2].content, String(m[2].id));
      else if (String(m[1]).startsWith("kvzb")) onBoard(JSON.parse(m[2].content) as BoardMsg);
    } catch { /* not ours */ }
  };
  ws.onclose = () => {
    if (boardSockets.get(url) === ws) boardSockets.delete(url);
    setTimeout(() => connectBoard(url, attempt + 1), Math.min(120_000, 3000 * 2 ** attempt));
  };
}

async function boardSend(m: BoardMsg, only?: WebSocket) {
  const ev = await createEvent(BOARD_TOPIC, JSON.stringify(m));
  for (const ws of only ? [only] : boardSockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(ev);
}

let askedAt = 0;
function onBoard(m: BoardMsg) {
  if (Array.isArray(m?.r)) mergeRooms(m.r);
  // Someone new asks: the keeper answers soon (a little apart, so not all at once).
  if (m?.q && game?.room && Date.now() - askedAt > 3000) {
    askedAt = Date.now();
    const g = game;
    setTimeout(() => announce(g), 300 + Math.random() * 1500);
  }
}

function mergeRooms(entries: { id: string; at: number; s?: RoomSummary; gone?: boolean }[]) {
  if (!Array.isArray(entries)) return;
  let changed = false;
  for (const e of entries) {
    if (typeof e?.id !== "string" || typeof e.at !== "number") continue;
    const cur = listed.get(e.id);
    if (cur && cur.at >= e.at) continue;
    if (e.gone || !e.s) { if (listed.delete(e.id)) changed = true; continue; }
    // Only a newer announcement keeps a room alive: copies passed along don't.
    listed.set(e.id, { summary: e.s, at: e.at, changedAt: Date.now() });
    changed = true;
  }
  if (changed) showRooms();
}

function showRooms() {
  if (roomsTimer) return;
  roomsTimer = setTimeout(() => {
    roomsTimer = undefined;
    deliver({ t: "rooms", rooms: [...listed.values()].map((e) => e.summary) });
  }, 200);
}

/** The keeper tells everyone on the site about its room. */
function announce(g: Game, gone = false) {
  if (!g.room) return;
  const entry = { id: g.code, at: Date.now(), s: gone ? undefined : g.room.summary(), gone: gone || undefined };
  mergeRooms([entry]);
  void boardSend({ r: [entry] });
}

/** The room is on the board and someone keeps announcing it. */
const alive = (code: string) => { const e = listed.get(code); return !!e && Date.now() - e.changedAt < LISTED_TTL; };

/* ---------- avatars ---------- */

/**
 * Pictures travel once per person, not in every update: the room only carries "p2p:<id>:<version>",
 * and each browser asks for a picture it hasn't got (from the person, or from the keeper).
 */
const avatars = new Map<string, { v: string; d: string }>();
/** The latest version known for each person (the picture itself may not be here yet). */
const avVer = new Map<string, string>();
const MAX_AVATAR = 400_000;

const verOf = (d: string) => { let h = 2166136261; for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d.charCodeAt(i), 16777619) >>> 0; return h.toString(36); };
const tokenOf = (id: string) => { const v = avVer.get(id); return v ? `p2p:${id}:${v}` : undefined; };

/** The picture for a "p2p:" token, if it's here. */
export function avatarOf(token: string): string | undefined {
  const [, id, v] = token.split(":");
  const a = avatars.get(id);
  return a && a.v === v ? a.d : undefined;
}

const asked = new Map<string, number>();
/** Asks for someone's picture (the UI calls this for tokens it can't show yet). */
export function wantAvatar(token: string) {
  const [, id, v] = token.split(":");
  const g = game;
  if (!g || !id || avatars.get(id)?.v === v || Date.now() - (asked.get(token) ?? 0) < 8000) return;
  asked.set(token, Date.now());
  const to = peerOf(g, id) ? id : g.keeper && g.keeper !== me.id ? g.keeper : id;
  post(g, to, "wantav", { u: id });
}

/** Small and square: 128 px is plenty for a seat. An animated GIF is kept as it is if it's small. */
async function shrink(src: string): Promise<string> {
  if (src.startsWith("data:image/gif") && src.length <= MAX_AVATAR) return src;
  const img = new Image();
  // Not img.decode(): a tab in the background may put it off indefinitely.
  const loaded = await new Promise<boolean>((ok) => {
    const t = setTimeout(() => ok(false), 5000);
    img.onload = () => { clearTimeout(t); ok(true); };
    img.onerror = () => { clearTimeout(t); ok(false); };
    img.src = src;
  });
  if (!loaded || !img.naturalWidth) return src;
  const side = 128;
  const c = document.createElement("canvas");
  c.width = c.height = side;
  const k = Math.max(side / img.naturalWidth, side / img.naturalHeight);
  const w = img.naturalWidth * k, h = img.naturalHeight * k;
  c.getContext("2d")!.drawImage(img, (side - w) / 2, (side - h) / 2, w, h);
  const webp = c.toDataURL("image/webp", 0.85);
  return webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/jpeg", 0.85);
}

async function setMyAvatar(src: string | null) {
  if (!src) { avatars.delete(me.id); avVer.delete(me.id); }
  else {
    let d: string;
    try { d = await shrink(src); } catch { return; }
    if (d.length > MAX_AVATAR) return;
    avatars.set(me.id, { v: verOf(d), d });
    avVer.set(me.id, verOf(d));
  }
  welcome();
  onAvatars();
  const g = game;
  if (!g) return;
  g.hello();
  if (g.room) { userFor(g, me.id, me.name, me.gender); g.room.changed(); }
  else { const a = avatars.get(me.id); if (a) post(g, "*", "av", { u: me.id, ...a }); }
}

function onAvatar(g: Game, from: string, d: { u: string; v: string; d: string }) {
  if (typeof d?.u !== "string" || typeof d.v !== "string" || typeof d.d !== "string") return;
  if (d.d.length > MAX_AVATAR || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(d.d) || verOf(d.d) !== d.v) return;
  // Only the person themselves sets a new version; others pass on the one already announced.
  if (from !== d.u && avVer.get(d.u) !== d.v) return;
  if (avatars.get(d.u)?.v === d.v) return;
  avatars.set(d.u, { v: d.v, d: d.d });
  avVer.set(d.u, d.v);
  onAvatars();
  const u = g.users.get(d.u);
  if (g.room && u) { u.avatar = tokenOf(d.u); g.room.changed(); }
}

/** Someone's version from a greeting or the room's copy: ask for the picture if it's new. */
function knowVersion(g: Game, id: string, v: string | undefined, ask: boolean) {
  if (id === me.id || avVer.get(id) === v) return;
  if (v) avVer.set(id, v); else avVer.delete(id);
  const u = g.users.get(id);
  if (u) { u.avatar = tokenOf(id); g.room?.changed(); }
  if (v && ask && avatars.get(id)?.v !== v) post(g, id, "wantav", { u: id });
}

/* ---------- a room ---------- */

interface StateMsg { term: number; keeper: string; rev: number; snap: RoomSnapshot; names: Record<string, { n: string; g?: Gender; a?: string }> }
interface PackData { hash: string; xml: string; files: SharedFile[] }

/**
 * Everything in a room travels in envelopes addressed to a person (or to everyone): if two browsers
 * can't connect directly (strict NATs), the envelope goes through someone connected to both.
 */
type Kind = "c2s" | "s2c" | "state" | "beat" | "pack" | "wantpack" | "wantstate" | "av" | "wantav" | "hi" | "wantpic" | "pic";
interface Envelope { i: string; f: string; t: string; k: Kind; d: unknown; h: number }
/** Who each person is directly connected to (and their names), from their reports. */
interface Reach { at: number; links: Map<string, { n: string; g?: Gender }> }

interface Game {
  code: string;
  mesh: Mesh;
  env: (e: Envelope, target?: string) => void;
  hello: (target?: string) => void;
  reachOut: () => void;
  /** Trystero peer id -> person (direct links). */
  peers: Map<string, { userId: string; name: string; gender?: Gender }>;
  reach: Map<string, Reach>;
  seen: Set<string>;
  keeper?: string;
  term: number;
  last?: StateMsg;
  heardAt: number;
  pack?: PackData;
  /** Set when this browser keeps the room. */
  room?: Room;
  users: Map<string, User>;
  sentRev: number;
  joining?: { password?: string; asViewer?: boolean; timer: ReturnType<typeof setTimeout> };
  /** Last time the keeper looked at who is online and swept out the long gone. */
  sweptAt: number;
  inRoom: boolean;
  queue: ClientMsg[];
  timers: ReturnType<typeof setInterval>[];
  /** Members who were expected to take over and didn't: passed over next time. */
  skip: Set<string>;
  expected?: { id: string; by: number };
  rejoinedAt: number;
  openedAt: number;
  /** The spare route: who was heard through the relays (and when), their names, what waits to go. */
  far: Map<string, number>;
  farNames: Map<string, { n: string; g?: Gender }>;
  farSub: string;
  farQ: Envelope[];
  farTimer?: ReturnType<typeof setTimeout>;
  farSentAt: number;
  farSeen: Set<string>;
  hiAt: number;
  stateAskedAt: number;
}
let game: Game | undefined;

/** Tests can pretend some people are unreachable directly: localStorage "kvz.p2p.block" = "id,id". */
const blocked = () => new Set((localStorage.getItem("kvz.p2p.block") ?? "").split(",").filter(Boolean));

function openGame(code: string): Game {
  const g: Game = {
    code, mesh: undefined as unknown as Mesh, env: () => {}, hello: () => {}, reachOut: () => {}, peers: new Map(), reach: new Map(), seen: new Set(),
    term: 0, heardAt: Date.now(), users: new Map(), sentRev: -1, inRoom: false, queue: [], timers: [], skip: new Set(), rejoinedAt: Date.now(), sweptAt: 0,
    openedAt: Date.now(), far: new Map(), farNames: new Map(), farSub: `kvzr${Math.random().toString(36).slice(2, 10)}`, farQ: [], farSentAt: 0, farSeen: new Set(), hiAt: 0, stateAskedAt: 0,
  };
  attachMesh(g);
  farSubscribe(g);
  g.timers.push(setInterval(() => tick(g), 500));
  g.timers.push(setInterval(() => g.reachOut(), 3000));
  game = g;
  localStorage.setItem("kvz.p2p.current", code);
  return g;
}

/** Joins the room's mesh (again, after a retry). */
function attachMesh(g: Game) {
  const mesh = joinRoom(MESH, `room-${g.code}`);
  g.mesh = mesh;
  g.peers.clear();
  const live = () => game === g && g.mesh === mesh;
  const hello = mesh.makeAction<Json>("hello", { onMessage: (d, ctx) => { if (live()) onHello(g, ctx.peerId, d as unknown as Hello); } });
  const reach = mesh.makeAction<Json>("reach", { onMessage: (d, ctx) => { if (live()) onReach(g, ctx.peerId, d as unknown as { u: string; r: [string, string, Gender?][] }); } });
  const env = mesh.makeAction<Json>("env", { onMessage: (d, ctx) => { if (live()) onEnvelope(g, ctx.peerId, d as unknown as Envelope); } });
  g.hello = (target) => { void hello.send({ u: me.id, n: me.name, g: me.gender, a: avVer.get(me.id) } satisfies Hello as unknown as Json, target ? { target } : undefined); };
  g.env = (e, target) => { void env.send(e as unknown as Json, target ? { target } : undefined); };
  g.reachOut = () => {
    const r = [...g.peers.values()].map((p) => [p.userId, p.name, p.gender]);
    void reach.send({ u: me.id, r } as Json);
  };
  mesh.onPeerJoin = (peerId) => { g.hello(peerId); };
  mesh.onPeerLeave = (peerId) => {
    const p = g.peers.get(peerId);
    g.peers.delete(peerId);
    if (!p) return;
    g.reachOut();
    refreshOnline(g);
    if (p.userId === g.keeper && !canReach(g, g.keeper)) elect(g);
  };
}

function peerOf(g: Game, userId: string): string | undefined {
  for (const [peerId, p] of g.peers) if (p.userId === userId) return peerId;
  return undefined;
}

/** The peer to hand an envelope for `userId` to: directly, or someone connected to them. */
function route(g: Game, userId: string): string | undefined {
  const direct = peerOf(g, userId);
  if (direct) return direct;
  const now = Date.now();
  for (const [via, r] of g.reach) {
    if (now - r.at > 10_000 || !r.links.has(userId)) continue;
    const peerId = peerOf(g, via);
    if (peerId) return peerId;
  }
  return undefined;
}

/** Everyone this browser can get a message to through browsers (directly or one hop). */
function meshReachable(g: Game): Set<string> {
  const out = new Set([me.id, ...[...g.peers.values()].map((p) => p.userId)]);
  const now = Date.now();
  for (const [via, r] of g.reach) if (now - r.at <= 10_000 && out.has(via)) for (const id of r.links.keys()) out.add(id);
  return out;
}

/** Heard through the relays lately: can be reached that way. */
const isFar = (g: Game, id: string) => Date.now() - (g.far.get(id) ?? 0) < FAR_TTL;
const canReach = (g: Game, id: string) => !!route(g, id) || isFar(g, id);

/** Everyone this browser can get a message to, the spare route included. */
function reachable(g: Game): Set<string> {
  const out = meshReachable(g);
  for (const id of g.far.keys()) if (isFar(g, id)) out.add(id);
  return out;
}

let envSeq = 0;
/** Sends to one person ("*": everyone in the room). */
function post(g: Game, to: string, k: Kind, d: unknown) {
  const e: Envelope = { i: `${me.id}.${++envSeq}`, f: me.id, t: to, k, d, h: 0 };
  if (to === "*") { g.env(e); return; }
  const peerId = route(g, to);
  if (peerId) g.env(e, peerId);
  // No browser in between: through the relays (a whole pack is too big for that).
  else if (isFar(g, to) && k !== "pack") farPost(g, e);
}

/* ---------- the spare route: through the relays ---------- */

const roomTopic = (code: string) => `${APP_ID}/room/${code}`;

function farSubscribe(g: Game, only?: WebSocket) {
  for (const ws of only ? [only] : boardSockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(nostrSubscribe(g.farSub, roomTopic(g.code)));
}

function farPost(g: Game, e: Envelope) {
  // Only the latest view of the room matters to each person.
  if (e.k === "s2c" && (e.d as ServerMsg)?.t === "room") g.farQ = g.farQ.filter((x) => !(x.k === "s2c" && x.t === e.t && (x.d as ServerMsg)?.t === "room"));
  g.farQ.push(e);
  if (!g.farTimer) g.farTimer = setTimeout(() => void farFlush(g), Math.max(FAR_BATCH_MS, FAR_GAP - (Date.now() - g.farSentAt)));
}

async function farFlush(g: Game) {
  g.farTimer = undefined;
  const batch = g.farQ.splice(0);
  if (!batch.length) return;
  g.farSentAt = Date.now();
  await farSend(g, batch);
}

async function farSend(g: Game, batch: Envelope[]): Promise<void> {
  const body = await zipJson(batch);
  if (body.length > FAR_MAX) {
    if (batch.length === 1) { console.warn("[p2p] too big for the relays:", batch[0].k); return; }
    const mid = batch.length >> 1;
    await farSend(g, batch.slice(0, mid));
    await farSend(g, batch.slice(mid));
    return;
  }
  const ev = await createEvent(roomTopic(g.code), body);
  for (const ws of boardSockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(ev);
}

async function onFar(g: Game, content: string, eventId: string) {
  // The same event comes from every relay.
  if (g.farSeen.has(eventId)) return;
  g.farSeen.add(eventId);
  if (g.farSeen.size > 2000) g.farSeen = new Set([...g.farSeen].slice(-500));
  let list: Envelope[];
  try { list = await unzipJson(content) as Envelope[]; } catch { return; }
  if (game !== g || !Array.isArray(list)) return;
  const now = Date.now();
  for (const e of list) {
    if (!e || typeof e.i !== "string" || typeof e.f !== "string" || e.f === me.id) continue;
    g.far.set(e.f, now);
    if (e.t !== me.id && e.t !== "*") continue;
    if (g.seen.has(e.i)) continue;
    g.seen.add(e.i);
    dispatch(g, e.f, e.k, e.d);
  }
}

/**
 * Pictures for someone on the spare route: they ask the keeper with the key the picture was shown
 * with, the keeper sends it back decrypted, small (see smallPicture) and in parts.
 */
const PIC_PART = 20_000;
const PIC_ASK_MS = 20_000;
interface PicPart { h: string; i: number; n: number; m: string; d: string }
const picAsked = new Map<string, number>();
const picSending = new Map<string, number>();
const picParts = new Map<string, { n: number; m: string; parts: string[]; got: number }>();

function wantPicture(hash: string, key: string, mime: string) {
  const g = game;
  if (!g || g.room || !g.keeper || route(g, g.keeper) || !isFar(g, g.keeper)) return;
  if (Date.now() - (picAsked.get(hash) ?? 0) < PIC_ASK_MS) return;
  picAsked.set(hash, Date.now());
  post(g, g.keeper, "wantpic", { h: hash, k: key, m: mime });
}

async function sendPicture(g: Game, to: string, d: { h?: unknown; k?: unknown; m?: unknown }) {
  if (typeof d?.h !== "string" || !/^[0-9a-f]{64}$/.test(d.h) || typeof d.k !== "string" || typeof d.m !== "string") return;
  const id = `${to}:${d.h}`;
  if (Date.now() - (picSending.get(id) ?? 0) < PIC_ASK_MS / 2) return;
  picSending.set(id, Date.now());
  const pic = await smallPicture(d.h, d.k, d.m);
  if (!pic || game !== g) return;
  const all = b64(pic.data.buffer as ArrayBuffer);
  const n = Math.ceil(all.length / PIC_PART);
  for (let i = 0; i < n; i++) post(g, to, "pic", { h: d.h, i, n, m: pic.mime, d: all.slice(i * PIC_PART, (i + 1) * PIC_PART) } satisfies PicPart);
}

function onPicturePart(d: PicPart) {
  if (typeof d?.h !== "string" || typeof d.d !== "string" || typeof d.m !== "string" || !/^image\//.test(d.m)) return;
  if (!Number.isInteger(d.i) || !Number.isInteger(d.n) || d.n < 1 || d.n > 60 || d.i < 0 || d.i >= d.n) return;
  let e = picParts.get(d.h);
  if (!e || e.n !== d.n) picParts.set(d.h, (e = { n: d.n, m: d.m, parts: [], got: 0 }));
  if (e.parts[d.i] === undefined) { e.parts[d.i] = d.d; e.got++; }
  if (e.got < e.n) return;
  picParts.delete(d.h);
  try { gotPicture(d.h, Uint8Array.from(atob(e.parts.join("")), (c) => c.charCodeAt(0)), e.m); } catch { /* broken on the way */ }
}

/** No way to the keeper through browsers: "hi" through the relays (it answers the same way). */
function sayHiFar(g: Game) {
  g.hiAt = Date.now();
  farPost(g, { i: `${me.id}.${++envSeq}`, f: me.id, t: "*", k: "hi", d: { n: me.name, g: me.gender, a: avVer.get(me.id) }, h: 0 });
}

function b64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

async function zipJson(v: unknown): Promise<string> {
  const json = JSON.stringify(v);
  if (typeof CompressionStream === "undefined") return JSON.stringify({ j: v });
  const zipped = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  return JSON.stringify({ z: b64(zipped) });
}

async function unzipJson(content: string): Promise<unknown> {
  const o = JSON.parse(content) as { z?: string; j?: unknown };
  if (typeof o.z !== "string") return o.j;
  const bytes = Uint8Array.from(atob(o.z), (c) => c.charCodeAt(0));
  return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
}

function onEnvelope(g: Game, peerId: string, e: Envelope) {
  if (!e || typeof e.i !== "string" || typeof e.f !== "string" || g.seen.has(e.i)) return;
  const from = g.peers.get(peerId);
  if (!from || blocked().has(from.userId)) return;
  // Sent directly, the sender must be who it says it is.
  if (e.h === 0 && e.f !== from.userId) return;
  g.seen.add(e.i);
  if (g.seen.size > 5000) g.seen = new Set([...g.seen].slice(-2000));
  if (e.t === me.id || e.t === "*") dispatch(g, e.f, e.k, e.d);
  if (e.h >= 2) return;
  const fwd = { ...e, h: e.h + 1 };
  if (e.t !== "*" && e.t !== me.id) {
    // Passing it on to someone this browser is connected to.
    const next = peerOf(g, e.t);
    if (next && next !== peerId) g.env(fwd, next);
  } else if (e.t === "*") {
    // A broadcast reaches those the sender can't reach directly through this browser.
    const theirs = g.reach.get(e.f)?.links;
    for (const [pid, p] of g.peers) if (pid !== peerId && p.userId !== e.f && !theirs?.has(p.userId)) g.env(fwd, pid);
  }
}

function dispatch(g: Game, from: string, k: Kind, d: unknown) {
  switch (k) {
    case "c2s": return onFromMember(g, from, d as ClientMsg);
    case "s2c": return fromKeeper(g, d as ServerMsg);
    case "state": return onState(g, d as StateMsg, from);
    case "beat": return onBeat(g, d as { term: number; keeper: string; rev: number }, from);
    case "pack": return onPack(g, d as PackData);
    case "wantpack": if (g.pack && g.pack.hash === (d as { hash: string })?.hash) post(g, from, "pack", g.pack); return;
    case "wantstate": if (g.room) sendState(g, from); return;
    case "av": return onAvatar(g, from, d as { u: string; v: string; d: string });
    case "wantpic": return void sendPicture(g, from, d as { h?: unknown; k?: unknown; m?: unknown });
    case "pic": if (from === g.keeper) onPicturePart(d as PicPart); return;
    case "hi": {
      const h = d as { n?: unknown; g?: Gender; a?: unknown };
      g.farNames.set(from, { n: String(h?.n ?? "Игрок").slice(0, 24), g: h?.g === "m" || h?.g === "f" ? h.g : undefined });
      knowVersion(g, from, typeof h?.a === "string" ? h.a : undefined, true);
      // The keeper answers, so they know whom to talk to (and both know the other is still there).
      if (g.room) { refreshOnline(g); post(g, from, "beat", { term: g.term, keeper: me.id, rev: g.room.rev }); }
      return;
    }
    case "wantav": {
      const id = (d as { u?: unknown })?.u;
      const a = typeof id === "string" ? avatars.get(id) : undefined;
      if (a) post(g, from, "av", { u: id, ...a });
      return;
    }
  }
}

interface Hello { u: string; n: string; g?: Gender; a?: string }
function onHello(g: Game, peerId: string, d: Hello) {
  if (typeof d?.u !== "string" || blocked().has(d.u)) return;
  g.peers.set(peerId, { userId: d.u, name: String(d.n ?? "Игрок").slice(0, 24), gender: d.g });
  knowVersion(g, d.u, typeof d.a === "string" ? d.a : undefined, true);
  g.reachOut();
  refreshOnline(g);
  if (d.u === g.keeper) keeperFound(g);
  // The keeper greets a newcomer with the room and its pack.
  if (g.room) {
    sendState(g, d.u);
    if (g.pack) post(g, d.u, "pack", g.pack);
  }
}

function onReach(g: Game, peerId: string, d: { u: string; r: [string, string, Gender?][] }) {
  const from = g.peers.get(peerId);
  if (!from || from.userId !== d?.u || !Array.isArray(d.r)) return;
  const links = new Map<string, { n: string; g?: Gender }>();
  for (const [id, n, gen] of d.r) if (typeof id === "string") links.set(id, { n: String(n ?? "Игрок").slice(0, 24), g: gen });
  g.reach.set(d.u, { at: Date.now(), links });
  refreshOnline(g);
  if (g.keeper && canReach(g, g.keeper)) keeperFound(g);
}

/** The keeper: who of the room's members can be reached right now. */
function refreshOnline(g: Game) {
  if (!g.room) return;
  const mesh = meshReachable(g);
  for (const r of g.reach.values()) for (const [id, n] of r.links) if (!g.users.has(id)) userFor(g, id, n.n, n.g);
  for (const p of g.peers.values()) userFor(g, p.userId, p.name, p.gender);
  for (const [id, n] of g.farNames) if (!g.users.has(id) && isFar(g, id)) userFor(g, id, n.n, n.g);
  for (const u of g.users.values()) {
    const link = u.id === me.id ? 1 : peerOf(g, u.id) ? 1 : mesh.has(u.id) ? 2 : isFar(g, u.id) ? 3 : undefined;
    const online = u.id === me.id || link !== undefined;
    if (online === u.online && link === u.link) continue;
    const was = u.online;
    u.online = online;
    u.link = link;
    if (!g.room.members.has(u.id)) continue;
    // Back after a drop: rejoin quietly; gone: the room notices; only the way changed: show it.
    if (online && !was) g.room.join(u);
    else if (!online && was) g.room.connectionChanged(u.id);
    else g.room.changed();
  }
}

/* ---------- keeping a room ---------- */

function userFor(g: Game, id: string, name: string, gender?: Gender): User {
  let u = g.users.get(id);
  if (!u) {
    u = { id, token: "", name, gender, online: id === me.id, lastChat: 0, send: (m) => sendToUser(g, id, m) };
    g.users.set(id, u);
  } else { u.name = name; u.gender = gender; }
  u.avatar = tokenOf(id);
  return u;
}

function sendToUser(g: Game, userId: string, m: ServerMsg) {
  if (userId === me.id) return fromKeeper(g, m);
  post(g, userId, "s2c", m);
}

function nameOf(g: Game, userId: string): { n: string; g?: Gender } {
  for (const p of g.peers.values()) if (p.userId === userId) return { n: p.name, g: p.gender };
  for (const r of g.reach.values()) { const x = r.links.get(userId); if (x) return x; }
  const far = g.farNames.get(userId);
  if (far) return far;
  const u = g.users.get(userId);
  return { n: u?.name ?? "Игрок", g: u?.gender };
}

function hubFor(g: Game): Hub {
  let soon: ReturnType<typeof setTimeout> | undefined;
  return {
    user: (id) => g.users.get(id),
    // Not after the room is gone: a late announcement would put a deleted room back on the list.
    roomsChanged: () => { if (!soon) soon = setTimeout(() => { soon = undefined; if (game === g && g.room) announce(g); }, 1000); },
    closeRoom: (room, why) => { if (game === g && g.room === room) shutRoom(g, why); },
  };
}

const hooksFor = (g: Game): PackHooks => ({
  useDemoPack: (_room, _user, _id, err) => err(text("err.noSuchPack")),
  sharePack(room, _user, msg, err) {
    buildSharedPack(msg.xml, msg.files).then((pack) => {
      if (g.room !== room || room.phase !== "lobby") return;
      g.pack = { hash: pack.hash, xml: msg.xml, files: msg.files };
      room.setPack(pack);
      post(g, "*", "pack", g.pack);
      void saveCopy(g);
    }, (e: Error) => err(e.message === "too big" ? text("err.packSize") : e.message === "bad share" ? text("err.badShare") : e.message));
  },
});

/** A message from a member (or from this browser) to the room this browser keeps. */
function keeperHandle(g: Game, user: User, m: ClientMsg) {
  const room = g.room!;
  switch (m.t) {
    case "joinRoom": {
      user.online = true;
      const e = room.join(user, m.password, m.asViewer);
      if (e) user.send(errorMsg(e));
      return;
    }
    case "leaveRoom":
      room.leave(user);
      return;
    case "profile":
      return;
  }
  handleRoomMsg(room, user, m, hooksFor(g));
}

function onFromMember(g: Game, from: string, m: ClientMsg) {
  if (!g.room || !m || typeof m.t !== "string") return;
  const n = nameOf(g, from);
  keeperHandle(g, userFor(g, from, n.n, n.g), m);
}

function namesOf(g: Game) {
  const names: StateMsg["names"] = {};
  for (const [id, u] of g.users) names[id] = { n: u.name, g: u.gender, a: avVer.get(id) };
  return names;
}

function stateOf(g: Game): StateMsg {
  return { term: g.term, keeper: me.id, rev: g.room!.rev, snap: g.room!.snapshot(), names: namesOf(g) };
}

function sendState(g: Game, to = "*") {
  if (!g.room) return;
  const s = stateOf(g);
  g.last = s;
  post(g, to, "state", s);
}

let lastSave = 0;
let lastBeat = 0;
let lastAnnounce = 0;
function tick(g: Game) {
  if (game !== g) return;
  const now = Date.now();
  if (g.room) {
    if (g.room.rev !== g.sentRev) { g.sentRev = g.room.rev; sendState(g); }
    if (now - lastBeat > BEAT_MS) { lastBeat = now; post(g, "*", "beat", { term: g.term, keeper: me.id, rev: g.room.rev }); }
    if (now - lastAnnounce > ANNOUNCE_MS) { lastAnnounce = now; announce(g); }
    if (now - lastSave > 5000) { lastSave = now; void saveCopy(g); }
    // Reports about who is connected go stale without a word: look again now and then.
    if (now - g.sweptAt > 2000) {
      g.sweptAt = now;
      refreshOnline(g);
      g.room.sweepOffline(now);
      // Its time may be up (a lobby nobody starts, a game nobody plays, the results): then it closes.
      g.room.lifecycle(now);
      if (game !== g) return;
    }
    setLink("ok");
    return;
  }
  // No way to the keeper through browsers: keep in touch through the relays.
  const direct = !!g.keeper && !!route(g, g.keeper);
  if (!direct && now - g.openedAt > FAR_AFTER && now - g.hiAt > FAR_HI_MS) sayHiFar(g);
  if (g.inRoom) setLink(direct ? "ok" : g.keeper && isFar(g, g.keeper) ? "far" : now - g.heardAt > 4000 ? "lost" : "ok");
  // No word from the keeper and no way to it: maybe the connection itself is stuck. Try again.
  if (g.keeper && !route(g, g.keeper) && now - g.heardAt > REJOIN_MS && now - g.rejoinedAt > REJOIN_MS) {
    g.rejoinedAt = now;
    void g.mesh.leave();
    attachMesh(g);
    return;
  }
  if (g.last && now - g.heardAt > KEEPER_SILENT) elect(g);
}

/* ---------- following a room ---------- */

function newer(g: Game, term: number, keeper: string) {
  return term > g.term || (term === g.term && (!g.keeper || keeper <= g.keeper));
}

function onState(g: Game, s: StateMsg, from: string) {
  if (!s?.snap || typeof s.term !== "number" || s.keeper !== from) return;
  if (g.room) {
    // Two keepers (after a split): the later term wins, then the smaller id.
    if (s.term > g.term || (s.term === g.term && s.keeper < me.id)) stepDown(g);
    else return;
  }
  if (!newer(g, s.term, s.keeper)) return;
  g.term = s.term;
  g.keeper = s.keeper;
  g.last = s;
  for (const [id, n] of Object.entries(s.names ?? {})) knowVersion(g, id, typeof n?.a === "string" ? n.a : undefined, false);
  g.heardAt = Date.now();
  g.skip.clear();
  g.expected = undefined;
  const packHash = s.snap.packHash;
  if (packHash && g.pack?.hash !== packHash) post(g, from, "wantpack", { hash: packHash });
  keeperFound(g);
  if (Date.now() - lastSave > 5000) { lastSave = Date.now(); void saveCopy(g); }
}

function onBeat(g: Game, b: { term: number; keeper: string; rev: number }, from: string) {
  if (typeof b?.term !== "number" || b.keeper !== from) return;
  if (g.room) {
    if (b.term > g.term || (b.term === g.term && b.keeper < me.id)) post(g, from, "wantstate", {});
    return;
  }
  if (!newer(g, b.term, b.keeper)) return;
  g.term = b.term;
  g.keeper = b.keeper;
  g.heardAt = Date.now();
  // Over the relays the room's full copy is big: asked for now and then, not every change.
  const stale = !g.last || g.last.rev !== b.rev || g.last.keeper !== b.keeper;
  if (stale && (route(g, from) || Date.now() - g.stateAskedAt > FAR_STATE_MS)) { g.stateAskedAt = Date.now(); post(g, from, "wantstate", {}); }
  keeperFound(g);
}

function onPack(g: Game, p: PackData) {
  if (!p || typeof p.xml !== "string" || !Array.isArray(p.files)) return;
  g.pack = p;
  void saveCopy(g);
}

/** The keeper can be reached: send what waited for it. */
function keeperFound(g: Game) {
  if (!g.keeper || !canReach(g, g.keeper)) return;
  if (g.joining) {
    clearTimeout(g.joining.timer);
    const { password, asViewer } = g.joining;
    g.joining = undefined;
    toKeeper(g, { t: "joinRoom", roomId: g.code, password, asViewer });
    const a = avatars.get(me.id);
    if (a && g.keeper !== me.id) post(g, g.keeper, "av", { u: me.id, ...a });
  }
  for (const m of g.queue.splice(0)) toKeeper(g, m);
}

function toKeeper(g: Game, m: ClientMsg) {
  if (g.room) return keeperHandle(g, userFor(g, me.id, me.name, me.gender), m);
  if (!g.keeper || !canReach(g, g.keeper)) { g.queue.push(m); return; }
  post(g, g.keeper, "c2s", m);
}

/** A message from the keeper to this browser. */
function fromKeeper(g: Game, m: ServerMsg) {
  if (game !== g) return;
  if (m.t === "room") g.inRoom = true;
  if (m.t === "error" && !g.inRoom) {
    // Refused at the door (wrong password, banned, no seats): out of the room's mesh.
    deliver(m);
    closeGame(g);
    return;
  }
  if (m.t === "left") {
    // The room is gone (closed, or this person was removed): its copy here mustn't bring it back.
    void dropCopy(g.code);
    deliver(m);
    closeGame(g);
    showRooms();
    return;
  }
  deliver(m);
}

/* ---------- taking over ---------- */

/** The keeper is gone: the first member still here (the host first) takes over. */
function elect(g: Game) {
  if (g.room || !g.last) return;
  // Alone, this browser keeps nobody's room: it waits (otherwise its old copy could win later).
  if (!g.peers.size) return;
  // Someone still gets through to the keeper: it's alive, only this link is broken.
  if (g.keeper && [...g.reach.values()].some((r) => Date.now() - r.at < 6000 && r.links.has(g.keeper!))) return;
  const snap = g.last.snap.data as { members?: { $set?: string[] }; hostId?: string };
  const members = snap.members?.$set ?? [];
  const present = reachable(g);
  const silentKeeper = g.keeper;
  if (g.expected && Date.now() > g.expected.by) g.skip.add(g.expected.id);
  const cands = members.filter((id) => present.has(id) && id !== silentKeeper && !g.skip.has(id)).sort();
  if (snap.hostId && cands.includes(snap.hostId)) cands.unshift(...cands.splice(cands.indexOf(snap.hostId), 1));
  if (!cands.length) return;
  if (cands[0] !== me.id) {
    // Someone else should take over; give them a few seconds, then look again.
    if (g.expected?.id !== cands[0]) g.expected = { id: cands[0], by: Date.now() + 4000 };
    g.heardAt = Date.now() - KEEPER_SILENT + 1000;
    return;
  }
  void takeOver(g, g.last, g.term + 1);
}

async function takeOver(g: Game, from: StateMsg, term: number) {
  let pack: LoadedPack | undefined;
  if (g.pack) { try { pack = await buildSharedPack(g.pack.xml, g.pack.files); } catch { pack = undefined; } }
  if (game !== g || g.room) return;
  for (const [id, n] of Object.entries(from.names ?? {})) {
    if (id !== me.id && typeof n.a === "string") avVer.set(id, n.a);
    userFor(g, id, n.n, n.g);
  }
  const can = reachable(g);
  for (const u of g.users.values()) u.online = can.has(u.id);
  const room = Room.restore(from.snap, hubFor(g), pack, "ev.takeover");
  g.room = room;
  g.term = term;
  g.keeper = me.id;
  g.sentRev = -1;
  g.inRoom = true;
  const self = userFor(g, me.id, me.name, me.gender);
  self.online = true;
  self.roomId = room.id;
  if (!room.members.has(me.id)) room.join(self);
  room.resync();
  sendState(g);
  if (g.pack) post(g, "*", "pack", g.pack);
  announce(g);
  for (const m of g.queue.splice(0)) keeperHandle(g, self, m);
}

function stepDown(g: Game) {
  g.room?.dispose();
  g.room = undefined;
  g.users.clear();
}

/* ---------- copies on disk ---------- */

let dbp: Promise<IDBDatabase | undefined> | undefined;
function db() {
  return (dbp ??= new Promise<IDBDatabase | undefined>((ok) => {
    try {
      const req = indexedDB.open("kvz-p2p", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("rooms");
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ok(undefined);
    } catch { ok(undefined); }
  }));
}
interface Copy { state: StateMsg; pack?: PackData; at: number }
async function saveCopy(g: Game) {
  const state = g.room ? stateOf(g) : g.last;
  if (!state) return;
  const d = await db();
  try { d?.transaction("rooms", "readwrite").objectStore("rooms").put({ state, pack: g.pack, at: Date.now() } satisfies Copy, g.code); } catch { /* full or blocked */ }
}
async function dropCopy(code: string) {
  const d = await db();
  try { d?.transaction("rooms", "readwrite").objectStore("rooms").delete(code); } catch { /* blocked */ }
}
async function loadCopy(code: string): Promise<Copy | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((ok) => {
    try {
      const req = d.transaction("rooms").objectStore("rooms").get(code);
      req.onsuccess = () => { const c = req.result as Copy | undefined; ok(c && Date.now() - c.at < SAVED_TTL ? c : undefined); };
      req.onerror = () => ok(undefined);
    } catch { ok(undefined); }
  });
}

/* ---------- entering and leaving ---------- */

function makeCode(): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    let c = "";
    for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!listed.has(c)) return c;
  }
}

/** The room closes for everyone: they're told why and go back to the games list; it leaves the list and the disks. */
function shutRoom(g: Game, why: Text) {
  const room = g.room;
  if (!room) return;
  const msg: ServerMsg = { t: "left", reason: formatText("ru", why), text: why };
  for (const id of room.members) if (id !== me.id) post(g, id, "s2c", msg);
  announce(g, true);
  void dropCopy(g.code);
  localStorage.removeItem("kvz.p2p.current");
  game = undefined;
  deliver(msg);
  showRooms();
  // Let the goodbyes go out first.
  setTimeout(() => closeGame(g), 600);
}

function createGame(m: Extract<ClientMsg, { t: "createRoom" }>) {
  // Room names are unique among the rooms on the list.
  const name = roomNameKey(m.name.trim().slice(0, 40) || `Комната ${me.name}`);
  if ([...listed.values()].some((e) => e.summary.id !== game?.code && roomNameKey(e.summary.name) === name)) {
    deliver(errorMsg(text("err.nameTaken")));
    return;
  }
  if (game) leaveGame();
  const g = openGame(makeCode());
  g.term = 1;
  g.keeper = me.id;
  g.inRoom = true;
  const self = userFor(g, me.id, me.name, me.gender);
  const room = new Room(g.code, hubFor(g), self, m);
  g.room = room;
  const e = room.join(self, m.password, !!room.hostId);
  if (e) deliver(errorMsg(e));
  announce(g);
}

function joinGame(code: string, password: string | undefined, asViewer: boolean | undefined, quiet = false) {
  code = code.toUpperCase().trim();
  if (game?.code === code) return;
  if (game) leaveGame();
  const g = openGame(code);
  if (!quiet) notify(text("ev.joiningRoom", { code }));
  g.joining = {
    password, asViewer,
    // Nobody answers: bring the room back from this browser's copy, or give up.
    timer: setTimeout(() => {
      void loadCopy(code).then((copy) => {
        if (game !== g || !g.joining) return;
        g.joining = undefined;
        // Someone else still keeps it (it's on the board): this browser just can't get through.
        // Bringing back its own copy would split the room in two.
        if (alive(code) || !copy) {
          deliver(errorMsg(text(alive(code) ? "err.noRoute" : "err.roomLost")));
          closeGame(g);
          return;
        }
        g.pack = copy.pack;
        g.last = copy.state;
        void takeOver(g, copy.state, copy.state.term + 1);
      });
    }, alive(code) ? JOIN_WAIT_LISTED : JOIN_WAIT),
  };
}

/** Leaves the room for good (the others carry on without this browser). */
function leaveGame() {
  const g = game;
  if (!g) return;
  if (g.room) {
    const self = g.users.get(me.id);
    if (self) g.room.leave(self);
    sendState(g);
    // The last one out: the room is deleted at once, from the list and from this browser's disk.
    if (!g.room.members.size) { announce(g, true); void dropCopy(g.code); }
  } else if (g.keeper) toKeeper(g, { t: "leaveRoom" });
  localStorage.removeItem("kvz.p2p.current");
  // Let the last messages go out first.
  setTimeout(() => closeGame(g), 400);
  game = undefined;
}

let linkNow: LinkState = "ok";
function setLink(s: LinkState) {
  if (s === linkNow) return;
  linkNow = s;
  onLink(s);
}

function closeGame(g: Game) {
  for (const t of g.timers) clearInterval(t);
  if (g.joining) clearTimeout(g.joining.timer);
  if (g.farTimer) clearTimeout(g.farTimer);
  for (const ws of boardSockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(["CLOSE", g.farSub]));
  setLink("ok");
  g.room?.dispose();
  g.room = undefined;
  void g.mesh.leave();
  if (game === g) { game = undefined; localStorage.removeItem("kvz.p2p.current"); }
}

/* ---------- the client's messages ---------- */

export function send(m: ClientMsg) {
  switch (m.t) {
    case "hello": return;
    case "profile":
      if (m.name?.trim()) me.name = m.name.trim().slice(0, 24);
      if (m.gender !== undefined) me.gender = m.gender ?? undefined;
      if (m.avatar !== undefined) void setMyAvatar(m.avatar);
      welcome();
      if (game) game.hello();
      if (game?.room) { userFor(game, me.id, me.name, me.gender); game.room.changed(); }
      return;
    case "listRooms":
      deliver({ t: "stats", stats: { top: [], recent: [] } });
      deliver({ t: "rooms", rooms: [...listed.values()].map((e) => e.summary) });
      return;
    // Connections start only once the TURN servers are known (at once without them).
    case "createRoom": void loadTurn().then(() => createGame(m)); return;
    case "joinRoom": void loadTurn().then(() => joinGame(m.roomId, m.password, m.asViewer)); return;
    case "leaveRoom":
      leaveGame();
      deliver({ t: "left" });
      showRooms();
      return;
    case "useDemoPack": return onDemoPack(m.id);
  }
  if (!game) return deliver(errorMsg(text("err.notInRoom")));
  toKeeper(game, m);
}
