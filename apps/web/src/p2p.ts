/**
 * Peer mode: the game with no game server (for GitHub Pages).
 *
 * - Browsers find each other through public Nostr relays (Trystero) and talk over WebRTC.
 * - Everyone on the site sits in one "lobby" mesh and keeps the list of rooms: each room's keeper
 *   announces its room there, and a newcomer gets the whole list from whoever is online.
 * - A room is kept by one member's browser (the keeper), which runs the same room logic as the
 *   server. It copies the room's state and pack to every member, so if its browser leaves, the next
 *   member takes over from the latest copy. A host who drops out simply comes back as a member.
 * - Every member also keeps the latest copy on disk: when everyone has left, whoever comes back
 *   first brings the room back.
 * - Two browsers that can't connect directly (strict NATs) talk through a third one: every message
 *   is an envelope addressed to a person, passed on by whoever is connected to both.
 */
import { joinRoom } from "trystero";
import { buildSharedPack, errorMsg, handleRoomMsg, Room, type Hub, type LoadedPack, type PackHooks, type RoomSnapshot, type User } from "@kvz/game";
import { text, type ClientMsg, type Gender, type RoomSummary, type ServerMsg, type SharedFile } from "@kvz/protocol";

type Mesh = ReturnType<typeof joinRoom>;
type Json = never;

const APP_ID = "kvizorium-p2p-1";
const ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }];
/** The keeper says it's alive this often; silent for KEEPER_SILENT, it's replaced. */
const BEAT_MS = 2000;
const KEEPER_SILENT = 7000;
/** How long a newcomer waits to hear from a room's keeper. */
const JOIN_WAIT = 9000;
/** A room not announced for this long leaves the list. */
const LISTED_TTL = 25_000;
const ANNOUNCE_MS = 5000;
/** Can't get through to the keeper this long: rejoin the room's mesh to retry the connections. */
const REJOIN_MS = 15_000;
/** A copy saved on disk can bring a room back for this long. */
const SAVED_TTL = 24 * 3600_000;

/* ---------- who I am ---------- */

let me = { id: "", name: "", gender: undefined as Gender | undefined };
let deliver: (m: ServerMsg) => void = () => {};
let onDemoPack: (id: string) => void = () => {};
let demoPacks: { id: string; name: string }[] = [];

export function start(opts: { id: string; name: string; gender?: Gender; deliver: (m: ServerMsg) => void; onDemoPack: (id: string) => void }) {
  me = { id: opts.id, name: opts.name, gender: opts.gender };
  deliver = opts.deliver;
  onDemoPack = opts.onDemoPack;
  joinLobby();
  void fetch("packs/index.json").then((r) => (r.ok ? r.json() : []), () => []).then((list: { id: string; name: string }[]) => {
    demoPacks = Array.isArray(list) ? list : [];
    welcome();
  });
  welcome();
  deliver({ t: "stats", stats: { top: [], recent: [] } });
  // After a reload: back into the room this tab was in.
  const current = localStorage.getItem("kvz.p2p.current");
  if (current) joinGame(current, undefined, false);
}

function welcome() { deliver({ t: "welcome", you: { id: me.id, name: me.name }, demoPacks }); }

/* ---------- the lobby: everyone online keeps the room list ---------- */

interface Listed { summary: RoomSummary; at: number; changedAt: number }
const listed = new Map<string, Listed>();
let lobby: Mesh | undefined;
let sendRooms: ((data: Json, opts?: { target?: string }) => Promise<void>) | undefined;
let roomsTimer: ReturnType<typeof setTimeout> | undefined;

function joinLobby() {
  lobby = joinRoom({ appId: APP_ID, rtcConfig: { iceServers: ICE } }, "lobby");
  const rooms = lobby.makeAction<Json>("rooms", {
    onMessage: (data) => mergeRooms(data as unknown as { id: string; at: number; s?: RoomSummary; gone?: boolean }[]),
  });
  sendRooms = (data, opts) => rooms.send(data, opts);
  // A newcomer gets everything this browser knows.
  lobby.onPeerJoin = (peerId) => { void sendRooms?.(tableOut() as Json, { target: peerId }); };
  // Gossip: now and then the whole list goes to one random peer, so it spreads even to those who
  // can't connect to a room's keeper directly.
  setInterval(() => {
    const peers = Object.keys(lobby?.getPeers() ?? {});
    if (peers.length && listed.size) void sendRooms?.(tableOut() as Json, { target: peers[Math.floor(Math.random() * peers.length)] });
  }, 15_000);
  setInterval(() => {
    const now = Date.now();
    let dropped = false;
    for (const [id, e] of listed) if (now - e.changedAt > LISTED_TTL) { listed.delete(id); dropped = true; }
    if (dropped) showRooms();
  }, 5000);
}

