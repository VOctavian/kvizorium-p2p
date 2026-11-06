/**
 * Shared packs: the leader's browser unpacks the .siq, encrypts every media file with its own key
 * and gives the server only content.xml and the file list. The encrypted files travel between the
 * browsers of the room over WebRTC; each one is checked against its SHA-256 and kept in IndexedDB.
 * The server hands out a file's key when the file is on screen, so nobody can look ahead.
 */
import { MAX_PACK_MB, type ClientMsg, type SharedFile } from "@kvz/protocol";

/* ---------- wiring ---------- */

let send: (m: ClientMsg) => void = () => {};
let me: () => string | undefined = () => undefined;
export function setupShare(opts: { send: (m: ClientMsg) => void; me: () => string | undefined }) {
  send = opts.send;
  me = opts.me;
}

const listeners = new Set<() => void>();
let version = 0;
const bump = () => { version++; listeners.forEach((l) => l()); };
export const subscribeShare = (l: () => void) => (listeners.add(l), () => { listeners.delete(l); });
export const shareVersion = () => version;

/* ---------- bytes ---------- */

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const sha256 = async (b: BufferSource) => hex(await crypto.subtle.digest("SHA-256", b));

/* ---------- storage: IndexedDB, with memory as a fallback ---------- */

const blobs = new Map<string, Blob>();
let dbp: Promise<IDBDatabase | undefined> | undefined;
function db(): Promise<IDBDatabase | undefined> {
  return (dbp ??= new Promise((ok) => {
    try {
      const req = indexedDB.open("kvz-share", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ok(undefined);
    } catch { ok(undefined); }
  }));
}
async function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((ok) => {
    try {
      const req = run(d.transaction("files", mode).objectStore("files"));
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ok(undefined);
    } catch { ok(undefined); }
  });
}
async function store(hash: string, blob: Blob) {
  blobs.set(hash, blob);
  await idb("readwrite", (s) => s.put(blob, hash));
}
async function getBlob(hash: string): Promise<Blob | undefined> {
  const hit = blobs.get(hash);
  if (hit) return hit;
  const b = await idb<Blob>("readonly", (s) => s.get(hash));
  if (b) blobs.set(hash, b);
  return b;
}
/** Only the last few packs stay in the browser. */
function remember(id: string, hashes: string[]) {
  let recent: { id: string; hashes: string[] }[] = [];
  try { recent = JSON.parse(localStorage.getItem("kvz.share.recent") ?? "[]"); } catch { /* starts over */ }
  recent = [{ id, hashes }, ...recent.filter((r) => r.id !== id)];
  const keep = recent.slice(0, 3);
  const keepSet = new Set(keep.flatMap((r) => r.hashes));
  const drop = recent.slice(3).flatMap((r) => r.hashes).filter((h) => !keepSet.has(h));
  for (const h of drop) { blobs.delete(h); void idb("readwrite", (s) => s.delete(h)); }
  try { localStorage.setItem("kvz.share.recent", JSON.stringify(keep)); } catch { /* storage full */ }
}

/* ---------- the leader prepares a pack ---------- */

export class ShareError extends Error {
  constructor(readonly code: "tooBig" | "textTooBig") { super(code); }
}

/** Unpacks and encrypts a pack in this browser; the files stay here, ready to be shared. */
export async function preparePack(file: File, onProgress: (p: number) => void): Promise<{ xml: string; files: SharedFile[] }> {
  if (file.size > MAX_PACK_MB * 1048576) throw new ShareError("tooBig");
  // The unzipper and the XML parser are needed only by the leader: loaded on demand.
  const { openPack } = await import("@kvz/siq");
  const opened = await openPack(await file.arrayBuffer());
  try {
    if (opened.xml.length > 3_500_000) throw new ShareError("textTooBig");
    const files: SharedFile[] = [];
    for (const [i, f] of opened.files.entries()) {
      const plain = await opened.read(f.path);
      const key = crypto.getRandomValues(new Uint8Array(32));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ck = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ck, plain as Uint8Array<ArrayBuffer>));
      const whole = new Uint8Array(12 + ct.length);
      whole.set(iv);
      whole.set(ct, 12);
      const hash = await sha256(whole);
      await store(hash, new Blob([whole]));
      files.push({ path: f.path, size: whole.length, hash, key: toB64(key) });
      onProgress((i + 1) / opened.files.length);
    }
    return { xml: opened.xml, files };
  } finally {
    opened.close();
  }
}

