import type { MediaKind, Question, Round } from "@kvz/siq";
import {
  answerMatches,
  DEFAULT_SETTINGS,
  SETTING_LIMITS,
  formatText,
  text as tx,
  type ChatItem,
  MULTIPLIERS,
  type Multiplier,
  type PackInfo,
  type HostAction,
  type Phase,
  type QuestionKind,
  type Role,
  type RoomSummary,
  type RoomView,
  type ServerMsg,
  type ShareView,
  type Settings,
  type Text,
  type TextKey,
  type TextParams,
  type TimerView,
  parsePoint,
  pointHits,
  pointLabel,
  POINT_DEVIATION,
} from "@kvz/protocol";
import type { LoadedPack } from "./pack.ts";

/** Random hex, the same in Node and in a browser. */
const randomHex = (bytes: number) => [...globalThis.crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export interface User {
  id: string;
  token: string;
  name: string;
  avatar?: string;
  gender?: "m" | "f";
  online: boolean;
  roomId?: string;
  lastChat: number;
  send(msg: ServerMsg): void;
}

export interface Hub {
  user(id: string): User | undefined;
  roomsChanged(): void;
  /** A game ended / an anonymous pack was shown: for the games page statistics. */
  gameEnded?(room: Room): void;
  packShown?(room: Room): void;
}

interface PlayerState { id: string; score: number; ready: boolean }

interface QState {
  t: number;
  i: number;
  data: Question;
  theme: string;
  price: number;
  kind: QuestionKind;
  stage: "reading" | "open" | "answering" | "judging" | "reveal";
  answeringId?: string;
  typed: string;
  submitted: boolean;
  wrong: Set<string>;
  passed?: Set<string>;
  /** Select questions: options already answered wrong. */
  wrongOptions?: Set<string>;
  /** Point questions: clicks already judged. */
  pointTries?: { id: string; x: number; y: number; correct: boolean }[];
  soloId?: string;
  openedAt?: number;
  thinkLeft?: number;
  lastResult?: { playerId: string; correct: boolean; delta: number; mult?: number };
  /** Scored at 0 by the host. */
  zero?: Set<string>;
  /** Waiting for these people's browsers to load the media before the reading starts. */
  loading?: Set<string>;
  loadTotal?: number;
  /** "For everyone": answers by player, judgements, and score changes. */
  all?: Map<string, { text: string; done: boolean }>;
  allJudged?: Map<string, boolean>;
  allDelta?: Map<string, number>;
  allMult?: Map<string, Multiplier>;
  /** "Stake for everyone": secret stakes by player; only they answer. */
  stakes?: Map<string, number>;
}

interface StakeState { nominal: number; value: number; leaderId?: string; passed: Set<string>; allIn: boolean; order: string[]; turnId?: string }
interface SecretState { giverId: string; recipientId?: string; candidates: string[]; theme: string; price: number; priceChoice?: { min: number; max: number; step: number } }
interface FinalState {
  themes: { name: string; removed: boolean; qIndex: number }[];
  participants: string[];
  order: string[];
  turn: number;
  stakes: Map<string, number>;
  answers: Map<string, { text: string; done: boolean }>;
  judged: Map<string, boolean>;
}

/**
 * What a timer does when it runs out, by name (not a closure): a room can then be saved to disk
 * and brought back after a server restart with its countdown still going.
 */
type TimerFn =
  | "introDone" | "startReading" | "openButtons" | "forAllJudge" | "noAnswer" | "answerTimeout" | "stakeAllDone"
  | "afterQuestion" | "randomPick" | "autoBid" | "autoGive" | "autoPrice" | "finalAutoRemove" | "finalStakesDone"
  | "finalJudgePhase" | "afterFinal";
interface TimerAct { fn: TimerFn; args?: (string | number | boolean | null)[] }
interface TimerState { kind: TimerView["kind"]; endsAt: number; duration: number; act: TimerAct; handle?: ReturnType<typeof setTimeout>; pausedLeft?: number }

/** A room saved to disk (JSON): see `Room.snapshot` / `Room.restore`. */
export interface RoomSnapshot { v: 1; savedAt: number; packHash?: string; data: Record<string, unknown> }

/** Sets and Maps survive JSON as `{$set: [...]}` / `{$map: [[k, v], ...]}`. */
function encode(v: unknown): unknown {
  if (v instanceof Set) return { $set: [...v].map(encode) };
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [encode(k), encode(x)]) };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
}
function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.$set)) return new Set(o.$set.map(decode));
    if (Array.isArray(o.$map)) return new Map((o.$map as [unknown, unknown][]).map(([k, x]) => [decode(k), decode(x)]));
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}

/** Room fields kept across a restart (the pack, the question's data and the timer are rebuilt). */
const SAVED_FIELDS = [
  "name", "password", "settings", "ownerId", "hostId", "players", "viewers", "members", "phase", "paused", "roundIdx",
  "played", "chooserId", "roundEndsAt", "stake", "secret", "final", "hostLine", "chat", "emptySince", "createdAt", "voiceUrl",
  "startedAt", "packAlias", "chatSeq", "banned", "finalsPlayed", "packRevealed", "statsEntry", "lobbySince", "stakeAllParticipants", "leaving",
] as const;
/** Extra seconds on a countdown after a restart, so people have time to reconnect. */
const RESTORE_GRACE = 5;
/** A player offline this long gives up their seat (see sweepOffline). */
export const OFFLINE_LOBBY_MS = 30_000;
export const OFFLINE_GAME_MS = 120_000;

/** Seconds to wait for slow browsers to load a question's media. */
const LOAD_WAIT = 8;
/** Video and sound are bigger and may still be on their way from the leader's browser: wait longer. */
const CLIP_WAIT = 30;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

function questionKind(q: Question): QuestionKind {
  switch (q.type) {
    case "stake": return "stake";
    case "secret":
    case "secretPublicPrice": return "secret";
    case "secretNoQuestion": return "secretNoQuestion";
    case "noRisk": return "noRisk";
    case "forAll": return "forAll";
    case "stakeAll": return "stakeAll";
    default: return "simple";
  }
}

export class Room {
  name: string;
  password?: string;
  settings: Settings;
  ownerId: string;
  hostId?: string;
  players: PlayerState[] = [];
  viewers = new Set<string>();
  members = new Set<string>();
  pack?: LoadedPack;
  packLoading?: Text;
  phase: Phase = "lobby";
  paused = false;
  roundIdx = -1;
  played = new Set<string>();
  chooserId?: string;
  roundEndsAt?: number;
  q?: QState;
  stake?: StakeState;
  secret?: SecretState;
  final?: FinalState;
  timer?: TimerState;
  hostLine: Text = tx("host.waiting");
  chat: ChatItem[] = [];
  emptySince = 0;
  readonly createdAt = Date.now();
  voiceUrl?: string;
  startedAt?: number;
  /** What players see instead of an anonymous pack's name. */
  private readonly packAlias = "pack-" + randomHex(4);
  private chatSeq = 0;
  private lockUntil = new Map<string, number>();
  private dirty = false;
  /** Grows with every change: the server saves rooms whose `rev` moved since the last save. */
  rev = 0;
  /** Round -> who has downloaded its media; the round whose next round was already sent for download. */
  private preloadedBy = new Map<number, Set<string>>();
  private nextPreloadFor = -1;
  private mediaCache = new Map<string, string[]>();
  /** Shared pack: which files each member's browser has. */
  private haves = new Map<string, Set<number>>();

  constructor(readonly id: string, private hub: Hub, owner: User, opts: { name: string; password?: string; settings: Partial<Settings>; asHost: boolean }) {
    this.name = opts.name.trim().slice(0, 40) || `Комната ${owner.name}`;
    this.password = opts.password?.trim() || undefined;
    this.settings = { ...DEFAULT_SETTINGS };
    this.applySettings(opts.settings);
    this.ownerId = owner.id;
    if (opts.asHost) this.hostId = owner.id;
    this.syncHostMode();
    this.feed("info", "ev.created", { name: owner.name, room: this.name });
  }

  /* ---------- membership ---------- */

  name_(id?: string): string {
    return (id && this.hub.user(id)?.name) || "Игрок";
  }
  player(id?: string) { return this.players.find((p) => p.id === id); }
  isPlayer(id: string) { return this.players.some((p) => p.id === id); }
  roleOf(id: string): Role { return this.hostId === id ? "host" : this.isPlayer(id) ? "player" : "viewer"; }
  hostOnline() { return !!this.hostId && !!this.hub.user(this.hostId)?.online && this.members.has(this.hostId); }
  /** Who runs the game (scores, pause, board): the host; while there is none online, the leader. */
  canHost(id: string) { return this.hostOnline() ? this.hostId === id : this.isLeader(id); }
  /** Nobody in the host's seat: the server checks the answers itself. */
  autoJudge() { return !this.hostOnline(); }
  /** The leader: the creator while here; otherwise the host, then the first player online. */
  leaderId(): string {
    const here = (id?: string) => !!id && this.members.has(id) && !!this.hub.user(id)?.online;
    if (here(this.ownerId)) return this.ownerId;
    if (here(this.hostId)) return this.hostId!;
    return this.players.find((p) => here(p.id))?.id ?? [...this.members].find((m) => here(m)) ?? this.ownerId;
  }
  isLeader(id: string) { return this.leaderId() === id; }
  /** `hostMode` only reports whether a person sits in the host's seat. */
  private syncHostMode() { this.settings.hostMode = this.hostId ? "human" : "auto"; }
  private banned = new Set<string>();
  onlineMembers() { return [...this.members].filter((id) => this.hub.user(id)?.online); }

  join(user: User, password?: string, asViewer?: boolean): Text | null {
    if (this.banned.has(user.id)) return tx("err.banned");
    const known = this.isPlayer(user.id) || this.hostId === user.id || this.ownerId === user.id || this.viewers.has(user.id);
    if (this.password && !known && password !== this.password) return tx("err.password");
    if (!this.isPlayer(user.id) && this.hostId !== user.id) {
      const seat = !asViewer && this.phase === "lobby" && this.players.length < this.settings.maxPlayers;
      if (!seat && !this.settings.allowViewers && !known) return tx(this.phase === "lobby" ? "err.noViewersLobby" : "err.noViewersGame");
      if (seat) {
        this.players.push({ id: user.id, score: 0, ready: false });
        this.viewers.delete(user.id);
      } else this.viewers.add(user.id);
    }
    const isNew = !this.members.has(user.id);
    this.members.add(user.id);
    user.roomId = this.id;
    if (isNew) {
      const role = this.roleOf(user.id);
      this.feed("info", role === "viewer" ? "ev.joinViewer" : role === "host" ? "ev.joinHost" : "ev.joinPlayer", { name: user.name });
    }
    user.send({ t: "chat", items: this.chat, reset: true });
    user.send(this.swarmMsg());
    this.sendPreload(user.id);
    this.changed();
    return null;
  }

