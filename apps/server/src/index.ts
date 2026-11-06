import { Stats } from "./stats.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { rename, writeFile, rm } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { formatText, text, type ClientMsg, type RoomSummary, type ServerMsg, type SharedFile, type Text } from "@kvz/protocol";
import { errorMsg, handleRoomMsg, Room, type PackHooks, type RoomSnapshot, type User } from "@kvz/game";
import { hiddenMediaFile, diskPathFor, forgetPack, loadPack, loadSharedPack, type LoadedPack } from "./packs.ts";

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Built web client to serve at / (optional in dev, Vite serves it). */
  staticDir?: string;
  /** Folder with built-in .siq packs. */
  packsDir?: string;
  /** Where extracted media and uploads go. */
  dataDir?: string;
  log?: (msg: string) => void;
  /** Room lifetimes (tests shorten them): empty room, room that never starts a game, check interval. */
  roomLimits?: { emptyMs?: number; lobbyMs?: number; sweepMs?: number };
  /** Keep people and rooms in <dataDir> so a restart doesn't end the games. */
  persist?: boolean;
  /** How often changed rooms are written to disk, ms. */
  saveMs?: number;
  /** Behind a reverse proxy: take the client's address from X-Forwarded-For. */
  trustProxy?: boolean;
  /** Connections allowed from one address. */
  maxPerIp?: number;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
  ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Messages from one connection: a bucket of RATE_BURST that refills at RATE_PER_SEC. */
const RATE_BURST = 40;
const RATE_PER_SEC = 15;
/** Signalling and "which files I have" come in bursts while browsers connect: a bucket of their own. */
const P2P_BURST = 400;
const P2P_PER_SEC = 100;
/** Sockets that don't answer a ping within this time are dropped. */
const PING_MS = 30_000;
/** People who were away this long and sit in no room are forgotten. */
const FORGET_USER_MS = 14 * 24 * 3600_000;