/* ---------- the room's pack ---------- */

interface Swarm { id: string; files: { size: number; hash: string }[]; order: number[]; holders: Map<string, Set<number>>; have: Set<number> }
let swarm: Swarm | undefined;
const urls = new Map<string, string>();
const urgent = new Set<number>();

export async function onSwarm(m: { id: string; files: { size: number; hash: string }[]; order: number[]; holders: Record<string, number[]> }) {
  const same = swarm?.id === m.id && !!m.id;
  if (!same) {
    closeAll();
    for (const [hash, url] of urls) if (!m.files.some((f) => f.hash === hash)) { URL.revokeObjectURL(url); urls.delete(hash); }
    urgent.clear();
  }
  if (!m.id) { swarm = undefined; bump(); return; }
  const holders = new Map(Object.entries(m.holders).map(([id, f]) => [id, new Set(f)]));
  // The same pack again (after a reconnect): downloads already running go on.
  const s: Swarm = same ? Object.assign(swarm!, { holders }) : { id: m.id, files: m.files, order: m.order, holders, have: new Set() };
  swarm = s;
  remember(m.id, m.files.map((f) => f.hash));
  // What this browser already has (from an earlier visit, or because it prepared the pack).
  const keys = new Set((await idb<IDBValidKey[]>("readonly", (st) => st.getAllKeys())) ?? []);
  if (swarm !== s) return;
  s.files.forEach((f, i) => { if (blobs.has(f.hash) || keys.has(f.hash)) s.have.add(i); });
  send({ t: "have", files: [...s.have], reset: true });
  bump();
  schedule();
}

export function onHave(from: string, files: number[], reset?: boolean) {
  if (!swarm) return;
  let set = swarm.holders.get(from);
  if (!set || reset) swarm.holders.set(from, (set = new Set()));
  for (const f of files) set.add(f);
  if (reset && !files.length) peers.get(from)?.close();
  schedule();
}

/** Left the room: stop sharing. */
export function stopShare() {
  swarm = undefined;
  closeAll();
  urgent.clear();
  bump();
}

/** How much of the pack this browser has, 0..1 (1 without a shared pack). */
export function shareProgress(): number {
  if (!swarm || !swarm.files.length) return 1;
  return swarm.have.size / swarm.files.length;
}

/** A decrypted file ready to show, or undefined (then it is fetched first, ahead of the rest). */
export function readyUrl(file: number): string | undefined {
  const f = swarm?.files[file];
  return f ? urls.get(f.hash) : undefined;
}

const decrypting = new Map<string, Promise<string | undefined>>();
/** Decrypts a file with the key the server gave; undefined while the file hasn't arrived. */
export function mediaUrl(file: number, key: string, mime?: string): Promise<string | undefined> {
  const f = swarm?.files[file];
  if (!f) return Promise.resolve(undefined);
  const ready = urls.get(f.hash);
  if (ready) return Promise.resolve(ready);
  const hash = f.hash;
  let p = decrypting.get(hash);
  if (!p) {
    p = (async () => {
      const blob = await getBlob(hash);
      if (!blob) { urgent.add(file); schedule(); return undefined; }
      try {
        const whole = new Uint8Array(await blob.arrayBuffer());
        const ck = await crypto.subtle.importKey("raw", fromB64(key), "AES-GCM", false, ["decrypt"]);
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: whole.subarray(0, 12) }, ck, whole.subarray(12));
        // The type matters: without it a browser won't show an SVG, and some won't play a video.
        const url = URL.createObjectURL(new Blob([plain], mime ? { type: mime } : undefined));
        urls.set(hash, url);
        bump();
        return url;
      } catch { return undefined; }
    })().finally(() => decrypting.delete(hash));
    decrypting.set(hash, p);
  }
  return p;
}

/** Waits up to `ms` for a file to arrive and decrypt. */
export function whenReady(file: number, key: string, ms: number, mime?: string): Promise<void> {
  return new Promise((done) => {
    const stop = setTimeout(finish, ms);
    let off = () => {};
    function finish() { clearTimeout(stop); off(); done(); }
    const check = () => { void mediaUrl(file, key, mime).then((u) => { if (u) finish(); }); };
    off = subscribeShare(check);
    check();
  });
}

/* ---------- downloading ---------- */

