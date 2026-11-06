import { indexFiles, parseContentXml, type ContentItem, type MediaKind, type OpenedPack, type Pack } from "@kvz/siq";
import { MAX_PACK_MB, type MediaView, type PackInfo, type SharedFile } from "@kvz/protocol";

/** A pack a room plays: its questions, and how its media reach the players. */
export interface LoadedPack {
  hash: string;
  /** Folder of the unpacked media on the server ("" for shared packs). */
  dir: string;
  /** The parsed pack; the archive's bytes are let go after unpacking. */
  opened: Pick<OpenedPack, "pack" | "stats" | "resolve">;
  info: PackInfo;
  /** `hidden`: links without the pack's hash or file names (anonymous packs). */
  media(items: ContentItem[], hidden?: boolean): MediaView[];
  /** A pack whose media travel between players: its file list (with keys) and content.xml. */
  shared?: { xml: string; files: SharedFile[]; fileOf(ref: string, kind: MediaKind): number | undefined };
}

/** Russian if the pack's themes and questions are mostly in Cyrillic. */
export function guessLang(pack: Pack): "ru" | "other" {
  let cyr = 0, lat = 0;
  const count = (s: string) => {
    for (const ch of s) {
      if (/[а-яё]/i.test(ch)) cyr++;
      else if (/[a-z]/i.test(ch)) lat++;
    }
  };
  count(pack.name);
  for (const r of pack.rounds) for (const t of r.themes) {
    count(t.name);
    for (const q of t.questions.slice(0, 3)) for (const it of q.content) if (it.type === "text" || it.type === "say") count(it.value);
  }
  return cyr >= lat ? "ru" : "other";
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif",
  mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", opus: "audio/ogg",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg", mkv: "video/x-matroska",
  // Browsers don't play these; the type lets the player say so instead of showing a black box.
  wmv: "video/x-ms-wmv", avi: "video/x-msvideo", flv: "video/x-flv", mpg: "video/mpeg", mpeg: "video/mpeg", "3gp": "video/3gpp", wma: "audio/x-ms-wma", amr: "audio/amr",
  html: "text/html", htm: "text/html",
};
const mimeOf = (path: string) => MIME[(/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? "").toLowerCase()];

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * A pack the leader's browser unpacked: content.xml and the list of encrypted media files, never
 * the media themselves. Runs the same on the server and in a browser that keeps a room.
 */
export async function buildSharedPack(xml: string, files: SharedFile[]): Promise<LoadedPack> {
  if (typeof xml !== "string" || !Array.isArray(files) || files.length > 20_000) throw new Error("bad share");
  let total = 0;
  const seen = new Set<string>();
  for (const f of files) {
    if (typeof f?.path !== "string" || f.path.length > 1000 || seen.has(f.path)) throw new Error("bad share");
    if (!Number.isSafeInteger(f.size) || f.size < 12 || !/^[0-9a-f]{64}$/.test(f.hash) || !/^[A-Za-z0-9+/]{43}=$/.test(f.key)) throw new Error("bad share");
    if (f.dur != null && !(typeof f.dur === "number" && f.dur > 0 && f.dur < 36_000)) throw new Error("bad share");
    if (f.mime != null && !/^(video|audio)\/mp4$/.test(f.mime)) throw new Error("bad share");
    seen.add(f.path);
    total += f.size;
  }
  if (total > MAX_PACK_MB * 1048576) throw new Error("too big");
  const pack = parseContentXml(xml);
  const digest = await globalThis.crypto.subtle.digest("SHA-1", new TextEncoder().encode(xml + "\n" + files.map((f) => f.hash).join(",")));
  const hash = hex(digest).slice(0, 16);
  const { resolve } = indexFiles(files.map((f) => f.path));
  const byPath = new Map(files.map((f, i) => [f.path, i]));
  const fileOf = (ref: string, kind: MediaKind) => {
    const hit = resolve(ref, kind);
    return hit ? byPath.get(hit.path) : undefined;
  };
  const media = (items: ContentItem[]): MediaView[] =>
    items.map((it): MediaView => {
      if (it.type === "text" || it.type === "say") return { type: it.type, text: it.value, placement: it.placement };
      if (!it.isRef) return /^https?:\/\//i.test(it.value) ? { type: it.type, url: it.value, placement: it.placement } : { type: "text", text: it.value };
      const i = fileOf(it.value, it.type as MediaKind);
      if (i == null) return { type: "text", text: "[в паке нет файла]" };
      return { type: it.type, file: i, key: files[i].key, mime: files[i].mime ?? mimeOf(files[i].path), placement: it.placement, duration: it.duration ?? files[i].dur };
    });
  const questions = pack.rounds.reduce((n, r) => n + r.themes.reduce((m, t) => m + t.questions.length, 0), 0);
  const info: PackInfo = {
    name: pack.name,
    authors: pack.authors,
    version: pack.version,
    questions,
    rounds: pack.rounds.map((r) => ({
      name: r.name,
      final: r.type === "final",
      themes: r.themes.length,
      questions: r.themes.reduce((n, t) => n + t.questions.length, 0),
    })),
    lang: guessLang(pack),
    sizeMb: Math.round((total / 1048576) * 10) / 10,
    shared: true,
  };
  const stats = { rounds: pack.rounds.length, themes: pack.rounds.reduce((n, r) => n + r.themes.length, 0), questions, mediaFiles: files.length };
  return { hash, dir: "", opened: { pack, stats, resolve }, info, media, shared: { xml, files, fileOf } };
}