  leave(user: User, kicked = false) {
    this.dropHave(user.id);
    this.standUp(user.id);
    this.vacateHost(user.id);
    this.viewers.delete(user.id);
    this.members.delete(user.id);
    if (user.roomId === this.id) user.roomId = undefined;
    this.feed("info", kicked ? "ev.kicked" : "ev.left", { name: user.name });
    this.changed();
  }

  /**
   * Whoever leaves the room leaves the table too, and the seat stays free. A player in the middle
   * of something (answering, a stake) stands up as soon as it's over.
   */
  private standUp(id: string) {
    if (!this.isPlayer(id)) return;
    if (this.phase !== "lobby" && this.busyWith(id)) { this.leaving.add(id); return; }
    this.leaving.delete(id);
    this.players = this.players.filter((p) => p.id !== id);
    if (this.chooserId === id) this.chooserId = this.players[0]?.id;
  }
  /**
   * The host left the room (or was away too long): the seat is free, and anyone may take it, whatever
   * the room's setting was. Until then the game goes on with the automatic host, and an answer that
   * waited for the host's word is checked against the pack.
   */
  private vacateHost(id: string) {
    if (this.hostId !== id) return;
    this.hostId = undefined;
    this.syncHostMode();
    this.settings.openHost = true;
    this.feed("info", "ev.hostLeft", { name: this.name_(id) });
    const q = this.q;
    if (this.phase === "question" && q?.stage === "answering" && q.submitted && q.answeringId) this.applyJudgement(this.isRight(q.typed));
    else if (this.phase === "question" && q?.stage === "judging" && q.all) {
      for (const p of this.allAnswering()) if (!q.allJudged!.has(p.id)) q.allJudged!.set(p.id, this.isRight(q.all.get(p.id)?.text ?? ""));
      this.forAllApply();
    }
  }

  /** Players who left while busy, waiting to stand up. */
  private leaving = new Set<string>();
  /** When each member was first seen offline. */
  private offSince = new Map<string, number>();

  /**
   * Called every few seconds by whoever keeps the room. Someone offline for long (a closed tab
   * doesn't say goodbye) leaves the room: a player's seat is free again, the host's seat too, and a
   * viewer is off the list. A player waiting in the lobby goes after OFFLINE_LOBBY_MS, anyone else
   * after OFFLINE_GAME_MS. A reload or a short drop is well within that.
   */
  sweepOffline(now = Date.now()) {
    let changed = false;
    for (const id of [...this.leaving]) {
      if (this.members.has(id) || !this.isPlayer(id)) { this.leaving.delete(id); continue; }
      if (this.busyWith(id)) continue;
      this.standUp(id);
      changed = true;
    }
    for (const id of [...this.offSince.keys()]) if (!this.members.has(id)) this.offSince.delete(id);
    for (const id of this.members) {
      const u = this.hub.user(id);
      if (u?.online) { this.offSince.delete(id); continue; }
      const since = this.offSince.get(id);
      if (since == null) { this.offSince.set(id, now); continue; }
      const limit = this.phase === "lobby" && this.isPlayer(id) ? OFFLINE_LOBBY_MS : OFFLINE_GAME_MS;
      if (now - since < limit) continue;
      if (this.phase !== "lobby" && this.busyWith(id)) continue;
      this.offSince.delete(id);
      this.dropHave(id);
      this.standUp(id);
      this.vacateHost(id);
      this.viewers.delete(id);
      this.members.delete(id);
      if (u && u.roomId === this.id) u.roomId = undefined;
      this.feed("info", "ev.left", { name: this.name_(id) });
      changed = true;
    }
    if (changed) this.changed();
  }

  /** Someone's connection dropped or came back; a dropped browser no longer shares files. */
  connectionChanged(id?: string) {
    if (id && !this.hub.user(id)?.online) this.dropHave(id);
    this.changed();
  }

  /* ---------- lobby ---------- */

  applySettings(s: Partial<Settings>) {
    const cur = this.settings;
    const inLobby = this.phase === "lobby";
    for (const key of Object.keys(SETTING_LIMITS) as (keyof typeof SETTING_LIMITS)[]) {
      const v = s[key];
      if (v == null || !Number.isFinite(Number(v))) continue;
      if (key === "maxPlayers" && !inLobby) continue;
      const [lo, hi] = SETTING_LIMITS[key];
      cur[key] = clamp(Math.round(Number(v)), lo, hi);
    }
    if (inLobby && cur.maxPlayers < this.players.length) cur.maxPlayers = this.players.length;
    for (const key of ["falseStart", "wrongPenalty", "karaoke", "allowViewers", "oral", "anonPack", "openHost"] as const) if (s[key] != null) cur[key] = !!s[key];
    if (inLobby && (s.gameType === "classic" || s.gameType === "simple")) cur.gameType = s.gameType;
    if (s.finals === "all" || s.finals === "one") cur.finals = s.finals;
  }

  setSettings(by: string, s: Partial<Settings>) {
    if (!this.isLeader(by)) return tx("err.leaderOnly");
    const wasAnon = this.settings.anonPack;
    this.applySettings(s);
    if (this.settings.anonPack && !wasAnon) this.scrubPackName();
    this.changed();
    return null;
  }

  setPack(pack: LoadedPack) {
    this.pack = pack;
    this.mediaCache.clear();
    this.haves.clear();
    const swarm = this.swarmMsg();
    for (const id of this.members) this.hub.user(id)?.send(swarm);
    this.packRevealed = false;
    this.packLoading = undefined;
    if (this.settings.anonPack) this.feed("info", "ev.packLoadedHidden", { count: pack.info.questions });
    else this.feed("info", "ev.packLoaded", { pack: pack.info.name, count: pack.info.questions });
    this.hostLine = tx("host.packReady");
    this.changed();
  }

  /** The pack became anonymous: take its name out of the feed and resend the feed to everyone. */
  private scrubPackName() {
    let touched = false;
    for (const c of this.chat) {
      if (c.line?.key !== "ev.packLoaded") continue;
      c.line = tx("ev.packLoadedHidden", { count: c.line.params?.count });
      c.text = formatText("ru", c.line);
      touched = true;
    }
    if (touched) for (const id of this.members) this.hub.user(id)?.send({ t: "chat", items: this.chat, reset: true });
  }

  /** Pack info as this member may see it: an anonymous pack's name only reaches the host. */
  private packView(role: Role): PackInfo | undefined {
    const info = this.pack?.info;
    if (!info) return undefined;
    // Downloading gives away every answer: only once the game is over. A shared pack isn't on the server.
    const download = this.phase === "gameOver" && !this.pack!.shared ? { downloadUrl: `/download/${this.pack!.hash}` } : {};
    if (!this.settings.anonPack) return { ...info, ...download };
    if (this.packRevealed) return { ...info, ...download, hidden: true, revealed: true };
    if (role === "host") return { ...info, ...download, hidden: true };
    return { name: this.packAlias, authors: [], rounds: info.rounds, questions: info.questions, version: info.version, sizeMb: 0, hidden: true };
  }

  /** After the game, the leader or the host shows the anonymous pack's name and download to everyone. */
  revealPack(by: string) {
    if (!this.isLeader(by) && !this.canHost(by)) return tx("err.leaderOnly");
    if (this.phase !== "gameOver") return tx("err.revealWhen");
    if (!this.pack || this.packRevealed) return null;
    this.packRevealed = true;
    this.feed("info", "ev.packRevealed", { pack: this.pack.info.name });
    this.hub.packShown?.(this);
    this.changed();
    return null;
  }

  setReady(by: string, value: boolean) {
    const p = this.player(by);
    if (!p || this.phase !== "lobby") return;
    p.ready = value;
    this.changed();
  }

  becomePlayer(by: string) {
    if (this.isPlayer(by) || this.hostId === by) return tx("err.seated");
    if (this.players.length >= this.settings.maxPlayers) return tx("err.noSeats");
    this.viewers.delete(by);
    this.players.push({ id: by, score: 0, ready: false });
    this.feed("info", "ev.sits", { name: this.name_(by) });
    this.changed();
    return null;
  }

  /** Host adds an empty table, or removes one together with the player at it. */
  seat(by: string, action: "add" | "remove", playerId?: string) {
    if (!this.isLeader(by)) return tx("err.leaderOnly");
    if (action === "add") {
      if (this.settings.maxPlayers >= 12) return tx("err.maxSeats");
      this.settings.maxPlayers++;
      this.feed("info", "ev.seatAdded");
      this.changed();
      return null;
    }
    if (!playerId) {
      if (this.settings.maxPlayers <= Math.max(1, this.players.length)) return tx("err.noSeats");
      this.settings.maxPlayers--;
      this.changed();
      return null;
    }
    const busy = this.busyWith(playerId);
    if (busy) return busy;
    if (!this.isPlayer(playerId)) return null;
    this.players = this.players.filter((pl) => pl.id !== playerId);
    if (this.members.has(playerId)) this.viewers.add(playerId);
    this.settings.maxPlayers = Math.max(1, this.settings.maxPlayers - 1);
    if (this.chooserId === playerId) this.chooserId = this.players[0]?.id;
    this.feed("info", "ev.seatRemoved", { name: this.name_(playerId) });
    this.changed();
    return null;
  }

  /** Why a player can't leave the table right now (they are in the middle of something), or null. */
  private busyWith(playerId: string): Text | null {
    if (!this.isPlayer(playerId)) return null;
    if (["stake", "secret", "finalThemes", "finalStakes", "finalAnswer", "finalJudge"].includes(this.phase)) return tx("err.waitSpecial");
    if (this.q?.answeringId === playerId || this.q?.soloId === playerId) return tx("err.answering");
    return null;
  }

  /**
   * Leader puts someone in the host's seat. A seated player swaps with the host (the host takes the
   * table and its score); anyone else replaces the host, who goes to the viewers. `null` frees the seat.
   */
  setHost(by: string, id: string | null) {
    if (!this.isLeader(by)) return tx("err.leaderOnly");
    const old = this.hostId;
    if (id === null) {
      if (!old) return null;
      this.hostId = undefined;
      if (this.members.has(old)) this.viewers.add(old);
      this.syncHostMode();
      this.feed("info", "ev.hostLeft", { name: this.name_(old) });
      this.changed();
      return null;
    }
    if (id === old || !this.members.has(id)) return null;
    if (!this.hub.user(id)?.online) return tx("err.offline");
    const seatIdx = this.players.findIndex((pl) => pl.id === id);
    if (seatIdx >= 0) {
      const busy = this.busyWith(id);
      if (busy) return busy;
      if (old) {
        this.players[seatIdx] = { ...this.players[seatIdx], id: old, ready: false };
        if (this.chooserId === id) this.chooserId = old;
      } else {
        this.players.splice(seatIdx, 1);
        if (this.chooserId === id) this.chooserId = this.players[0]?.id;
      }
    } else if (old && this.members.has(old)) this.viewers.add(old);
    this.viewers.delete(id);
    this.hostId = id;
    this.syncHostMode();
    this.feed("info", old && seatIdx >= 0 ? "ev.swapped" : "ev.hostTaken", { host: this.name_(id), name: old && seatIdx >= 0 ? this.name_(old) : this.name_(id) });
    this.changed();
    return null;
  }