/** Files fetched at once, each from a different browser. */
const PARALLEL = 3;
/** A browser that failed us is left alone this long. */
const BAD_MS = 30_000;
const downloading = new Map<string, string>(); // hash -> peer id
const bad = new Map<string, number>();
let tick: ReturnType<typeof setInterval> | undefined;

function schedule() {
  const s = swarm;
  if (!s) return;
  const busy = new Set(downloading.values());
  const now = Date.now();
  for (const f of new Set([...urgent, ...s.order])) {
    if (s.have.has(f) || !s.files[f] || downloading.has(s.files[f].hash)) continue;
    if (downloading.size >= PARALLEL) break;
    const from = [...s.holders].filter(([id, set]) => set.has(f) && id !== me() && !busy.has(id) && (bad.get(id) ?? 0) < now).map(([id]) => id);
    if (!from.length) continue;
    const id = from[Math.floor(Math.random() * from.length)];
    busy.add(id);
    void download(s, f, id);
  }
  // Retry later what nobody could give right now.
  const missing = s.order.some((f) => !s.have.has(f));
  if (missing && !tick) tick = setInterval(schedule, 5000);
  if (!missing && tick) { clearInterval(tick); tick = undefined; }
}

async function download(s: Swarm, f: number, from: string) {
  const { hash } = s.files[f];
  downloading.set(hash, from);
  try {
    const peer = await connect(from);
    const blob = await peer.fetch(hash);
    if (await sha256(await blob.arrayBuffer()) !== hash) throw new Error("hash");
    await store(hash, blob);
    if (swarm !== s) return;
    s.have.add(f);
    urgent.delete(f);
    send({ t: "have", files: [f] });
    bump();
  } catch (e) {
    if ((e as Error).message === "no") s.holders.get(from)?.delete(f);
    else bad.set(from, Date.now() + BAD_MS);
  } finally {
    downloading.delete(hash);
    schedule();
  }
}

/* ---------- WebRTC ---------- */

const ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }];
const CHUNK = 16 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const OPEN_MS = 15_000;
const IDLE_MS = 20_000;

const peers = new Map<string, Peer>();

function closeAll() {
  for (const p of peers.values()) p.close();
  peers.clear();
  downloading.clear();
  if (tick) { clearInterval(tick); tick = undefined; }
}

function connect(id: string): Promise<Peer> {
  let p = peers.get(id);
  if (!p) { p = new Peer(id, true); peers.set(id, p); }
  return p.ready;
}

/** WebRTC signalling from another member of the room. */
export async function onRtc(from: string, data: { sdp?: RTCSessionDescriptionInit; c?: RTCIceCandidateInit }) {
  if (!swarm) return;
  let p = peers.get(from);
  if (data.sdp?.type === "offer") {
    // Both sides called at once: the one with the smaller id keeps its own offer.
    if (p && p.pc.signalingState === "have-local-offer") {
      if ((me() ?? "") < from) return;
      p.close();
      p = undefined;
    }
    if (!p) { p = new Peer(from, false); peers.set(from, p); }
    await p.accept(data.sdp);
  } else if (data.sdp?.type === "answer") await p?.answered(data.sdp);
  else if (data.c) await p?.candidate(data.c);
}

