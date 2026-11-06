/**
 * Downloads a round's media in the background, so questions open at once. The server sends the
 * current round's list (and the next round's once everyone has the current one); files land in the
 * browser's HTTP cache, where <img>, <audio> and <video> find them later.
 */

/** Files downloaded at the same time: leaves room for the question being shown right now. */
const PARALLEL = 2;

interface Job { url: string; round: number }

const done = new Set<string>();
const inflight = new Set<string>();
let queue: Job[] = [];
let active = 0;
/** Round -> files still to download, and whether the server was told it's done. */
const rounds = new Map<number, { left: Set<string>; reported: boolean }>();
let report: (round: number) => void = () => {};
/** Changes when the room changes, so late downloads of the old room don't count. */
let epoch = 0;

/**
 * `next`: the following round, downloaded after the current one. Without it, this is the round
 * being played now: whatever else was waiting is dropped.
 */
export function preloadRound(round: number, urls: string[], next: boolean, resolve: (url: string) => string, onDone: (round: number) => void) {
  report = onDone;
  if (!next) {
    queue = [];
    for (const r of [...rounds.keys()]) if (r !== round) rounds.delete(r);
  }
  const left = new Set(urls.map(resolve).filter((u) => !done.has(u)));
  rounds.set(round, { left, reported: false });
  // The current round's files are queued first; the next round's come after them.
  for (const url of left) if (!inflight.has(url) && !queue.some((j) => j.url === url)) queue.push({ url, round });
  check(round);
  pump();
}

/** Left the room: stop downloading. */
export function stopPreload() {
  queue = [];
  rounds.clear();
  epoch++;
}

function check(round: number) {
  const r = rounds.get(round);
  if (!r || r.reported || r.left.size) return;
  r.reported = true;
  report(round);
}

function finished(url: string) {
  done.add(url);
  for (const [round, r] of rounds) if (r.left.delete(url)) check(round);
}

function pump() {
  while (active < PARALLEL && queue.length) {
    const job = queue.shift()!;
    if (done.has(job.url)) { finished(job.url); continue; }
    active++;
    inflight.add(job.url);
    const mine = epoch;
    fetchWhole(job.url)
      .catch(() => { /* a broken file shouldn't hold the round back */ })
      .finally(() => {
        active--;
        inflight.delete(job.url);
        if (mine === epoch) finished(job.url);
        pump();
      });
  }
}

/** Reads the whole file (so it is cached whole) without keeping it in memory. */
async function fetchWhole(url: string) {
  const res = await fetch(url, { credentials: "omit" });
  const reader = res.body?.getReader();
  if (!reader) return;
  for (;;) {
    const { done: end } = await reader.read();
    if (end) break;
  }
}