function tableOut() { return [...listed].map(([id, e]) => ({ id, at: e.at, s: e.summary })); }

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
  void sendRooms?.([entry] as Json);
}

/* ---------- a room ---------- */

interface StateMsg { term: number; keeper: string; rev: number; snap: RoomSnapshot; names: Record<string, { n: string; g?: Gender }> }
interface PackData { hash: string; xml: string; files: SharedFile[] }

/**
 * Everything in a room travels in envelopes addressed to a person (or to everyone): if two browsers
 * can't connect directly (strict NATs), the envelope goes through someone connected to both.
 */
type Kind = "c2s" | "s2c" | "state" | "beat" | "pack" | "wantpack" | "wantstate";
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
  inRoom: boolean;
  queue: ClientMsg[];
  timers: ReturnType<typeof setInterval>[];
  /** Members who were expected to take over and didn't: passed over next time. */
  skip: Set<string>;
  expected?: { id: string; by: number };
  rejoinedAt: number;
}
let game: Game | undefined;

/** Tests can pretend some people are unreachable directly: localStorage "kvz.p2p.block" = "id,id". */
const blocked = () => new Set((localStorage.getItem("kvz.p2p.block") ?? "").split(",").filter(Boolean));

function openGame(code: string): Game {
  const g: Game = {
    code, mesh: undefined as unknown as Mesh, env: () => {}, hello: () => {}, reachOut: () => {}, peers: new Map(), reach: new Map(), seen: new Set(),
    term: 0, heardAt: Date.now(), users: new Map(), sentRev: -1, inRoom: false, queue: [], timers: [], skip: new Set(), rejoinedAt: Date.now(),
  };
  attachMesh(g);
  g.timers.push(setInterval(() => tick(g), 500));
  g.timers.push(setInterval(() => g.reachOut(), 3000));
  game = g;
  localStorage.setItem("kvz.p2p.current", code);
  return g;
}

/** Joins the room's mesh (again, after a retry). */
function attachMesh(g: Game) {
  const mesh = joinRoom({ appId: APP_ID, rtcConfig: { iceServers: ICE } }, `room-${g.code}`);
  g.mesh = mesh;
  g.peers.clear();
  const live = () => game === g && g.mesh === mesh;
  const hello = mesh.makeAction<Json>("hello", { onMessage: (d, ctx) => { if (live()) onHello(g, ctx.peerId, d as unknown as { u: string; n: string; g?: Gender }); } });
  const reach = mesh.makeAction<Json>("reach", { onMessage: (d, ctx) => { if (live()) onReach(g, ctx.peerId, d as unknown as { u: string; r: [string, string, Gender?][] }); } });
  const env = mesh.makeAction<Json>("env", { onMessage: (d, ctx) => { if (live()) onEnvelope(g, ctx.peerId, d as unknown as Envelope); } });
  g.hello = (target) => { void hello.send({ u: me.id, n: me.name, g: me.gender } as Json, target ? { target } : undefined); };
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
    if (p.userId === g.keeper && !route(g, g.keeper)) elect(g);
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

/** Everyone this browser can get a message to. */
function reachable(g: Game): Set<string> {
  const out = new Set([me.id, ...[...g.peers.values()].map((p) => p.userId)]);
  const now = Date.now();
  for (const [via, r] of g.reach) if (now - r.at <= 10_000 && out.has(via)) for (const id of r.links.keys()) out.add(id);
  return out;
}

let envSeq = 0;
/** Sends to one person ("*": everyone in the room). */
function post(g: Game, to: string, k: Kind, d: unknown) {
  const e: Envelope = { i: `${me.id}.${++envSeq}`, f: me.id, t: to, k, d, h: 0 };
  if (to === "*") { g.env(e); return; }
  const peerId = route(g, to);
  if (peerId) g.env(e, peerId);
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
  }
}

function onHello(g: Game, peerId: string, d: { u: string; n: string; g?: Gender }) {
  if (typeof d?.u !== "string" || blocked().has(d.u)) return;
  g.peers.set(peerId, { userId: d.u, name: String(d.n ?? "Игрок").slice(0, 24), gender: d.g });
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
  if (g.keeper && route(g, g.keeper)) keeperFound(g);
}

