import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LobbyStats, RecentGame, TopPack } from "@kvz/protocol";

/**
 * Finished games, kept in <dataDir>/stats.json: how often each pack was played (top packs) and the
 * latest games. Anonymous packs count only once their name was shown after the game.
 */
interface PackStat { name: string; games: number; questions: number; lastPlayed: number }
interface Saved { packs: Record<string, PackStat>; recent: (RecentGame & { hash: string })[] }

const KEEP_RECENT = 30;
const SAVE_DELAY = 3000;

export class Stats {
  private data: Saved = { packs: {}, recent: [] };
  private file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "stats.json");
    try {
      if (existsSync(this.file)) {
        const d = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Saved>;
        this.data = { packs: d.packs ?? {}, recent: d.recent ?? [] };
      }
    } catch { /* a broken file starts the stats over */ }
  }

  private timer?: ReturnType<typeof setTimeout>;
  private writing = false;
  private again = false;

  /** Written a few seconds later and without blocking: several games ending together make one write. */
  private save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.write(); }, SAVE_DELAY);
    this.timer.unref?.();
  }
  private async write() {
    if (this.writing) { this.again = true; return; }
    this.writing = true;
    try {
      const tmp = this.file + ".tmp";
      await writeFile(tmp, JSON.stringify(this.data));
      await rename(tmp, this.file);
    } catch { /* stats are not worth a crash */ }
    this.writing = false;
    if (this.again) { this.again = false; void this.write(); }
  }
  /** On shutdown: write now if something waits. */
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      writeFileSync(this.file + ".tmp", JSON.stringify(this.data));
      renameSync(this.file + ".tmp", this.file);
    } catch { /* see above */ }
  }

  /** A game ended. `hidden`: an anonymous pack — its name stays out until `reveal`. */
  gameOver(g: { id: string; hash: string; packName: string; questions: number; hidden: boolean; roomName: string; winner?: string; winnerScore?: number; players: number; startedAt?: number }) {
    const now = Date.now();
    const entry = {
      id: `${g.id}:${now}`, hash: g.hash, roomName: g.roomName, packName: g.hidden ? undefined : g.packName, packHidden: g.hidden || undefined,
      winner: g.winner, winnerScore: g.winnerScore, players: g.players, endedAt: now,
      minutes: g.startedAt ? Math.max(1, Math.round((now - g.startedAt) / 60_000)) : undefined,
    };
    this.data.recent.unshift(entry);
    this.data.recent.length = Math.min(this.data.recent.length, KEEP_RECENT);
    if (!g.hidden) this.countPack(g.hash, g.packName, g.questions, now);
    this.save();
    return entry.id;
  }

  /** The anonymous pack of a finished game was shown to everyone. */
  reveal(entryId: string, packName: string, questions: number) {
    const e = this.data.recent.find((x) => x.id === entryId);
    if (!e || !e.packHidden) return;
    e.packName = packName;
    e.packHidden = undefined;
    this.countPack(e.hash, packName, questions, e.endedAt);
    this.save();
  }

  private countPack(hash: string, name: string, questions: number, at: number) {
    const p = (this.data.packs[hash] ??= { name, games: 0, questions, lastPlayed: at });
    p.games++;
    p.name = name;
    p.lastPlayed = Math.max(p.lastPlayed, at);
  }

  view(): LobbyStats {
    const top: TopPack[] = Object.entries(this.data.packs)
      .sort(([, a], [, b]) => b.games - a.games || b.lastPlayed - a.lastPlayed)
      .slice(0, 20)
      .map(([hash, p]) => ({ hash, name: p.name, games: p.games, questions: p.questions, lastPlayed: p.lastPlayed }));
    const recent = this.data.recent.slice(0, 20).map(({ hash: _hash, ...r }) => r);
    return { top, recent };
  }
}
