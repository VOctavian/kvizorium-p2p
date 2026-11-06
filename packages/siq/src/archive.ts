import JSZip from "jszip";
import { parseContentXml } from "./parse.ts";
import type { MediaKind, Pack, PackStats } from "./types.ts";

const FOLDERS: Record<MediaKind, string[]> = {
  image: ["Images"],
  audio: ["Audio"],
  video: ["Video"],
  html: ["Html"],
};

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Keys used to find a file regardless of how SIGame escaped its name. */
function keysFor(name: string): string[] {
  const decoded = safeDecode(name);
  return [...new Set([name, decoded, encodeURI(decoded), encodeURIComponent(decoded)].map((k) => k.normalize("NFC").toLowerCase()))];
}

export interface PackFile {
  /** Path inside the archive, e.g. "Images/mars.jpg" */
  path: string;
  kind: MediaKind;
}

/** Media files of an archive by path, and a lookup that understands SIGame's escaped names. */
export function indexFiles(paths: string[]): { files: PackFile[]; resolve(ref: string, kind?: MediaKind): PackFile | undefined } {
  const files: PackFile[] = [];
  const index = new Map<string, PackFile>();
  for (const relPath of paths) {
    const slash = relPath.indexOf("/");
    if (slash < 0) continue;
    const folder = relPath.slice(0, slash).toLowerCase();
    const kind = (Object.keys(FOLDERS) as MediaKind[]).find((k) => FOLDERS[k].some((f) => f.toLowerCase() === folder));
    if (!kind) continue;
    const file: PackFile = { path: relPath, kind };
    files.push(file);
    for (const key of keysFor(relPath.slice(slash + 1))) {
      index.set(`${kind}:${key}`, file);
      if (!index.has(`*:${key}`)) index.set(`*:${key}`, file);
    }
  }
  return {
    files,
    resolve(ref, kind) {
      const name = ref.replace(/^@/, "");
      for (const key of keysFor(name)) {
        const hit = (kind && index.get(`${kind}:${key}`)) || index.get(`*:${key}`);
        if (hit) return hit;
      }
      return undefined;
    },
  };
}

export interface OpenedPack {
  pack: Pack;
  /** content.xml as it is in the archive. */
  xml: string;
  stats: PackStats;
  /** Every media file in the archive. */
  files: PackFile[];
  /** Finds the archive path for a media reference from content.xml. */
  resolve(ref: string, kind?: MediaKind): PackFile | undefined;
  read(path: string): Promise<Uint8Array>;
  /** Lets go of the archive's bytes; `read` stops working, the rest stays. */
  close(): void;
}

export async function openPack(data: Uint8Array | ArrayBuffer): Promise<OpenedPack> {
  let zip: JSZip | undefined;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new Error("Файл не похож на пак .siq: это не zip-архив");
  }
  const z = zip;
  const contentEntry = z.file(/^content\.xml$/i)[0];
  if (!contentEntry) throw new Error("В паке нет файла content.xml");
  const xml = await contentEntry.async("string");
  const pack = parseContentXml(xml);

  const paths: string[] = [];
  z.forEach((relPath, entry) => { if (!entry.dir) paths.push(relPath); });
  const { files, resolve } = indexFiles(paths);

  const questions = pack.rounds.reduce((n, r) => n + r.themes.reduce((m, t) => m + t.questions.length, 0), 0);
  return {
    pack,
    xml,
    files,
    stats: {
      rounds: pack.rounds.length,
      themes: pack.rounds.reduce((n, r) => n + r.themes.length, 0),
      questions,
      mediaFiles: files.length,
    },
    resolve,
    read(path) {
      const f = zip?.file(path);
      if (!f) return Promise.reject(new Error("Нет файла " + path));
      return f.async("uint8array");
    },
    close() { zip = undefined; },
  };
}