  /** Take the free host's seat: viewers any time, seated players before the game. */
  takeHost(by: string) {
    if (this.hostId) return tx("err.hostTaken");
    if (!this.settings.openHost && !this.isLeader(by)) return tx("err.hostClosed");
    if (this.isPlayer(by)) {
      if (this.phase !== "lobby") return tx("err.hostFromTable");
      this.players = this.players.filter((p) => p.id !== by);
      if (this.chooserId === by) this.chooserId = this.players[0]?.id;
    }
    this.viewers.delete(by);
    this.hostId = by;
    this.syncHostMode();
    this.feed("info", "ev.hostTaken", { name: this.name_(by) });
    this.changed();
    return null;
  }

  leaveHost(by: string) {
    if (this.hostId !== by) return null;
    this.hostId = undefined;
    this.viewers.add(by);
    this.syncHostMode();
    this.feed("info", "ev.hostLeft", { name: this.name_(by) });
    this.changed();
    return null;
  }

  /** Leader: the player stands up and watches; the table stays, free. */
  freeSeat(by: string, id: string) {
    if (!this.isLeader(by)) return tx("err.leaderOnly");
    if (!this.isPlayer(id)) return null;
    const busy = this.busyWith(id);
    if (busy) return busy;
    this.players = this.players.filter((p) => p.id !== id);
    if (this.members.has(id)) this.viewers.add(id);
    if (this.chooserId === id) this.chooserId = this.players[0]?.id;
    this.feed("info", "ev.freed", { name: this.name_(id) });
    this.changed();
    return null;
  }

  /** Leader: remove from the room; a player's table goes too. `ban` keeps them out for good. */
  kick(by: string, id: string, ban = false) {
    if (!this.isLeader(by)) return tx("err.leaderOnly");
    if (id === by) return null;
    const busy = this.busyWith(id);
    if (busy) return busy;
    if (this.isPlayer(id)) {
      this.players = this.players.filter((p) => p.id !== id);
      this.settings.maxPlayers = Math.max(1, this.settings.maxPlayers - 1);
      if (this.chooserId === id) this.chooserId = this.players[0]?.id;
    }
    if (this.hostId === id) { this.hostId = undefined; this.syncHostMode(); }
    if (ban) this.banned.add(id);
    this.dropHave(id);
    const u = this.hub.user(id);
    if (u && this.members.has(id)) {
      const why = tx(ban ? "left.banned" : "left.kicked");
      u.send({ t: "left", reason: formatText("ru", why), text: why });
      this.viewers.delete(id);
      this.members.delete(id);
      if (u.roomId === this.id) u.roomId = undefined;
    }
    this.viewers.delete(id);
    this.feed("info", ban ? "ev.banned" : "ev.kicked", { name: this.name_(id) });
    this.changed();
    return null;
  }

  /** Edit mode: take a theme or a question off the board, or bring it back. */
  editBoard(by: string, t: number, i: number | undefined, remove: boolean) {
    if (!this.canHost(by)) return tx("err.editHost");
    if (this.phase !== "choosing" && this.phase !== "roundIntro") return tx("err.editWhen");
    const theme = this.round()?.themes[t];
    if (!theme) return null;
    const idx = i == null ? theme.questions.map((_, k) => k) : [i];
    for (const k of idx) {
      if (!theme.questions[k]) continue;
      if (remove) this.played.add(`${t}:${k}`);
      else this.played.delete(`${t}:${k}`);
    }
    this.feed("info", i == null ? (remove ? "ev.themeOff" : "ev.themeOn") : remove ? "ev.questionOff" : "ev.questionOn", { theme: theme.name, price: i == null ? undefined : theme.questions[i]?.price });
    if (this.phase === "choosing" && !this.roundLeft()) this.nextRound();
    else this.changed();
    return null;
  }

  /** While a question is being chosen, the host hands the turn to another player. */
  setChooser(by: string, playerId: string) {
    if (!this.canHost(by)) return tx("err.chooserHost");
    if (this.phase !== "choosing") return tx("err.chooserWhen");
    if (!this.isPlayer(playerId)) return tx("err.noPlayer");
    if (this.chooserId === playerId) return null;
    this.chooserId = playerId;
    this.feed("pick", "ev.chooserSet", { name: this.name_(playerId) });
    this.enterChoosing();
    return null;
  }