/** Writes a file whole or not at all: a crash mid-write leaves the old version. */
async function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}
function writeAtomicSync(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

interface SavedUser { id: string; token: string; name: string; avatar?: string; avatarMime?: string; gender?: "m" | "f"; roomId?: string; seen: number }


export async function startServer(opts: ServerOptions = {}) {
  const log = opts.log ?? ((m: string) => console.log(`[kvz] ${m}`));
  const dataDir = opts.dataDir ?? join(tmpdir(), "kvizorium");
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  const avatarDir = join(dataDir, "avatars");
  const roomDir = join(dataDir, "rooms");
  mkdirSync(avatarDir, { recursive: true });
  if (opts.persist) mkdirSync(roomDir, { recursive: true });

  const users = new Map<string, User>(); // by id
  const byToken = new Map<string, User>();
  const sockets = new Map<string, WebSocket>();
  /** Avatars are files on disk; this keeps their type. */
  const avatarMime = new Map<string, string>();
  const rooms = new Map<string, Room>();
  const seen = new Map<string, number>();

  /* ---- built-in packs ---- */
  const demoPacks: { id: string; name: string; file: string; hash: string }[] = [];
  if (opts.packsDir && existsSync(opts.packsDir)) {
    for (const f of readdirSync(opts.packsDir).filter((x) => x.toLowerCase().endsWith(".siq"))) {
      try {
        const loaded = await loadPack(readFileSync(join(opts.packsDir, f)), dataDir);
        demoPacks.push({ id: f, name: loaded.info.name, file: join(opts.packsDir, f), hash: loaded.hash });
      } catch (e) {
        log(`не удалось прочитать ${f}: ${(e as Error).message}`);
      }
    }
  }
  const packsByHash = new Map<string, LoadedPack>();

  /** A pack no room plays any more: out of memory and off the disk (built-in packs stay). */
  function releasePack(hash?: string) {
    if (!hash || demoPacks.some((d) => d.hash === hash)) return;
    for (const r of rooms.values()) if (r.pack?.hash === hash) return;
    packsByHash.delete(hash);
    forgetPack(hash, dataDir).catch((e) => log(`не удалось удалить пак ${hash}: ${(e as Error).message}`));
  }
  function usePack(room: Room, pack: LoadedPack) {
    const old = room.pack?.hash;
    packsByHash.set(pack.hash, pack);
    room.setPack(pack);
    if (old !== pack.hash) releasePack(old);
  }

  /* ---- room list subscribers ---- */
  let roomsTimer: ReturnType<typeof setTimeout> | undefined;
  const summaries = (): RoomSummary[] => [...rooms.values()].map((r) => r.summary());
  const stats = new Stats(dataDir);
  const sendStats = () => { const s = stats.view(); for (const u of users.values()) if (u.online && !u.roomId) u.send({ t: "stats", stats: s }); };
  const hub = {
    user: (id: string) => users.get(id),
    gameEnded(r: Room) {
      if (!r.pack) return;
      const top = [...r.players].sort((a, b) => b.score - a.score)[0];
      r.statsEntry = stats.gameOver({
        id: r.id, hash: r.pack.hash, packName: r.pack.info.name, questions: r.pack.info.questions, hidden: r.settings.anonPack && !r.isPackRevealed(),
        roomName: r.name, winner: top ? r.name_(top.id) : undefined, winnerScore: top?.score, players: r.players.length, startedAt: r.startedAt,
      });
      sendStats();
    },
    packShown(r: Room) {
      if (r.statsEntry && r.pack) stats.reveal(r.statsEntry, r.pack.info.name, r.pack.info.questions);
      sendStats();
    },
    roomsChanged() {
      if (roomsTimer) return;
      roomsTimer = setTimeout(() => {
        roomsTimer = undefined;
        const list = summaries();
        for (const u of users.values()) if (u.online && !u.roomId) u.send({ t: "rooms", rooms: list });
      }, 250);
    },
  };

  function makeCode(): string {
    for (;;) {
      let c = "";
      for (let i = 0; i < 4; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!rooms.has(c)) return c;
    }
  }

  function setAvatar(user: User, dataUrl: string | null | undefined) {
    if (dataUrl === null) {
      avatarMime.delete(user.id);
      rmSync(join(avatarDir, user.id), { force: true });
      user.avatar = undefined;
      usersDirty = true;
      return null;
    }
    if (!dataUrl) return null;
    const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(dataUrl);
    if (!m) return text("err.avatarType");
    const data = Buffer.from(m[2], "base64");
    if (data.length > 2.5 * 1024 * 1024) return text("err.avatarSize");
    writeFileSync(join(avatarDir, user.id), data);
    avatarMime.set(user.id, m[1]);
    user.avatar = `/avatar/${user.id}?v=${Date.now().toString(36)}`;
    usersDirty = true;
    return null;
  }

  function roomOf(user: User) { return user.roomId ? rooms.get(user.roomId) : undefined; }

  /* ---- messages ---- */
  function handle(user: User, msg: ClientMsg) {
    const room = roomOf(user);
    const err = (e: Text | string | null | undefined | void) => { if (e) user.send(errorMsg(e)); };
    switch (msg.t) {
      case "profile": {
        if (msg.name?.trim()) user.name = msg.name.trim().slice(0, 24);
        if (msg.gender !== undefined) user.gender = msg.gender === "m" || msg.gender === "f" ? msg.gender : undefined;
        usersDirty = true;
        err(setAvatar(user, msg.avatar));
        user.send({ t: "welcome", you: { id: user.id, name: user.name, avatar: user.avatar }, demoPacks: demoPacks.map(({ id, name }) => ({ id, name })) });
        room?.changed();
        return;
      }
      case "listRooms":
        user.send({ t: "stats", stats: stats.view() });
        return user.send({ t: "rooms", rooms: summaries() });
      case "createRoom": {
        room?.leave(user);
        const id = makeCode();
        const r = new Room(id, hub, user, msg);
        rooms.set(id, r);
        log(`комната ${id} «${r.name}» от ${user.name}`);
        return err(r.join(user, msg.password, !!r.hostId));
      }
      case "joinRoom": {
        const target = rooms.get(msg.roomId.toUpperCase().trim());
        if (!target) return err(text("err.roomNotFound"));
        if (room && room !== target) room.leave(user);
        return err(target.join(user, msg.password, msg.asViewer));
      }
      case "leaveRoom": {
        room?.leave(user);
        // The last one out with the button: nobody to wait for, the room goes at once.
        if (room && !room.members.size) closeRoom(room.id, room, "все вышли");
        user.send({ t: "left" });
        return user.send({ t: "rooms", rooms: summaries() });
      }
    }
    if (!room) return err(text("err.notInRoom"));
    handleRoomMsg(room, user, msg, packHooks);
  }

  /** Packs: built-in ones from disk, shared ones from the leader's browser. */
  const packHooks: PackHooks = {
    useDemoPack(room, _user, id, err) {
      const d = demoPacks.find((p) => p.id === id);
      if (!d) return err(text("err.noSuchPack"));
      loadPack(readFileSync(d.file), dataDir).then((p) => usePack(room, p), (e) => err((e as Error).message));
    },
    sharePack(room, _user, msg, err) {
      loadSharedPack(msg.xml, msg.files, dataDir).then((p) => {
        if (rooms.get(room.id) !== room || room.phase !== "lobby") return releasePack(p.hash);
        usePack(room, p);
      }, (e: Error) => err(e.message === "too big" ? text("err.packSize") : e.message === "bad share" ? text("err.badShare") : e.message));
    },
  };

  /* ---- HTTP ---- */
  function send(res: ServerResponse, status: number, body: string | object, type = "application/json; charset=utf-8") {
    res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  function serveFile(req: IncomingMessage, res: ServerResponse, file: string, cache = "public, max-age=31536000, immutable") {
    let st;
    try { st = statSync(file); } catch { return send(res, 404, { error: "Нет файла" }); }
    if (!st.isFile()) return send(res, 404, { error: "Нет файла" });
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    const headers: Record<string, string | number> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": cache, "Access-Control-Allow-Origin": "*" };
    if (range) {
      const start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || start < 0) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": st.size });
    createReadStream(file).pipe(res);
  }


  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-kvz-token", "Access-Control-Allow-Methods": "GET, POST" });
      return res.end();
    }
    if (path === "/api/health") return send(res, 200, { ok: true, rooms: rooms.size, users: users.size });
    const av = /^\/avatar\/([\w-]+)$/.exec(path);
    if (av) {
      const mime = avatarMime.get(av[1]);
      if (!mime) return send(res, 404, { error: "Нет аватара" });
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*" });
      return createReadStream(join(avatarDir, av[1])).on("error", () => res.end()).pipe(res);
    }
    const dl = /^\/download\/([0-9a-f]{16})$/.exec(path);
    if (dl) {
      const file = join(dataDir, "packs", `${dl[1]}.siq`);
      // Only after a game with this pack is over: during play the file would give the answers away.
      if (![...rooms.values()].some((r) => r.pack?.hash === dl[1] && r.phase === "gameOver")) return send(res, 403, { error: "Пак можно скачать после игры" });
      if (!existsSync(file)) return send(res, 404, { error: "Нет пака" });
      const name = (packsByHash.get(dl[1])?.info.name ?? "pack").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 100);
      res.setHeader("Content-Disposition", `attachment; filename="pack.siq"; filename*=UTF-8''${encodeURIComponent(name)}.siq`);
      return serveFile(req, res, file, "no-cache");
    }
    const hm = /^\/media\/x\/([0-9a-f]{32})$/.exec(path);
    if (hm) {
      const file = hiddenMediaFile(hm[1]);
      return file ? serveFile(req, res, file) : send(res, 404, { error: "Не найдено" });
    }
    const md = /^\/media\/([0-9a-f]{16})\/(.+)$/.exec(path);
    if (md) {
      const archivePath = md[2].split("/").map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).join("/");
      const file = diskPathFor(join(dataDir, "packs", md[1]), archivePath);
      return file ? serveFile(req, res, file) : send(res, 400, { error: "Плохой путь" });
    }
    if (opts.staticDir && existsSync(opts.staticDir)) {
      const root = resolve(opts.staticDir);
      let file = resolve(root, "." + decodeURIComponent(path));
      if (!file.startsWith(root + sep) && file !== root) return send(res, 400, { error: "Плохой путь" });
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
      return serveFile(req, res, file, file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable");
    }
    send(res, 404, { error: "Не найдено" });
  });

  /* ---- WebSocket ---- */
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 4 * 1024 * 1024,
    // Compression with a small window: room snapshots shrink several times, and each connection
    // keeps about 20 KB for it instead of the default ~300 KB.
    perMessageDeflate: {
      serverMaxWindowBits: 10,
      clientMaxWindowBits: 10,
      zlibDeflateOptions: { level: 3, memLevel: 4 },
      threshold: 1024,
      concurrencyLimit: 8,
    },
  });
  // ws re-emits the HTTP server's errors (e.g. port in use); the listen() promise below reports them.
  wss.on("error", () => {});
  const perIp = new Map<string, number>();
  const maxPerIp = opts.maxPerIp ?? 20;
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on("connection", (ws, req) => {
    const fwd = opts.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    const ip = fwd || req.socket.remoteAddress || "?";
    const count = (perIp.get(ip) ?? 0) + 1;
    if (count > maxPerIp) {
      ws.send(JSON.stringify(errorMsg(text("err.tooManyConnections"))));
      return ws.close(4029, "too many connections");
    }
    perIp.set(ip, count);
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    // Token bucket: bursts are fine, a flood is dropped.
    let tokens = RATE_BURST;
    let p2pTokens = P2P_BURST;
    let refilled = Date.now();
    let warned = 0;
    let user: User | undefined;
    ws.on("message", (raw) => {
      const now = Date.now();
      const dt = (now - refilled) / 1000;
      tokens = Math.min(RATE_BURST, tokens + dt * RATE_PER_SEC);
      p2pTokens = Math.min(P2P_BURST, p2pTokens + dt * P2P_PER_SEC);
      refilled = now;
      let msg: ClientMsg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const p2p = msg?.t === "rtc" || msg?.t === "have";
      if ((p2p ? p2pTokens : tokens) < 1) {
        if (user && !p2p && now - warned > 5000) { warned = now; user.send(errorMsg(text("err.slowDown"))); }
        return;
      }
      if (p2p) p2pTokens--; else tokens--;
      if (!user) {
        if (msg.t !== "hello" || typeof msg.token !== "string" || msg.token.length < 16) return ws.close(4000, "hello first");
        user = byToken.get(msg.token);
        if (!user) {
          const u: User = { id: randomUUID().slice(0, 12), token: msg.token, name: "Игрок", online: true, lastChat: 0, send: () => {} };
          users.set(u.id, u);
          byToken.set(u.token, u);
          user = u;
          usersDirty = true;
        }
        const me = user;
        sockets.get(me.id)?.close(4001, "Вы зашли с другого устройства");
        sockets.set(me.id, ws);
        me.online = true;
        me.send = (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
        if (msg.name?.trim()) me.name = msg.name.trim().slice(0, 24);
        if (msg.gender === "m" || msg.gender === "f") me.gender = msg.gender;
        if (msg.avatar) setAvatar(me, msg.avatar);
        me.send({ t: "welcome", you: { id: me.id, name: me.name, avatar: me.avatar }, demoPacks: demoPacks.map(({ id, name }) => ({ id, name })) });
        const r = roomOf(me);
        if (r) { r.join(me); } else me.send({ t: "rooms", rooms: summaries() });
        return;
      }
      try { handle(user, msg); } catch (e) { log(`ошибка: ${(e as Error).stack}`); user.send(errorMsg(text("err.server"))); }
    });
    ws.on("close", () => {
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left > 0) perIp.set(ip, left); else perIp.delete(ip);
      if (user) { seen.set(user.id, Date.now()); usersDirty = true; }
      if (!user || sockets.get(user.id) !== ws) return;
      sockets.delete(user.id);
      user.online = false;
      user.send = () => {};
      roomOf(user)?.connectionChanged(user.id);
    });
  });

  /* ---- cleanup of empty rooms ---- */
  // Rooms close when empty for 5 minutes, or when no game starts within 20 minutes.
  const limits = { emptyMs: 5 * 60_000, lobbyMs: 20 * 60_000, sweepMs: 10_000, ...opts.roomLimits };
  const closeRoom = (id: string, r: Room, why: string, reason?: Text) => {
    r.dispose();
    rooms.delete(id);
    releasePack(r.pack?.hash);
    if (opts.persist) { saved.delete(id); void rm(join(roomDir, `${id}.json`), { force: true }); }
    for (const uid of r.members) {
      const u = users.get(uid);
      if (u?.roomId !== id) continue;
      u.roomId = undefined;
      if (reason) { u.send({ t: "left", reason: formatText("ru", reason), text: reason }); u.send({ t: "rooms", rooms: summaries() }); }
    }
    log(`комната ${id} закрыта: ${why}`);
    hub.roomsChanged();
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, r] of rooms) {
      r.sweepOffline(now);
      if (r.phase === "lobby" && now - r.lobbySince > limits.lobbyMs) { closeRoom(id, r, "игру не начали", text("left.expiredLobby")); continue; }
      if (r.onlineMembers().length) { r.emptySince = 0; continue; }
      if (!r.emptySince) r.emptySince = now;
      else if (now - r.emptySince > limits.emptyMs) closeRoom(id, r, "пустая");
    }
    // People long gone and in no room are forgotten.
    for (const [uid, u] of users) {
      if (u.online || u.roomId || now - (seen.get(uid) ?? now) < FORGET_USER_MS) continue;
      users.delete(uid);
      byToken.delete(u.token);
      seen.delete(uid);
      if (avatarMime.delete(uid)) rmSync(join(avatarDir, uid), { force: true });
      usersDirty = true;
    }
  }, limits.sweepMs);

  // Dead connections (a laptop lid closed, a dropped network) don't say goodbye: ping them.
  const pinger = setInterval(() => {
    for (const c of wss.clients) {
      if (alive.get(c) === false) { c.terminate(); continue; }
      alive.set(c, false);
      try { c.ping(); } catch { /* closing anyway */ }
    }
  }, PING_MS);

  /* ---- saving across restarts ---- */
  let usersDirty = false;
  const saved = new Map<string, number>(); // room id -> rev on disk
  const usersFile = join(dataDir, "users.json");
  const usersJson = () => JSON.stringify([...users.values()].map((u): SavedUser => ({
    id: u.id, token: u.token, name: u.name, avatar: u.avatar, avatarMime: avatarMime.get(u.id), gender: u.gender, roomId: u.roomId,
    seen: u.online ? Date.now() : seen.get(u.id) ?? Date.now(),
  })));
  let saving = false;
  async function saveState() {
    if (!opts.persist || saving) return;
    saving = true;
    try {
      // Who sits in which room changes with the rooms: people are saved along with them.
      if (usersDirty || [...rooms].some(([id, r]) => saved.get(id) !== r.rev)) { usersDirty = false; await writeAtomic(usersFile, usersJson()); }
      for (const [id, r] of rooms) {
        if (saved.get(id) === r.rev) continue;
        const rev = r.rev;
        await writeAtomic(join(roomDir, `${id}.json`), JSON.stringify(r.snapshot()));
        saved.set(id, rev);
      }
    } catch (e) {
      log(`не удалось сохранить состояние: ${(e as Error).message}`);
    } finally {
      saving = false;
    }
  }
  function saveStateSync() {
    if (!opts.persist) return;
    try {
      writeAtomicSync(usersFile, usersJson());
      for (const [id, r] of rooms) if (saved.get(id) !== r.rev) writeAtomicSync(join(roomDir, `${id}.json`), JSON.stringify(r.snapshot()));
    } catch (e) {
      log(`не удалось сохранить состояние: ${(e as Error).message}`);
    }
  }
  const saver = opts.persist ? setInterval(() => void saveState(), opts.saveMs ?? 15_000) : undefined;

  if (opts.persist) await restoreState();
  /** People and rooms from the last run; packs no room needs are deleted. */
  async function restoreState() {
    try {
      if (existsSync(usersFile)) {
        for (const s of JSON.parse(readFileSync(usersFile, "utf8")) as SavedUser[]) {
          const u: User = { id: s.id, token: s.token, name: s.name, avatar: s.avatar, gender: s.gender, roomId: s.roomId, online: false, lastChat: 0, send: () => {} };
          users.set(u.id, u);
          byToken.set(u.token, u);
          seen.set(u.id, s.seen);
          if (s.avatarMime && existsSync(join(avatarDir, u.id))) avatarMime.set(u.id, s.avatarMime);
          else u.avatar = undefined;
        }
      }
    } catch (e) {
      log(`не удалось прочитать людей: ${(e as Error).message}`);
    }
    for (const f of readdirSync(roomDir).filter((x) => x.endsWith(".json"))) {
      const file = join(roomDir, f);
      try {
        const snap = JSON.parse(readFileSync(file, "utf8")) as RoomSnapshot;
        let pack: LoadedPack | undefined;
        const archive = snap.packHash && join(dataDir, "packs", `${snap.packHash}.siq`);
        const sharedFile = snap.packHash && join(dataDir, "packs", `${snap.packHash}.json`);
        if (archive && existsSync(archive)) pack = await loadPack(readFileSync(archive), dataDir);
        else if (sharedFile && existsSync(sharedFile)) {
          const d = JSON.parse(readFileSync(sharedFile, "utf8")) as { xml: string; files: SharedFile[] };
          pack = await loadSharedPack(d.xml, d.files, dataDir);
        }
        if (pack) packsByHash.set(pack.hash, pack);
        const r = Room.restore(snap, hub, pack);
        rooms.set(r.id, r);
        saved.set(r.id, r.rev);
      } catch (e) {
        log(`комнату из ${f} не удалось вернуть: ${(e as Error).message}`);
        rmSync(file, { force: true });
      }
    }
    // People whose room is gone are simply out of it.
    for (const u of users.values()) if (u.roomId && !rooms.has(u.roomId)) u.roomId = undefined;
    // Packs nobody uses (left over from a crash) are deleted.
    const keep = new Set([...demoPacks.map((d) => d.hash), ...[...rooms.values()].map((r) => r.pack?.hash)]);
    const packsDir = join(dataDir, "packs");
    if (existsSync(packsDir)) {
      for (const f of readdirSync(packsDir)) {
        const hash = f.replace(/\.(siq|json)$/, "");
        if (/^[0-9a-f]{16}$/.test(hash) && !keep.has(hash)) void forgetPack(hash, dataDir);
      }
    }
    if (rooms.size) log(`возвращено комнат: ${rooms.size}`);
  }

  try {
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(opts.port ?? 8787, opts.host ?? "0.0.0.0", () => { server.off("error", fail); ok(); });
    });
  } catch (e) {
    clearInterval(sweep);
    clearInterval(pinger);
    clearInterval(saver);
    wss.close();
    throw e;
  }
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 8787;
  log(`сервер на http://localhost:${port} · встроенных паков: ${demoPacks.length}`);

  return {
    port,
    close: () => new Promise<void>((ok) => {
      clearInterval(sweep);
      clearInterval(pinger);
      clearInterval(saver);
      // Rooms go to disk before the timers stop, so their countdowns come back as they were.
      saveStateSync();
      stats.flush();
      for (const r of rooms.values()) r.dispose();
      // Open sockets would keep the server from closing.
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close(() => ok());
      server.closeAllConnections?.();
    }),
  };
}