class Peer {
  pc = new RTCPeerConnection({ iceServers: ICE });
  ch?: RTCDataChannel;
  ready: Promise<Peer>;
  private opened!: (p: Peer) => void;
  private failed!: (e: Error) => void;
  private pending: RTCIceCandidateInit[] = [];
  private serving: string[] = [];
  private busyServing = false;
  private incoming?: { hash: string; parts: ArrayBuffer[]; ok: (b: Blob) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
  private closed = false;

  constructor(readonly id: string, initiate: boolean) {
    this.ready = new Promise((ok, fail) => { this.opened = ok; this.failed = fail; });
    this.ready.catch(() => {});
    const giveUp = setTimeout(() => this.close(new Error("timeout")), OPEN_MS);
    this.ready.then(() => clearTimeout(giveUp), () => clearTimeout(giveUp));
    this.pc.onicecandidate = (e) => { if (e.candidate) send({ t: "rtc", to: id, data: { c: e.candidate.toJSON() } }); };
    this.pc.onconnectionstatechange = () => { if (this.pc.connectionState === "failed" || this.pc.connectionState === "closed") this.close(new Error("failed")); };
    if (initiate) {
      this.setup(this.pc.createDataChannel("files", { ordered: true }));
      void (async () => {
        try {
          await this.pc.setLocalDescription(await this.pc.createOffer());
          send({ t: "rtc", to: id, data: { sdp: this.pc.localDescription!.toJSON() } });
        } catch (e) { this.close(e as Error); }
      })();
    } else this.pc.ondatachannel = (e) => this.setup(e.channel);
  }

  async accept(offer: RTCSessionDescriptionInit) {
    try {
      await this.pc.setRemoteDescription(offer);
      await this.flush();
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      send({ t: "rtc", to: this.id, data: { sdp: this.pc.localDescription!.toJSON() } });
    } catch (e) { this.close(e as Error); }
  }
  async answered(answer: RTCSessionDescriptionInit) {
    try { await this.pc.setRemoteDescription(answer); await this.flush(); } catch (e) { this.close(e as Error); }
  }
  async candidate(c: RTCIceCandidateInit) {
    if (!this.pc.remoteDescription) { this.pending.push(c); return; }
    try { await this.pc.addIceCandidate(c); } catch { /* a stale candidate */ }
  }
  private async flush() {
    for (const c of this.pending.splice(0)) { try { await this.pc.addIceCandidate(c); } catch { /* see above */ } }
  }

  private setup(ch: RTCDataChannel) {
    this.ch = ch;
    ch.binaryType = "arraybuffer";
    ch.bufferedAmountLowThreshold = 1024 * 1024;
    ch.onopen = () => this.opened(this);
    if (ch.readyState === "open") this.opened(this);
    ch.onclose = () => this.close(new Error("closed"));
    ch.onmessage = (e) => this.message(e.data);
  }

  /** Asks this browser for a file. */
  fetch(hash: string): Promise<Blob> {
    return new Promise((ok, fail) => {
      if (!this.ch || this.ch.readyState !== "open") return fail(new Error("closed"));
      const timer = setTimeout(() => this.stall(), IDLE_MS);
      this.incoming = { hash, parts: [], ok, fail, timer };
      this.ch.send(JSON.stringify({ get: hash }));
    });
  }
  private stall() {
    const inc = this.incoming;
    this.incoming = undefined;
    inc?.fail(new Error("stalled"));
  }

  private message(data: string | ArrayBuffer) {
    if (typeof data !== "string") {
      const inc = this.incoming;
      if (!inc) return;
      inc.parts.push(data);
      clearTimeout(inc.timer);
      inc.timer = setTimeout(() => this.stall(), IDLE_MS);
      return;
    }
    let m: { get?: string; no?: string; end?: string };
    try { m = JSON.parse(data); } catch { return; }
    if (m.get) { this.serving.push(m.get); void this.serve(); return; }
    const inc = this.incoming;
    if (!inc) return;
    if (m.no === inc.hash) { clearTimeout(inc.timer); this.incoming = undefined; inc.fail(new Error("no")); }
    if (m.end === inc.hash) { clearTimeout(inc.timer); this.incoming = undefined; inc.ok(new Blob(inc.parts)); }
  }

  /** Sends asked-for files one after another, without flooding the channel. */
  private async serve() {
    if (this.busyServing) return;
    this.busyServing = true;
    try {
      while (this.serving.length && this.ch?.readyState === "open") {
        const hash = this.serving.shift()!;
        const blob = /^[0-9a-f]{64}$/.test(hash) ? await getBlob(hash) : undefined;
        if (!blob) { this.ch.send(JSON.stringify({ no: hash })); continue; }
        for (let at = 0; at < blob.size; at += CHUNK) {
          if (this.ch.readyState !== "open") return;
          if (this.ch.bufferedAmount > HIGH_WATER) {
            await new Promise<void>((go) => { this.ch!.addEventListener("bufferedamountlow", () => go(), { once: true }); });
          }
          this.ch.send(await blob.slice(at, at + CHUNK).arrayBuffer());
        }
        this.ch.send(JSON.stringify({ end: hash }));
      }
    } catch { /* the channel closed */ } finally {
      this.busyServing = false;
    }
  }

  close(why = new Error("closed")) {
    if (this.closed) return;
    this.closed = true;
    this.failed(why);
    const inc = this.incoming;
    this.incoming = undefined;
    if (inc) { clearTimeout(inc.timer); inc.fail(why); }
    try { this.ch?.close(); } catch { /* already */ }
    try { this.pc.close(); } catch { /* already */ }
    if (peers.get(this.id) === this) peers.delete(this.id);
  }
}