  /** The host shares a voice chat link; only http(s) links are accepted. */
  setVoice(by: string, url: string | null) {
    if (!this.isLeader(by) && !this.canHost(by)) return tx("err.voiceHost");
    const raw = (url ?? "").trim();
    if (!raw) {
      if (this.voiceUrl) this.feed("info", "ev.voiceCleared");
      this.voiceUrl = undefined;
      this.changed();
      return null;
    }
    let parsed: URL;
    try { parsed = new URL(raw); } catch { return tx("err.voiceUrl"); }
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || raw.length > 500) return tx("err.voiceUrl");
    const changedLink = this.voiceUrl !== parsed.href;
    this.voiceUrl = parsed.href;
    if (changedLink) this.feed("info", "ev.voiceSet");
    this.changed();
    return null;
  }

  /** Jump to any round; it always starts from the beginning. */
  setRound(by: string, index: number) {
    if (!this.canHost(by)) return tx("err.roundHost");
    if (this.phase === "lobby") return tx("err.notStarted");
    const r = this.pack?.opened.pack.rounds[index];
    if (!r) return tx("err.noRound");
    this.feed("info", "ev.roundSet", { round: r.name });
    this.startRound(index);
    return null;
  }

  /** Host corrects a judged answer from the feed. */
  fixScore(by: string, chatId: number, mult: Multiplier) {
    if (!this.canHost(by)) return tx("err.fixHost");
    if (!MULTIPLIERS.includes(mult)) return tx("err.fixNot");
    const item = this.chat.find((c) => c.id === chatId);
    const f = item?.fix;
    if (!item || !f) return tx("err.fixNot");
    const p = this.player(f.playerId);
    if (!p) return tx("err.fixGone");
    const next = Math.round(f.price * mult);
    if (next === f.delta && f.mult === mult) return null;
    p.score += next - f.delta;
    this.feed("info", "ev.fixed", { name: this.name_(f.playerId), from: f.delta, to: next });
    f.correct = mult > 0;
    f.delta = next;
    f.mult = mult;
    f.fixed = true;
    for (const id of this.members) this.hub.user(id)?.send({ t: "chat", items: [item] });
    this.changed();
    return null;
  }

  start(by: string, force = false) {
    if (!this.isLeader(by)) return tx("err.leaderOnly");
    if (this.phase !== "lobby") return tx("err.playing");
    if (!this.pack) return tx("err.noPack");
    if (!this.players.length) return tx("err.needPlayer");
    if (this.pack.shared && !force && !this.shareView()?.ready) return tx("err.shareNotReady");
    for (const p of this.players) { p.score = 0; p.ready = false; }
    this.finalsPlayed = 0;
    const first = this.nextPlayableRound(0);
    if (first < 0) return tx("err.packEmpty");
    this.startedAt = Date.now();
    this.feed("info", "ev.started");
    this.startRound(first);
    return null;
  }

  /* ---------- timers ---------- */

  private setTimer(kind: TimerState["kind"], seconds: number, fn: TimerFn, ...args: NonNullable<TimerAct["args"]>) {
    this.runTimer(kind, seconds, { fn, args });
  }
  /** `seconds` left of a countdown that is `duration` long in all (they differ after a pause). */
  private runTimer(kind: TimerState["kind"], seconds: number, act: TimerAct, duration = Math.max(0.5, seconds)) {
    this.clearTimer();
    seconds = Math.max(0.5, seconds);
    this.timer = { kind, duration, endsAt: Date.now() + seconds * 1000, act };
    if (this.paused) this.timer.pausedLeft = seconds;
    else this.timer.handle = setTimeout(() => { this.timer = undefined; this.fire(act); this.changed(); }, seconds * 1000);
  }
  /** Runs out the current timer at once (the host skips ahead). */
  private fireNow() {
    const act = this.timer?.act;
    this.clearTimer();
    if (act) this.fire(act);
  }
  private fire(act: TimerAct) {
    const a = act.args ?? [];
    switch (act.fn) {
      case "introDone": return this.introDone(!!a[0]);
      case "startReading": return this.startReading();
      case "openButtons": return this.openButtons();
      case "forAllJudge": return this.forAllJudge();
      case "noAnswer": return this.noAnswer();
      case "answerTimeout": return this.answerTimeout();
      case "stakeAllDone": return this.stakeAllDone();
      case "afterQuestion": return this.afterQuestion();
      case "randomPick": return this.randomPick();
      case "autoBid": return void this.bid(String(a[0]), a[1] === "pass" ? "pass" : "bid", a[2] == null ? undefined : Number(a[2]), true);
      case "autoGive": return void this.giveSecret(this.secret?.giverId ?? "", String(a[0]), true);
      case "autoPrice": return void this.setSecretPrice(String(a[0]), Number(a[1]));
      case "finalAutoRemove": return this.finalAutoRemove(String(a[0]));
      case "finalStakesDone": return this.finalStakesDone();
      case "finalJudgePhase": return this.finalJudgePhase();
      case "afterFinal": return this.afterFinal();
    }
  }
  private clearTimer() {
    if (this.timer?.handle) clearTimeout(this.timer.handle);
    this.timer = undefined;
  }
  private timeLeft() { return this.timer ? Math.max(0, (this.timer.endsAt - Date.now()) / 1000) : 0; }

  dispose() { this.clearTimer(); }

  /* ---------- rounds ---------- */

  private round(): Round | undefined { return this.pack?.opened.pack.rounds[this.roundIdx]; }
  private nextPlayableRound(from: number): number {
    const rounds = this.pack?.opened.pack.rounds ?? [];
    for (let i = from; i < rounds.length; i++) {
      if (this.settings.gameType === "simple" && rounds[i].type === "final") continue;
      if (this.settings.finals === "one" && this.finalsPlayed > 0 && rounds[i].type === "final") continue;
      if (rounds[i].themes.some((t) => t.questions.length)) return i;
    }
    return -1;
  }
  private roundLeft(): boolean {
    const r = this.round();
    return !!r?.themes.some((t, ti) => t.questions.some((_, qi) => !this.played.has(`${ti}:${qi}`)));
  }

  private startRound(i: number) {
    this.clearTimer();
    this.q = this.stake = this.secret = this.final = undefined;
    this.roundIdx = i;
    this.played.clear();
    const r = this.round();
    if (!r) return this.gameOver();
    this.preloadedBy.clear();
    if (r.type === "final") return this.startFinal(r);
    this.phase = "roundIntro";
    this.sendPreload();
    this.hostLine = tx("host.round", { name: r.name });
    this.feed("info", "ev.roundStarts", { round: r.name });
    this.setTimer("intro", 4, "introDone", this.nextPlayableRound(0) === i);
    this.changed();
  }

  /** The round's intro is over: someone gets to choose the first question. */
  private introDone(isFirst: boolean) {
    if (this.phase !== "roundIntro" || !this.players.length) return;
    const online = this.players.filter((p) => this.hub.user(p.id)?.online);
    const pool = online.length ? online : this.players;
    if (isFirst || !this.chooserId) this.chooserId = pick(pool).id;
    else {
      const min = Math.min(...pool.map((p) => p.score));
      this.chooserId = pick(pool.filter((p) => p.score === min)).id;
    }
    this.roundEndsAt = this.settings.roundTime ? Date.now() + this.settings.roundTime * 60_000 : undefined;
    this.feed("pick", "ev.firstChooser", { name: this.name_(this.chooserId) });
    this.enterChoosing();
  }

  private nextRound() {
    const next = this.nextPlayableRound(this.roundIdx + 1);
    if (next < 0) this.gameOver();
    else this.startRound(next);
  }

  private gameOver() {
    this.clearTimer();
    this.phase = "gameOver";
    this.q = this.stake = this.secret = undefined;
    const sorted = [...this.players].sort((a, b) => b.score - a.score);
    const top = sorted[0];
    this.hostLine = top ? tx("host.winner", { name: this.name_(top.id) }) : tx("host.gameOver");
    if (top) this.feed("good", "ev.winner", { name: this.name_(top.id), score: top.score });
    else this.feed("good", "ev.gameOver");
    this.hub.gameEnded?.(this);
    this.changed();
  }

  /* ---------- choosing ---------- */

  choose(by: string, t: number, i: number, auto = false) {
    if (this.phase !== "choosing" || (this.paused && !auto)) return tx("err.cantChoose");
    if (by !== this.chooserId && !this.canHost(by)) return tx("err.otherChooses");
    const r = this.round();
    const theme = r?.themes[t];
    const data = theme?.questions[i];
    if (!theme || !data || this.played.has(`${t}:${i}`)) return tx("err.played");
    this.played.add(`${t}:${i}`);
    const kind: QuestionKind = this.settings.gameType === "simple" ? "simple" : questionKind(data);
    this.q = { t, i, data, theme: theme.name, price: data.price, kind, stage: "reading", typed: "", submitted: false, wrong: new Set() };
    this.feed("pick", "ev.chose", { name: this.name_(this.chooserId), theme: theme.name, price: data.price });
    if (kind === "stake") this.startStake();
    else if (kind === "stakeAll") this.startStakeAll();
    else if (kind === "secret" || kind === "secretNoQuestion") this.startSecret();
    else {
      if (kind === "noRisk") this.q.soloId = this.chooserId;
      this.beginQuestion();
    }
    return null;
  }

  private readTime(): number {
    let t = 0;
    const speed = this.settings.readSpeed;
    for (const it of this.q!.data.content) {
      if (it.type === "text" || it.type === "say") t += it.value.length / speed;
      else if (it.type === "image") t += Math.max(2.5, this.settings.imageReveal);
      else if (it.type === "audio" || it.type === "video") t += it.duration ?? 8;
    }
    return clamp(t + 0.4, 2, 150);
  }

  private beginQuestion() {
    const q = this.q!;
    this.phase = "question";
    q.stage = "reading";
    this.hostLine = q.soloId ? tx("host.solo", { name: this.name_(q.soloId), kind: q.kind }) : tx("host.question", { theme: q.theme, price: q.price });
    // Pictures, sound and video first load everywhere, so nobody sees the question later than the rest.
    const media = q.data.content.some((it) => it.type === "image" || it.type === "audio" || it.type === "video");
    const waitFor = media ? this.loadWaiters() : [];
    if (waitFor.length) {
      q.loading = new Set(waitFor);
      q.loadTotal = waitFor.length;
      const clip = q.data.content.some((it) => it.type === "audio" || it.type === "video");
      this.setTimer("load", clip ? CLIP_WAIT : LOAD_WAIT, "startReading");
    } else this.startReading();
    this.changed();
  }

  /** Whose browsers we wait for: the players and the host who are online. */
  private loadWaiters() {
    const ids = this.players.map((p) => p.id);
    if (this.hostId) ids.push(this.hostId);
    return ids.filter((id) => this.members.has(id) && this.hub.user(id)?.online);
  }

  private startReading() {
    const q = this.q;
    if (!q || this.phase !== "question" || q.stage !== "reading") return;
    q.loading = undefined;
    this.setTimer("read", this.readTime(), "openButtons");
    this.changed();
  }

  mediaReady(by: string, key: string) {
    const q = this.q;
    if (!q?.loading || key !== `${q.t}:${q.i}` || !q.loading.delete(by)) return;
    if (!q.loading.size) {
      this.clearTimer();
      return this.startReading();
    }
    this.changed();
  }

  private openButtons() {
    const q = this.q;
    if (!q || this.phase !== "question") return;
    if (q.soloId) return this.startAnswering(q.soloId);
    if (q.kind === "forAll" || q.kind === "stakeAll") {
      q.stage = "open";
      q.all = new Map();
      q.allJudged = new Map();
      q.allDelta = new Map();
      this.hostLine = tx("host.forAll");
      this.setTimer("answer", this.settings.answerTime + 10, "forAllJudge");
      return this.changed();
    }
    q.stage = "open";
    q.openedAt = Date.now();
    this.hostLine = tx("host.open");
    this.setTimer("think", q.thinkLeft ?? this.settings.thinkTime, "noAnswer");
    this.changed();
  }

  buzz(by: string) {
    const q = this.q;
    if (this.phase !== "question" || !q || this.paused || !this.isPlayer(by) || q.soloId || q.kind === "forAll" || q.kind === "stakeAll") return;
    if (q.stage === "reading") {
      if (this.settings.falseStart && !q.loading) this.lockUntil.set(by, Date.now() + 1000);
      return;
    }
    if (q.stage !== "open" || q.wrong.has(by) || q.passed?.has(by) || (this.lockUntil.get(by) ?? 0) > Date.now()) return;
    q.thinkLeft = this.timeLeft();
    this.feed("buzz", "ev.buzz", { name: this.name_(by), reaction: q.openedAt ? (Date.now() - q.openedAt) / 1000 : undefined });
    this.startAnswering(by);
  }

  /**
   * A player passes: on a button question they give up their chance to press; on a question for
   * everyone it hands in an empty answer. Once nobody is left to answer, the question ends at once.
   */
  passQuestion(by: string) {
    const q = this.q;
    if (this.phase !== "question" || !q || !this.isPlayer(by) || q.soloId) return;
    if (q.kind === "forAll" || q.kind === "stakeAll") {
      if (q.stage === "open") this.forAllType(by, "", true);
      return;
    }
    if (q.stage !== "reading" && q.stage !== "open") return;
    if (q.wrong.has(by) || q.passed?.has(by)) return;
    (q.passed ??= new Set()).add(by);
    this.feed("info", "ev.pass", { name: this.name_(by) });
    if (!this.stillCanAnswer().length) {
      this.clearTimer();
      this.feed("info", "ev.allPassed", { answer: q.data.right[0] });
      return this.reveal();
    }
    this.changed();
  }

  /** Online players who haven't answered wrong or passed yet. */
  private stillCanAnswer() {
    const q = this.q!;
    return this.players.filter((pl) => !q.wrong.has(pl.id) && !q.passed?.has(pl.id) && this.hub.user(pl.id)?.online);
  }

  private startAnswering(id: string) {
    const q = this.q!;
    q.stage = "answering";
    q.answeringId = id;
    q.typed = "";
    q.submitted = false;
    this.hostLine = tx("host.yourAnswer", { name: this.name_(id) });
    this.setTimer("answer", this.settings.answerTime, "answerTimeout");
    this.changed();
  }

  type(by: string, text: string) {
    if (this.phase === "finalAnswer") return this.finalType(by, text, false);
    if (this.q?.kind === "forAll" || this.q?.kind === "stakeAll") return this.forAllType(by, text, false);
    const q = this.q;
    if (!q || q.stage !== "answering" || q.answeringId !== by || q.submitted) return;
    q.typed = text.slice(0, 200);
    this.changedSoon();
  }

  submit(by: string, text: string) {
    if (this.phase === "finalAnswer") return this.finalType(by, text, true);
    if (this.q?.kind === "forAll" || this.q?.kind === "stakeAll") return this.forAllType(by, text, true);
    const q = this.q;
    if (!q || q.stage !== "answering" || q.answeringId !== by || q.submitted) return;
    const point = this.pointQ() ? parsePoint(text) : undefined;
    if (this.pointQ() && !point) return;
    q.typed = text.slice(0, 200);
    q.submitted = true;
    if (point) (q.pointTries ??= []).push({ id: by, x: point.x, y: point.y, correct: this.isRight(q.typed) });
    if (this.autoJudge() || this.packJudges()) this.applyJudgement(this.isRight(q.typed));
    else {
      this.hostLine = tx("host.answers", { name: this.name_(by), answer: q.typed });
      this.changed();
    }
  }

  private answerTimeout() {
    const q = this.q;
    if (!q || q.stage !== "answering") return;
    if (this.autoJudge() || this.packJudges()) this.applyJudgement(this.isRight(q.typed));
    else {
      q.submitted = true;
      this.hostLine = tx("host.timeUp");
      this.changed();
    }
  }

  judge(by: string, correct: boolean, playerId?: string, mult?: Multiplier) {
    if (!this.canHost(by)) return tx("err.judgeHost");
    if (mult != null && !MULTIPLIERS.includes(mult)) return null;
    if (this.phase === "finalJudge") return this.finalJudge(playerId, mult != null ? mult > 0 : correct);
    if (this.q?.stage === "judging") return this.forAllMark(playerId, mult != null ? mult > 0 : correct, mult);
    if (this.q?.stage !== "answering") return null;
    this.applyJudgement(mult != null ? mult > 0 : correct, mult);
    return null;
  }

  /** Score change for a judged answer: ×1 / ×−1 follow the usual rules, other multipliers scale the price. */
  private deltaFor(price: number, correct: boolean, mult?: Multiplier, noRisk = false) {
    if (mult != null && mult !== 1 && mult !== -1) return Math.round(price * mult);
    if (correct) return noRisk ? price * 2 : price;
    return noRisk || !this.settings.wrongPenalty ? 0 : -price;
  }

  private applyJudgement(correct: boolean, mult?: Multiplier) {
    const q = this.q!;
    const id = q.answeringId!;
    const p = this.player(id);
    const delta = this.deltaFor(q.price, correct, mult, q.kind === "noRisk");
    if (p) p.score += delta;
    q.lastResult = { playerId: id, correct, delta, mult };
    if (mult === 0) (q.zero ??= new Set()).add(id);
    this.feed(mult === 0 ? "info" : correct ? "good" : "bad", correct ? "ev.right" : "ev.wrong", { name: this.name_(id), answer: this.answerText(q.typed), delta },
      { playerId: id, price: q.price, delta, correct, mult });
    if (correct) {
      this.chooserId = id;
      return this.reveal();
    }
    q.wrong.add(id);
    q.answeringId = undefined;
    const opts = q.data.answerOptions;
    if (opts?.length) {
      const picked = opts.find((o) => o.label.trim().toLowerCase() === q.typed.trim().toLowerCase());
      if (picked) (q.wrongOptions ??= new Set()).add(picked.label);
      // Only right options are left: nothing to guess any more.
      if (!q.soloId && opts.filter((o) => !q.wrongOptions?.has(o.label)).every((o) => this.isRight(o.label))) {
        this.clearTimer();
        this.feed("info", "ev.onlyRightLeft", { answer: q.data.right[0] });
        return this.reveal();
      }
    }
    const canStill = this.stillCanAnswer();
    if (q.soloId || !canStill.length) return this.reveal();
    q.stage = "open";
    this.hostLine = tx("host.wrongNext");
    this.setTimer("think", Math.max(q.thinkLeft ?? this.settings.thinkTime, 3), "noAnswer");
    this.changed();
  }

  /** Select and point questions carry their answer in the pack: no host needed to check them. */
  private packJudges() { return !!this.q?.data.answerOptions?.length || (this.pointQ() && this.rightPoints().length > 0); }

  /** "Point" question: the answer is a spot on the picture. */
  private pointQ() { return this.q?.data.answerType === "point"; }
  private rightPoints() { return (this.q?.data.right ?? []).map((r) => parsePoint(r)).filter((p) => !!p); }
  /** An answer as people read it ("📍 39% · 82%" for a point). */
  private answerText(a: string) { return (this.pointQ() && pointLabel(a)) || a; }

  /** Answer check that also understands option labels ("B") of select questions. */
  private isRight(given: string): boolean {
    const q = this.q!;
    if (q.data.answerType === "point") {
      const g = parsePoint(given);
      return !!g && this.rightPoints().some((r) => pointHits(g, r, q.data.answerDeviation ?? POINT_DEVIATION));
    }
    if (q.data.answerType === "number") {
      const toNum = (s: string) => Number((/-?\d+(?:[.,]\d+)?/.exec(s)?.[0] ?? "").replace(",", "."));
      const g = toNum(given);
      if (Number.isFinite(g) && q.data.right.some((r) => Number.isFinite(toNum(r)) && Math.abs(toNum(r) - g) <= (q.data.answerDeviation ?? 0))) return true;
    }
    if (answerMatches(given, q.data.right)) return true;
    const opt = q.data.answerOptions?.find((o) => o.label.trim().toLowerCase() === given.trim().toLowerCase());
    if (!opt) return false;
    const optText = opt.content.map((c) => c.value).join(" ");
    return q.data.right.some((r) => r.trim().toLowerCase() === opt.label.trim().toLowerCase()) || answerMatches(optText, q.data.right);
  }

  /* ---------- question for everyone / stakes for everyone ---------- */

  /** Who answers: every player, or for "stakes for everyone" only those who staked. */
  private allAnswering() {
    const q = this.q!;
    return q.stakes ? this.players.filter((p) => q.stakes!.has(p.id)) : this.players;
  }

  private startStakeAll() {
    const q = this.q!;
    const participants = this.players.filter((p) => p.score > 0).map((p) => p.id);
    if (!participants.length) {
      this.feed("info", "ev.stakeAllNobody");
      return this.beginQuestion();
    }
    q.stakes = new Map();
    this.phase = "stakeAll";
    this.hostLine = tx("host.stakeAll", { theme: q.theme });
    this.stakeAllParticipants = participants;
    this.setTimer("stake", Math.max(this.settings.stakeTime, 20), "stakeAllDone");
    this.changed();
  }

  /** Time for stakes is up: whoever didn't stake plays for the question's price. */
  private stakeAllDone() {
    const q = this.q;
    if (this.phase !== "stakeAll" || !q?.stakes) return;
    for (const id of this.stakeAllParticipants) {
      const p = this.player(id);
      if (p && !q.stakes.has(id)) q.stakes.set(id, Math.min(q.price || 1, p.score));
    }
    this.beginQuestion();
  }
  private stakeAllParticipants: string[] = [];

  stakeAllBet(by: string, value: number) {
    const q = this.q;
    if (this.phase !== "stakeAll" || !q?.stakes || !this.stakeAllParticipants.includes(by)) return tx("err.noStakeNow");
    const p = this.player(by)!;
    const v = Math.round(value);
    if (v < 1 || v > p.score) return tx("err.stakeRange", { max: p.score });
    q.stakes.set(by, v);
    this.feed("bid", "ev.staked", { name: this.name_(by) });
    if (this.stakeAllParticipants.every((id) => q.stakes!.has(id))) this.beginQuestion();
    else this.changed();
    return null;
  }

  private forAllType(by: string, text: string, done: boolean) {
    const q = this.q!;
    if (q.stage !== "open" || !q.all || !this.allAnswering().some((p) => p.id === by) || q.all.get(by)?.done) return;
    if (this.pointQ() && text && !parsePoint(text)) return;
    q.all.set(by, { text: text.slice(0, 200), done });
    if (done) {
      this.feed("info", "ev.submitted", { name: this.name_(by) });
      const online = this.allAnswering().filter((p) => this.hub.user(p.id)?.online);
      if (online.every((p) => q.all!.get(p.id)?.done)) return this.forAllJudge();
      this.changed();
    } else this.changedSoon();
  }

  private forAllJudge() {
    const q = this.q;
    if (!q?.all || q.stage !== "open") return;
    this.clearTimer();
    q.stage = "judging";
    // Empty answers are simply wrong; only real answers go to the host.
    const who = this.allAnswering();
    for (const p of who) if (!q.all.get(p.id)?.text.trim()) q.allJudged!.set(p.id, false);
    if (this.autoJudge() || this.packJudges()) {
      for (const p of who) if (!q.allJudged!.has(p.id)) q.allJudged!.set(p.id, this.isRight(q.all.get(p.id)!.text));
      return this.forAllApply();
    }
    if (who.every((p) => q.allJudged!.has(p.id))) return this.forAllApply();
    this.hostLine = tx("host.judging");
    this.changed();
  }

  private forAllMark(playerId: string | undefined, correct: boolean, mult?: Multiplier) {
    const q = this.q!;
    if (!playerId || !this.isPlayer(playerId) || !q.all?.get(playerId)?.text.trim()) return tx("err.didntAnswer");
    q.allJudged!.set(playerId, correct);
    if (mult != null) (q.allMult ??= new Map()).set(playerId, mult);
    else q.allMult?.delete(playerId);
    if (this.allAnswering().every((p) => q.allJudged!.has(p.id))) this.forAllApply();
    else this.changed();
    return null;
  }

  private forAllApply() {
    const q = this.q!;
    for (const p of this.allAnswering()) {
      // With stakes everyone who staked plays for the stake, answered or not.
      const stake = q.stakes?.get(p.id);
      const answered = !!q.all!.get(p.id)?.text.trim();
      if (!answered && stake == null) continue;
      const ok = !!q.allJudged!.get(p.id);
      const price = stake ?? q.price;
      const m = q.allMult?.get(p.id);
      const delta = m != null && m !== 1 && m !== -1 ? Math.round(price * m) : ok ? price : stake != null || this.settings.wrongPenalty ? -price : 0;
      p.score += delta;
      q.allDelta!.set(p.id, delta);
      this.feed(ok ? "good" : "bad", "ev.answer", { name: this.name_(p.id), answer: this.answerText(q.all!.get(p.id)?.text ?? ""), delta }, { playerId: p.id, price, delta, correct: ok, mult: m });
    }
    this.reveal();
  }

  private noAnswer() {
    const q = this.q;
    if (!q) return;
    this.feed("info", "ev.noAnswer", { answer: this.answerText(q.data.right[0]) });
    this.reveal();
  }

  private reveal() {
    const q = this.q!;
    q.stage = "reveal";
    q.answeringId = undefined;
    this.hostLine = tx("host.correct", { answer: this.answerText(q.data.right[0]) });
    this.setTimer("reveal", q.data.answerContent.length ? 6 : 4, "afterQuestion");
    this.changed();
  }

  private afterQuestion() {
    this.q = undefined;
    if (!this.roundLeft()) return this.nextRound();
    if (this.roundEndsAt && Date.now() >= this.roundEndsAt) {
      this.feed("info", "ev.roundTime");
      return this.nextRound();
    }
    this.enterChoosing();
  }

  private enterChoosing() {
    this.phase = "choosing";
    this.hostLine = tx("host.choose", { name: this.name_(this.chooserId) });
    if (this.settings.chooseTime) {
      this.setTimer("choose", this.settings.chooseTime, "randomPick");
    } else this.clearTimer();
    this.changed();
  }

  /** The chooser took too long: a random card from those left. */
  private randomPick() {
    const r = this.round();
    const open = (r?.themes ?? []).flatMap((t, ti) => t.questions.map((_, qi) => [ti, qi] as const)).filter(([ti, qi]) => !this.played.has(`${ti}:${qi}`));
    if (!open.length || !this.chooserId) return;
    const [ti, qi] = pick(open);
    this.feed("info", "ev.randomPick", { name: this.name_(this.chooserId) });
    this.choose(this.chooserId, ti, qi, true);
  }

  /**
   * The host's "jump forward": whatever the game is waiting for, move on. Skips the reading, ends a
   * question nobody answers, picks a random card for a slow chooser, cuts any running countdown.
   * Waits only for the host's own decision (an answer to judge).
   */
  private advance() {
    if (this.paused) return;
    if (this.phase === "choosing") return this.randomPick();
    if (this.phase === "question" && (this.q?.stage === "answering" || this.q?.stage === "judging")) return;
    if (this.timer) return this.fireNow();
    if (this.phase === "question" && this.q?.stage === "reveal") return this.afterQuestion();
    if (this.phase === "finalReveal") return this.afterFinal();
  }

  /* ---------- auction ---------- */

  private startStake() {
    const ids = this.players.map((p) => p.id);
    const start = Math.max(0, ids.indexOf(this.chooserId!));
    this.stake = { nominal: this.q!.price, value: 0, passed: new Set(), allIn: false, order: [...ids.slice(start), ...ids.slice(0, start)] };
    this.phase = "stake";
    this.hostLine = tx("host.auction");
    this.stakeTurn(true);
  }

  private stakeEligible(id: string): boolean {
    const s = this.stake!;
    const p = this.player(id);
    if (!p || s.passed.has(id) || id === s.leaderId) return false;
    return p.score > s.value && p.score > 0;
  }

  private stakeTurn(first = false) {
    const s = this.stake!;
    if (first) {
      const chooser = this.player(this.chooserId);
      if (!chooser || chooser.score <= s.nominal || s.order.length === 1) {
        s.leaderId = this.chooserId;
        s.value = s.nominal;
        this.feed("bid", "ev.nominal", { name: this.name_(this.chooserId), value: s.nominal });
      } else {
        s.turnId = this.chooserId;
        this.setTimer("stake", this.settings.stakeTime, "autoBid", s.turnId!, "bid", s.nominal);
        return this.changed();
      }
    }
    const from = s.turnId ? s.order.indexOf(s.turnId) : s.order.indexOf(this.chooserId!);
    for (let k = 1; k <= s.order.length; k++) {
      const id = s.order[(from + k) % s.order.length];
      if (this.stakeEligible(id)) {
        s.turnId = id;
        this.hostLine = tx("host.yourBid", { name: this.name_(id) });
        this.setTimer("stake", this.settings.stakeTime, "autoBid", id, "pass", null);
        return this.changed();
      }
    }
    this.finishStake();
  }

  bid(by: string, kind: "bid" | "pass" | "allin", value?: number, auto = false) {
    const s = this.stake;
    if (this.phase !== "stake" || !s || s.turnId !== by || (this.paused && !auto)) return tx("err.notYourTurn");
    const p = this.player(by)!;
    const name = this.name_(by);
    if (kind === "pass") {
      if (!s.leaderId) {
        if (!auto) return tx("err.openBid");
        kind = "bid"; value = s.nominal;
      } else {
        s.passed.add(by);
        this.feed("bid", "ev.pass", { name });
        return this.stakeTurn(), null;
      }
    }
    if (kind === "allin" || (kind === "bid" && value === p.score)) {
      if (p.score <= s.value) return tx("err.allInBeat");
      s.leaderId = by; s.value = p.score; s.allIn = true;
      this.feed("bid", "ev.allIn", { name, value: p.score });
    } else {
      if (s.allIn) return tx("err.onlyAllIn");
      const min = s.leaderId ? s.value + 100 : s.nominal;
      const v = Math.round(value ?? min);
      if (v < min || v > p.score) return tx("err.bidRange", { min, max: p.score });
      s.leaderId = by; s.value = v;
      this.feed("bid", "ev.bid", { name, value: v });
    }
    this.stakeTurn();
    return null;
  }

  private finishStake() {
    const s = this.stake!;
    const q = this.q!;
    if (!s.leaderId) { s.leaderId = this.chooserId; s.value = s.nominal; }
    q.price = s.value;
    q.soloId = s.leaderId;
    this.chooserId = s.leaderId;
    this.feed("bid", "ev.wonAuction", { name: this.name_(s.leaderId), value: s.value });
    this.stake = undefined;
    this.beginQuestion();
  }

  /* ---------- cat in the bag ---------- */

  private startSecret() {
    const q = this.q!;
    const d = q.data;
    let candidates = this.players.map((p) => p.id);
    if ((d.selectionMode ?? "exceptCurrent") === "exceptCurrent" && candidates.length > 1) candidates = candidates.filter((id) => id !== this.chooserId);
    const sp = d.secretPrice;
    const range = typeof sp === "object" ? sp : undefined;
    this.secret = {
      giverId: this.chooserId!,
      candidates,
      theme: d.secretTheme || q.theme,
      price: typeof sp === "number" ? sp : range ? range.min : q.price,
      priceChoice: range && range.min !== range.max ? range : undefined,
    };
    this.phase = "secret";
    this.hostLine = tx("host.secret", { kind: q.kind, name: this.name_(this.chooserId) });
    if (candidates.length === 1) this.setTimer("secret", 2, "autoGive", candidates[0]);
    else this.setTimer("secret", this.settings.stakeTime, "autoGive", pick(candidates));
    this.changed();
  }

  giveSecret(by: string, to: string, auto = false) {
    const s = this.secret;
    if (this.phase !== "secret" || !s || s.recipientId) return null;
    if (!auto && by !== s.giverId && !this.canHost(by)) return tx("err.giverOnly");
    if (!s.candidates.includes(to)) return tx("err.cantGive");
    s.recipientId = to;
    this.feed("pick", "ev.gave", { name: this.name_(s.giverId), to: this.name_(to) });
    if (s.priceChoice) {
      this.hostLine = tx("host.pickPrice", { name: this.name_(to) });
      this.setTimer("secret", this.settings.stakeTime, "autoPrice", to, s.priceChoice.min);
      this.changed();
    } else this.proceedSecret();
    return null;
  }

  setSecretPrice(by: string, value: number) {
    const s = this.secret;
    if (this.phase !== "secret" || !s?.priceChoice || s.recipientId !== by) return tx("err.recipientPrice");
    const { min, max, step } = s.priceChoice;
    if (value < min || value > max || (step > 0 && (value - min) % step !== 0)) return tx("err.noPrice");
    s.price = value;
    this.proceedSecret();
    return null;
  }

  private proceedSecret() {
    const s = this.secret!;
    const q = this.q!;
    q.price = s.price;
    q.theme = s.theme;
    q.soloId = s.recipientId;
    this.secret = undefined;
    if (q.kind === "secretNoQuestion") {
      const p = this.player(s.recipientId);
      if (p) p.score += s.price;
      this.chooserId = s.recipientId;
      this.feed("good", "ev.freePoints", { name: this.name_(s.recipientId), value: s.price });
      this.phase = "question";
      return this.reveal();
    }
    this.beginQuestion();
  }

  /* ---------- final round ---------- */

  private startFinal(r: Round) {
    const participants = this.players.filter((p) => p.score > 0).sort((a, b) => a.score - b.score).map((p) => p.id);
    const themes = r.themes.map((t, idx) => ({ name: t.name, removed: false, qIndex: idx })).filter((t) => r.themes[t.qIndex].questions.length);
    if (!participants.length || !themes.length) {
      this.feed("info", participants.length ? "ev.finalEmpty" : "ev.finalNobody");
      return this.gameOver();
    }
    this.final = { themes, participants, order: participants, turn: 0, stakes: new Map(), answers: new Map(), judged: new Map() };
    this.phase = "finalThemes";
    this.sendPreload();
    this.feed("info", "ev.final", { names: participants.map((id) => this.name_(id)).join(", ") });
    if (themes.length === 1) return this.finalStakesPhase();
    this.hostLine = tx("host.finalThemes");
    this.finalRemoveTurn();
  }

  /** After a final: the next final round (setting "all finals"), otherwise the game ends. */
  private afterFinal() {
    this.final = undefined;
    this.nextRound();
  }
  private finalsPlayed = 0;
  /** An anonymous pack's name was opened to everyone after the game. */
  private packRevealed = false;
  /** The finished game's line in the statistics (to fill in the pack once it is shown). */
  statsEntry?: string;
  isPackRevealed() { return this.packRevealed; }
  /** Since when the room waits in the lobby (closed if no game starts for too long). */
  lobbySince = Date.now();

  private finalTurnId() { const f = this.final!; return f.order[f.turn % f.order.length]; }

  private finalRemoveTurn() {
    const id = this.finalTurnId();
    this.hostLine = tx("host.removeTheme", { name: this.name_(id) });
    this.setTimer("final", this.settings.stakeTime, "finalAutoRemove", id);
    this.changed();
  }

  /** Too slow to strike a theme: a random one goes. */
  private finalAutoRemove(id: string) {
    const left = (this.final?.themes ?? []).map((t, i) => (t.removed ? -1 : i)).filter((i) => i >= 0);
    if (left.length) this.removeTheme(id, pick(left), true);
  }

  removeTheme(by: string, index: number, auto = false) {
    const f = this.final;
    if (this.phase !== "finalThemes" || !f) return null;
    if (!auto && by !== this.finalTurnId() && !this.canHost(by)) return tx("err.otherRemoves");
    const t = f.themes[index];
    if (!t || t.removed) return tx("err.themeGone");
    t.removed = true;
    this.feed("pick", "ev.themeRemoved", { name: this.name_(by), theme: t.name });
    if (f.themes.filter((x) => !x.removed).length <= 1) this.finalStakesPhase();
    else { f.turn++; this.finalRemoveTurn(); }
    return null;
  }

  private finalStakesPhase() {
    const f = this.final!;
    const theme = f.themes.find((t) => !t.removed)!;
    const r = this.round()!;
    const data = r.themes[theme.qIndex].questions[0];
    this.q = { t: theme.qIndex, i: 0, data, theme: theme.name, price: 0, kind: "simple", stage: "reading", typed: "", submitted: false, wrong: new Set() };
    this.phase = "finalStakes";
    this.hostLine = tx("host.finalStakes", { theme: theme.name });
    this.setTimer("final", Math.max(this.settings.stakeTime, 20), "finalStakesDone");
    this.changed();
  }

  /** Time for final stakes is up: whoever didn't stake plays for 1. */
  private finalStakesDone() {
    const f = this.final;
    if (this.phase !== "finalStakes" || !f) return;
    for (const id of f.participants) if (!f.stakes.has(id)) f.stakes.set(id, 1);
    this.finalAnswerPhase();
  }

  finalStake(by: string, value: number) {
    const f = this.final;
    if (this.phase !== "finalStakes" || !f || !f.participants.includes(by)) return tx("err.noStake");
    const p = this.player(by)!;
    const v = Math.round(value);
    if (v < 1 || v > p.score) return tx("err.bidRange", { min: 1, max: p.score });
    f.stakes.set(by, v);
    this.feed("bid", "ev.staked", { name: this.name_(by) });
    if (f.participants.every((id) => f.stakes.has(id))) this.finalAnswerPhase();
    else this.changed();
    return null;
  }

  private finalAnswerPhase() {
    this.phase = "finalAnswer";
    this.q!.stage = "open";
    this.hostLine = tx("host.finalAnswer");
    this.setTimer("final", this.settings.finalTime + this.readTime(), "finalJudgePhase");
    this.changed();
  }

  private finalType(by: string, text: string, done: boolean) {
    const f = this.final;
    if (!f || !f.participants.includes(by)) return;
    const cur = f.answers.get(by);
    if (cur?.done) return;
    f.answers.set(by, { text: text.slice(0, 200), done });
    if (done) {
      this.feed("info", "ev.submitted", { name: this.name_(by) });
      if (f.participants.every((id) => f.answers.get(id)?.done)) return this.finalJudgePhase();
    }
    if (done) this.changed(); else this.changedSoon();
  }

  private finalJudgePhase() {
    const f = this.final!;
    this.clearTimer();
    this.phase = "finalJudge";
    if (this.autoJudge()) {
      for (const id of f.participants) f.judged.set(id, answerMatches(f.answers.get(id)?.text ?? "", this.q!.data.right));
      return this.finalRevealPhase();
    }
    this.hostLine = tx("host.judging");
    this.changed();
  }

  private finalJudge(playerId: string | undefined, correct: boolean) {
    const f = this.final;
    if (!f || !playerId || !f.participants.includes(playerId)) return tx("err.noFinalist");
    f.judged.set(playerId, correct);
    if (f.participants.every((id) => f.judged.has(id))) this.finalRevealPhase();
    else this.changed();
    return null;
  }

  private finalRevealPhase() {
    const f = this.final!;
    for (const id of f.participants) {
      const p = this.player(id)!;
      const stake = f.stakes.get(id) ?? 1;
      const ok = !!f.judged.get(id);
      p.score += ok ? stake : -stake;
      this.feed(ok ? "good" : "bad", "ev.answer", { name: this.name_(id), answer: f.answers.get(id)?.text, delta: ok ? stake : -stake }, { playerId: id, price: stake, delta: ok ? stake : -stake, correct: ok });
    }
    this.phase = "finalReveal";
    this.q!.stage = "reveal";
    this.hostLine = tx("host.correct", { answer: this.q!.data.right[0] });
    this.finalsPlayed++;
    this.setTimer("reveal", 8, "afterFinal");
    this.changed();
  }

  /* ---------- host controls ---------- */

  hostAction(by: string, action: HostAction) {
    if (!this.canHost(by)) return tx("err.hostOnly");
    switch (action) {
      case "pause":
        if (this.paused || this.phase === "lobby" || this.phase === "gameOver") return null;
        this.paused = true;
        if (this.timer) {
          if (this.timer.handle) clearTimeout(this.timer.handle);
          this.timer.handle = undefined;
          this.timer.pausedLeft = this.timeLeft();
        }
        this.feed("info", "ev.paused");
        break;
      case "resume":
        if (!this.paused) return null;
        this.paused = false;
        if (this.timer) {
          const { kind, act, pausedLeft, duration } = this.timer;
          this.runTimer(kind, pausedLeft ?? 1, act, duration);
        }
        this.feed("info", "ev.resumed");
        break;
      case "open":
        if (this.q?.stage === "reading" && this.phase === "question") this.openButtons();
        break;
      case "skip":
        if (this.phase === "question" && this.q && this.q.stage !== "reveal") { this.feed("info", "ev.skipped"); this.reveal(); }
        else if (this.phase === "roundIntro" || this.q?.stage === "reveal") this.fireNow();
        break;
      case "next":
        if (this.q?.stage === "reveal" && this.phase === "question") { this.clearTimer(); this.afterQuestion(); }
        else if (this.phase === "roundIntro" && this.timer) this.fireNow();
        else if (this.phase === "finalReveal") { this.clearTimer(); this.afterFinal(); }
        break;
      case "nextRound":
        if (this.phase !== "lobby" && this.phase !== "gameOver") { this.feed("info", "ev.nextRound"); this.nextRound(); }
        break;
      case "advance":
        this.advance();
        break;
      case "end":
        if (this.phase !== "lobby") this.gameOver();
        break;
    }
    this.changed();
    return null;
  }

  setScore(by: string, id: string, score: number) {
    if (!this.canHost(by)) return tx("err.scoreHost");
    const p = this.player(id);
    if (!p || !Number.isFinite(score)) return null;
    this.feed("info", "ev.scoreSet", { name: this.name_(id), from: p.score, to: Math.round(score) });
    p.score = Math.round(score);
    this.changed();
    return null;
  }

  backToLobby() {
    this.clearTimer();
    this.startedAt = undefined;
    this.lobbySince = Date.now();
    this.phase = "lobby";
    this.q = this.stake = this.secret = this.final = undefined;
    this.hostLine = tx("host.newGame");
    this.changed();
  }

  /* ---------- chat ---------- */

  feed(tone: ChatItem["tone"], key: TextKey, params?: TextParams, fix?: ChatItem["fix"]) {
    const line = tx(key, params);
    this.pushChat({ id: ++this.chatSeq, at: Date.now(), kind: "ev", tone, text: formatText("ru", line), line, fix });
  }

  say(user: User, text: string) {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!clean || Date.now() - user.lastChat < 400) return;
    user.lastChat = Date.now();
    this.pushChat({ id: ++this.chatSeq, at: Date.now(), kind: "msg", fromId: user.id, name: user.name, avatar: user.avatar, role: this.roleOf(user.id), text: clean });
  }

  private pushChat(item: ChatItem) {
    this.rev++;
    this.chat.push(item);
    if (this.chat.length > 300) this.chat.splice(0, this.chat.length - 300);
    for (const id of this.members) this.hub.user(id)?.send({ t: "chat", items: [item] });
  }

  /* ---------- downloading media ahead ---------- */

  /** Links to the media of a round's questions (never of the answers), as members see them. */
  private roundMedia(idx: number): string[] {
    const key = `${idx}:${this.settings.anonPack}`;
    const hit = this.mediaCache.get(key);
    if (hit) return hit;
    const pack = this.pack;
    const r = pack?.opened.pack.rounds[idx];
    if (!pack || !r) return [];
    const urls = new Set<string>();
    for (const t of r.themes) for (const q of t.questions) {
      if (this.settings.gameType === "classic" && q.type === "secretNoQuestion") continue;
      const items = q.content.filter((it) => it.type === "image" || it.type === "audio" || it.type === "video");
      for (const m of pack.media(items, this.settings.anonPack)) if (m.url?.startsWith("/")) urls.add(m.url);
    }
    const list = [...urls];
    this.mediaCache.set(key, list);
    return list;
  }

  /**
   * Sends the current round's media list (to one member, or to all), and the next round's too once
   * everyone at the table has the current one.
   */
  private sendPreload(only?: string) {
    if (!this.pack || this.pack.shared || this.roundIdx < 0 || this.phase === "lobby" || this.phase === "gameOver") return;
    const cur: ServerMsg = { t: "preload", round: this.roundIdx, urls: this.roundMedia(this.roundIdx) };
    const nextIdx = this.nextPlayableRound(this.roundIdx + 1);
    const next: ServerMsg | undefined = this.nextPreloadFor === this.roundIdx && nextIdx >= 0
      ? { t: "preload", round: nextIdx, urls: this.roundMedia(nextIdx), next: true }
      : undefined;
    for (const id of only ? [only] : this.members) {
      const u = this.hub.user(id);
      if (!u?.online) continue;
      u.send(cur);
      if (next) u.send(next);
    }
  }

  /** A browser has downloaded a whole round. Once everyone has, the next round goes out. */
  preloaded(by: string, round: number) {
    if (round !== this.roundIdx || this.phase === "lobby" || this.phase === "gameOver") return;
    let who = this.preloadedBy.get(round);
    if (!who) this.preloadedBy.set(round, (who = new Set()));
    who.add(by);
    if (this.nextPreloadFor === round || !this.loadWaiters().every((id) => who.has(id))) return;
    this.nextPreloadFor = round;
    const nextIdx = this.nextPlayableRound(round + 1);
    if (nextIdx < 0) return;
    const msg: ServerMsg = { t: "preload", round: nextIdx, urls: this.roundMedia(nextIdx), next: true };
    for (const id of this.members) this.hub.user(id)?.send(msg);
  }

  /* ---------- shared packs: media between browsers ---------- */

  /** Files of a round (questions and answers) of a shared pack. */
  private roundFiles(idx: number): Set<number> {
    const out = new Set<number>();
    const shared = this.pack?.shared;
    const r = this.pack?.opened.pack.rounds[idx];
    if (!shared || !r) return out;
    for (const t of r.themes) for (const q of t.questions) {
      for (const it of [...q.content, ...q.answerContent]) {
        if (!it.isRef || it.type === "text" || it.type === "say") continue;
        const f = shared.fileOf(it.value, it.type as MediaKind);
        if (f != null) out.add(f);
      }
    }
    return out;
  }

  /** The file list for browsers: sizes and hashes only, in the order to download them. */
  private swarmMsg(): ServerMsg {
    const shared = this.pack?.shared;
    if (!shared || !this.pack) return { t: "swarm", id: "", files: [], order: [], holders: {} };
    const rounds = this.pack.opened.pack.rounds;
    const first = Math.max(0, this.nextPlayableRound(0));
    const seq = [first, ...rounds.map((_, i) => i).filter((i) => i !== first)];
    const order: number[] = [];
    const taken = new Set<number>();
    for (const i of seq) for (const f of this.roundFiles(i)) if (!taken.has(f)) { taken.add(f); order.push(f); }
    shared.files.forEach((_, f) => { if (!taken.has(f)) order.push(f); });
    const holders: Record<string, number[]> = {};
    for (const [id, set] of this.haves) if (this.hub.user(id)?.online) holders[id] = [...set];
    return { t: "swarm", id: this.pack.hash, files: shared.files.map((f) => ({ size: f.size, hash: f.hash })), order, holders };
  }

  private shareView(): ShareView | undefined {
    const shared = this.pack?.shared;
    if (!shared) return undefined;
    const first = this.roundFiles(Math.max(0, this.nextPlayableRound(0)));
    const table = [...this.players.map((p) => p.id), ...(this.hostId ? [this.hostId] : [])];
    const people = table.map((id) => {
      const have = this.haves.get(id);
      return { id, have: have?.size ?? 0, firstRound: [...first].every((f) => have?.has(f)) };
    });
    const online = (id: string) => !!this.hub.user(id)?.online && this.members.has(id);
    return { total: shared.files.length, firstRound: first.size, people, ready: people.filter((p) => online(p.id)).every((p) => p.firstRound) };
  }

  /** A browser reports the files it has; everyone else learns where to get them. */
  have(by: string, files: number[], reset = false) {
    const shared = this.pack?.shared;
    if (!shared || !this.members.has(by) || !Array.isArray(files)) return;
    const ok = files.filter((f) => Number.isInteger(f) && f >= 0 && f < shared.files.length);
    let set = this.haves.get(by);
    if (!set || reset) this.haves.set(by, (set = new Set()));
    for (const f of ok) set.add(f);
    for (const id of this.members) if (id !== by) this.hub.user(id)?.send({ t: "have", from: by, files: ok, reset });
    if (this.phase === "lobby") this.changed();
    else this.changedSoon();
  }

  private dropHave(id: string) {
    if (!this.haves.delete(id)) return;
    for (const m of this.members) if (m !== id) this.hub.user(m)?.send({ t: "have", from: id, files: [], reset: true });
  }

  /**
   * Another browser has taken over the room (peer mode): everyone gets the pack's file list, the
   * feed and the room again, and re-reports which files they have.
   */
  resync() {
    const swarm = this.swarmMsg();
    for (const id of this.members) {
      const u = this.hub.user(id);
      if (!u?.online) continue;
      u.send(swarm);
      u.send({ t: "chat", items: this.chat, reset: true });
    }
    this.changed();
  }

  /** WebRTC signalling between two members of this room. */
  relay(from: string, to: string, data: unknown) {
    if (!this.members.has(from) || !this.members.has(to) || from === to) return;
    this.hub.user(to)?.send({ t: "rtc", from, data });
  }

  /* ---------- saving across restarts ---------- */

  snapshot(): RoomSnapshot {
    const self = this as unknown as Record<string, unknown>;
    const data: Record<string, unknown> = { id: this.id };
    for (const k of SAVED_FIELDS) data[k] = encode(self[k]);
    // The latest part of the feed is enough to pick the game up again.
    data.chat = encode(this.chat.slice(-100));
    if (this.q) {
      const { data: _question, ...q } = this.q;
      data.q = encode(q);
    }
    if (this.timer) {
      const left = this.paused ? this.timer.pausedLeft ?? 1 : Math.max(0.5, (this.timer.endsAt - Date.now()) / 1000);
      data.timer = { kind: this.timer.kind, duration: this.timer.duration, left, act: this.timer.act };
    }
    return { v: 1, savedAt: Date.now(), packHash: this.pack?.hash, data };
  }

  /** Brings a saved room back. Without its pack (or its question) the room returns to the lobby. */
  static restore(snap: RoomSnapshot, hub: Hub, pack: LoadedPack | undefined, note: TextKey = "ev.restored"): Room {
    const d = snap.data;
    const r = new Room(String(d.id), hub, { id: String(d.ownerId), name: "" } as User, { name: String(d.name), settings: {}, asHost: false });
    const self = r as unknown as Record<string, unknown>;
    for (const k of SAVED_FIELDS) if (k in d) self[k] = decode(d[k]);
    r.pack = pack;
    const q = d.q as Record<string, unknown> | undefined;
    const question = q && pack?.opened.pack.rounds[r.roundIdx]?.themes[Number(q.t)]?.questions[Number(q.i)];
    if (q && question) r.q = { ...(decode(q) as Omit<QState, "data">), data: question };
    const lost = r.phase !== "lobby" && r.phase !== "gameOver" && (!pack || !r.round() || (q && !question));
    if (lost) {
      r.q = r.stake = r.secret = r.final = undefined;
      r.phase = "lobby";
      r.startedAt = undefined;
      r.lobbySince = Date.now();
      r.hostLine = tx("host.newGame");
      return r;
    }
    const t = d.timer as { kind: TimerState["kind"]; duration: number; left: number; act: TimerAct } | undefined;
    if (t && r.phase !== "lobby") r.runTimer(t.kind, t.left + RESTORE_GRACE, t.act, t.duration + RESTORE_GRACE);
    if (r.phase !== "lobby") r.feed("info", note);
    return r;
  }

  /* ---------- views ---------- */

  /** Coalesces frequent updates (typing) into one broadcast per 200 ms. */
  private soon?: ReturnType<typeof setTimeout>;
  changedSoon() {
    if (this.soon) return;
    this.soon = setTimeout(() => { this.soon = undefined; this.changed(); }, 200);
  }

  changed() {
    this.rev++;
    if (this.dirty) return;
    this.dirty = true;
    queueMicrotask(() => {
      this.dirty = false;
      for (const id of this.members) {
        const u = this.hub.user(id);
        if (u?.online) u.send({ t: "room", room: this.view(id) });
      }
      this.hub.roomsChanged();
    });
  }

  private person(id: string) {
    const u = this.hub.user(id);
    return { id, name: u?.name ?? "Игрок", avatar: u?.avatar, gender: u?.gender, online: !!u?.online && this.members.has(id) };
  }

  view(me: string): RoomView {
    const role = this.roleOf(me);
    const isHost = this.canHost(me) && role !== "player";
    const q = this.q;
    const pack = this.pack;
    const r = this.round();
    const v: RoomView = {
      id: this.id,
      name: this.name,
      hasPassword: !!this.password,
      settings: this.settings,
      ownerId: this.ownerId,
      leaderId: this.leaderId(),
      me: { id: me, role },
      host: this.hostId ? this.person(this.hostId) : undefined,
      players: this.players.map((p) => ({ ...this.person(p.id), score: p.score, ready: p.ready })),
      viewers: [...this.viewers].map((id) => this.person(id)),
      pack: this.packView(role),
      packLoading: this.packLoading,
      phase: this.phase,
      paused: this.paused,
      chooserId: this.chooserId,
      hostLine: this.hostLine,
      voiceUrl: this.voiceUrl,
      share: this.shareView(),
      serverNow: Date.now(),
    };
    if (r && this.phase !== "lobby" && this.phase !== "gameOver") {
      v.board = {
        index: this.roundIdx,
        count: pack!.opened.pack.rounds.length,
        name: r.name,
        final: r.type === "final",
        themes: r.themes.map((t, ti) => ({
          name: t.name,
          prices: t.questions.map((qq, qi) => (this.played.has(`${ti}:${qi}`) ? null : qq.price)),
          all: isHost ? t.questions.map((qq) => qq.price) : undefined,
        })),
        roundEndsAt: this.roundEndsAt,
      };
    }
    if (q && pack) {
      const showQuestion = !(this.phase === "finalThemes" || this.phase === "finalStakes" || this.phase === "secret" || this.phase === "stake");
      const reveal = q.stage === "reveal";
      const canSeeTyped = isHost || q.answeringId === me || q.submitted || reveal;
      v.question = {
        themeIndex: q.t,
        index: q.i,
        theme: q.theme,
        price: q.price,
        kind: q.kind,
        stage: q.stage,
        content: showQuestion ? pack.media(q.data.content, this.settings.anonPack) : [],
        answer: isHost || reveal ? { text: q.data.right, content: reveal ? pack.media(q.data.answerContent, this.settings.anonPack) : [] } : undefined,
        answeringId: q.answeringId,
        typed: canSeeTyped ? q.typed : undefined,
        submitted: q.submitted,
        wrongIds: [...q.wrong],
        passedIds: [...(q.passed ?? [])],
        soloId: q.soloId,
        lastResult: q.lastResult,
        zeroIds: q.zero?.size ? [...q.zero] : undefined,
        loading: q.loading ? { ready: (q.loadTotal ?? 0) - q.loading.size, total: q.loadTotal ?? 0 } : undefined,
        options: showQuestion && q.data.answerOptions?.length
          ? q.data.answerOptions.map((o) => ({ label: o.label, text: o.content.map((c) => c.value).join(" "), wrong: q.wrongOptions?.has(o.label) || undefined }))
          : undefined,
        point: q.data.answerType === "point" && showQuestion
          ? {
              tries: [
                ...(q.pointTries ?? []).map(({ id, x, y, correct }) => ({ id, x, y, correct })),
                ...(reveal && q.all ? this.allAnswering().flatMap((p) => {
                  const pt = parsePoint(q.all!.get(p.id)?.text);
                  return pt ? [{ id: p.id, x: pt.x, y: pt.y, correct: q.allJudged!.get(p.id) }] : [];
                }) : []),
              ],
              answer: isHost || reveal ? (() => { const r = this.rightPoints()[0]; return r && { x: r.x, y: r.y, dev: q.data.answerDeviation ?? POINT_DEVIATION }; })() : undefined,
            }
          : undefined,
        forAll: q.all
          ? {
              who: this.allAnswering().map((p) => p.id),
              done: [...q.all].filter(([, a]) => a.done).map(([id]) => id),
              myAnswer: q.all.get(me)?.text,
              answers: reveal || (isHost && q.stage === "judging")
                ? this.allAnswering().map((p) => ({ id: p.id, answer: q.all!.get(p.id)?.text ?? "", correct: q.allJudged!.get(p.id), delta: q.allDelta!.get(p.id), stake: reveal ? q.stakes?.get(p.id) : undefined, mult: q.allMult?.get(p.id) }))
                : undefined,
            }
          : undefined,
      };
    }
    if (this.stake) {
      const s = this.stake;
      v.stake = { nominal: s.nominal, leaderId: s.leaderId, value: s.value, turnId: s.turnId, passed: [...s.passed], allIn: s.allIn, minBid: s.leaderId ? s.value + 100 : s.nominal };
    }
    if (this.secret) v.secret = { ...this.secret };
    if (this.phase === "stakeAll" && q?.stakes) {
      v.stakeAll = { participants: this.stakeAllParticipants, done: [...q.stakes.keys()], myStake: q.stakes.get(me), price: q.price, theme: q.theme };
    }
    if (this.final) {
      const f = this.final;
      const revealAll = this.phase === "finalReveal" || this.phase === "gameOver";
      const hostSees = isHost && this.phase === "finalJudge";
      v.final = {
        themes: f.themes.map((t) => ({ name: t.name, removed: t.removed })),
        turnId: this.phase === "finalThemes" ? this.finalTurnId() : undefined,
        participants: f.participants,
        stakesDone: [...f.stakes.keys()],
        answersDone: [...f.answers].filter(([, a]) => a.done).map(([id]) => id),
        myStake: f.stakes.get(me),
        myAnswer: f.answers.get(me)?.text,
        answers: revealAll || hostSees
          ? f.participants.map((id) => ({ id, answer: f.answers.get(id)?.text ?? "", stake: revealAll || isHost ? f.stakes.get(id) : undefined, correct: f.judged.get(id) }))
          : undefined,
      };
    }
    if (this.timer) v.timer = { kind: this.timer.kind, endsAt: this.timer.endsAt, duration: this.timer.duration, pausedLeft: this.paused ? this.timer.pausedLeft : undefined };
    return v;
  }

  summary(): RoomSummary {
    const r = this.round();
    return {
      id: this.id,
      name: this.name,
      packName: this.settings.anonPack && !this.packRevealed ? undefined : this.pack?.info.name,
      packHidden: this.settings.anonPack && !this.packRevealed && !!this.pack,
      anonPack: this.settings.anonPack,
      lang: this.pack?.info.lang,
      falseStart: this.settings.falseStart,
      hostFree: !this.hostId,
      hostName: this.name_(this.hostId ?? this.ownerId),
      players: this.players.length,
      maxPlayers: this.settings.maxPlayers,
      status: this.phase === "lobby" ? "wait" : "play",
      round: this.phase === "gameOver" ? tx("round.over") : r ? (r.type === "final" ? tx("round.final") : tx("round.n", { index: this.roundIdx + 1, count: this.pack!.opened.pack.rounds.length })) : undefined,
      hasPassword: !!this.password,
      avatars: this.players.slice(0, 5).map((p) => ({ id: p.id, avatar: this.hub.user(p.id)?.avatar })),
      hostMode: this.settings.hostMode,
      oral: this.settings.oral,
      gameType: this.settings.gameType,
      allowViewers: this.settings.allowViewers,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
    };
  }
}