/** The keeper: who of the room's members can be reached right now. */
function refreshOnline(g: Game) {
  if (!g.room) return;
  const can = reachable(g);
  for (const r of g.reach.values()) for (const [id, n] of r.links) if (!g.users.has(id)) userFor(g, id, n.n, n.g);
  for (const p of g.peers.values()) userFor(g, p.userId, p.name, p.gender);
  for (const u of g.users.values()) {
    const online = can.has(u.id);
    if (online === u.online) continue;
    u.online = online;
    if (!g.room.members.has(u.id)) continue;
    // Back after a drop: rejoin quietly; gone: the room notices.
    if (online) g.room.join(u);
    else g.room.connectionChanged(u.id);
  }
}

/* ---------- keeping a room ---------- */

function userFor(g: Game, id: string, name: string, gender?: Gender): User {
  let u = g.users.get(id);
  if (!u) {
    u = { id, token: "", name, gender, online: id === me.id, lastChat: 0, send: (m) => sendToUser(g, id, m) };
    g.users.set(id, u);
  } else { u.name = name; u.gender = gender; }
  return u;
}

function sendToUser(g: Game, userId: string, m: ServerMsg) {
  if (userId === me.id) return fromKeeper(g, m);
  post(g, userId, "s2c", m);
}

function nameOf(g: Game, userId: string): { n: string; g?: Gender } {
  for (const p of g.peers.values()) if (p.userId === userId) return { n: p.name, g: p.gender };
  for (const r of g.reach.values()) { const x = r.links.get(userId); if (x) return x; }
  const u = g.users.get(userId);
  return { n: u?.name ?? "Игрок", g: u?.gender };
}

function hubFor(g: Game): Hub {
  let soon: ReturnType<typeof setTimeout> | undefined;
  return {
    user: (id) => g.users.get(id),
    roomsChanged: () => { if (!soon) soon = setTimeout(() => { soon = undefined; announce(g); }, 1000); },
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
  for (const [id, u] of g.users) names[id] = { n: u.name, g: u.gender };
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
    return;
  }
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
  if (!g.last || g.last.rev !== b.rev || g.last.keeper !== b.keeper) post(g, from, "wantstate", {});
  keeperFound(g);
}

function onPack(g: Game, p: PackData) {
  if (!p || typeof p.xml !== "string" || !Array.isArray(p.files)) return;
  g.pack = p;
  void saveCopy(g);
}

/** The keeper can be reached: send what waited for it. */
function keeperFound(g: Game) {
  if (!g.keeper || !route(g, g.keeper)) return;
  if (g.joining) {
    clearTimeout(g.joining.timer);
    const { password, asViewer } = g.joining;
    g.joining = undefined;
    toKeeper(g, { t: "joinRoom", roomId: g.code, password, asViewer });
  }
  for (const m of g.queue.splice(0)) toKeeper(g, m);
}

function toKeeper(g: Game, m: ClientMsg) {
  if (g.room) return keeperHandle(g, userFor(g, me.id, me.name, me.gender), m);
  if (!g.keeper || !route(g, g.keeper)) { g.queue.push(m); return; }
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
  for (const [id, n] of Object.entries(from.names ?? {})) userFor(g, id, n.n, n.g);
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

function createGame(m: Extract<ClientMsg, { t: "createRoom" }>) {
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

function joinGame(code: string, password: string | undefined, asViewer: boolean | undefined) {
  code = code.toUpperCase().trim();
  if (game?.code === code) return;
  if (game) leaveGame();
  const g = openGame(code);
  g.joining = {
    password, asViewer,
    // Nobody answers: bring the room back from this browser's copy, or give up.
    timer: setTimeout(() => {
      void loadCopy(code).then((copy) => {
        if (game !== g || !g.joining) return;
        g.joining = undefined;
        if (!copy) {
          deliver(errorMsg(text("err.roomLost")));
          closeGame(g);
          return;
        }
        g.pack = copy.pack;
        g.last = copy.state;
        void takeOver(g, copy.state, copy.state.term + 1);
      });
    }, JOIN_WAIT),
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
    if (!g.room.members.size) announce(g, true);
  } else if (g.keeper) toKeeper(g, { t: "leaveRoom" });
  localStorage.removeItem("kvz.p2p.current");
  // Let the last messages go out first.
  setTimeout(() => closeGame(g), 400);
  game = undefined;
}

function closeGame(g: Game) {
  for (const t of g.timers) clearInterval(t);
  if (g.joining) clearTimeout(g.joining.timer);
  g.room?.dispose();
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
      welcome();
      if (game) game.hello();
      if (game?.room) { userFor(game, me.id, me.name, me.gender); game.room.changed(); }
      return;
    case "listRooms":
      deliver({ t: "stats", stats: { top: [], recent: [] } });
      deliver({ t: "rooms", rooms: [...listed.values()].map((e) => e.summary) });
      return;
    case "createRoom": return createGame(m);
    case "joinRoom": return joinGame(m.roomId, m.password, m.asViewer);
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
