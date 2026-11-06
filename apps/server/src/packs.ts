import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { openPack, type ContentItem, type MediaKind } from "@kvz/siq";
import type { MediaView, PackInfo, SharedFile } from "@kvz/protocol";
import { buildSharedPack, guessLang, type LoadedPack } from "@kvz/game";

export type { LoadedPack };


/** Opaque media links for anonymous packs: token -> file on disk. */
const SECRET = randomBytes(32);
const hiddenFiles = new Map<string, string>();
function hiddenMediaUrl(dir: string, archivePath: string): string {
  const token = createHmac("sha256", SECRET).update(dir + "\0" + archivePath).digest("hex").slice(0, 32);
  const file = diskPathFor(dir, archivePath);
  if (file) hiddenFiles.set(token, file);
  return `/media/x/${token}`;
}
export function hiddenMediaFile(token: string): string | undefined { return hiddenFiles.get(token); }

/** The pack is not used by any room any more: drop it from memory and delete its files. */
export async function forgetPack(hash: string, dataDir: string) {
  const dir = join(dataDir, "packs", hash);
  if (building.has(dir)) return;
  cache.delete(dir);
  for (const [token, file] of hiddenFiles) if (file.startsWith(dir + sep)) hiddenFiles.delete(token);
  await rm(dir, { recursive: true, force: true });
  await rm(join(dataDir, "packs", `${hash}.siq`), { force: true });
  await rm(join(dataDir, "packs", `${hash}.json`), { force: true });
}

export async function loadSharedPack(xml: string, files: SharedFile[], dataDir: string): Promise<LoadedPack> {
  const pack = await buildSharedPack(xml, files);
  const file = join(dataDir, "packs", `${pack.hash}.json`);
  if (!existsSync(file)) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ xml, files }));
  }
  return pack;
}



const cache = new Map<string, Promise<LoadedPack>>();
/** Packs being unpacked right now (never deleted under the unpacker's feet). */
const building = new Set<string>();

/**
 * File name on disk for one path segment of the archive. Windows can't store some characters,
 * and SIGame keeps names URI-escaped, so a Cyrillic name easily passes the 255-character limit:
 * long names become a short hash with the original extension.
 */
function diskName(segment: string): string {
  const safe = segment.replace(/[<>:"|?*\u0000-\u001f]/g, "_");
  if (safe.length <= 100) return safe;
  const ext = (/\.[A-Za-z0-9]{1,8}$/.exec(safe)?.[0] ?? "").toLowerCase();
  return createHash("sha1").update(segment).digest("hex").slice(0, 24) + ext;
}

export function diskPathFor(dir: string, archivePath: string): string | null {
  const full = resolve(dir, ...archivePath.split("/").map(diskName));
  return full.startsWith(resolve(dir) + sep) ? full : null;
}

export function mediaUrl(hash: string, archivePath: string): string {
  return `/media/${hash}/` + archivePath.split("/").map(encodeURIComponent).join("/");
}


export function loadPack(bytes: Uint8Array, dataDir: string): Promise<LoadedPack> {
  const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 16);
  // Keyed by folder: each data folder has its own copy of the files.
  const key = join(dataDir, "packs", hash);
  let p = cache.get(key);
  if (!p) {
    building.add(key);
    p = build(hash, bytes, dataDir);
    cache.set(key, p);
    p.then(() => building.delete(key), () => { building.delete(key); cache.delete(key); });
  }
  return p;
}

async function build(hash: string, bytes: Uint8Array, dataDir: string): Promise<LoadedPack> {
  const opened = await openPack(bytes);
  const dir = join(dataDir, "packs", hash);
  try {
    // The archive itself, for downloading after the game.
    const archive = join(dataDir, "packs", `${hash}.siq`);
    if (!existsSync(archive)) {
      await mkdir(dirname(archive), { recursive: true });
      await writeFile(archive, bytes);
    }
    // Files are written without blocking: other rooms keep playing while a big pack unpacks.
    const marker = join(dir, ".complete");
    if (!existsSync(marker)) {
      for (const f of opened.files) {
        const target = diskPathFor(dir, f.path);
        if (!target) continue;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await opened.read(f.path));
      }
      await mkdir(dir, { recursive: true });
      await writeFile(marker, "");
    }
  } finally {
    // The media are on disk now: the archive's bytes need not stay in memory.
    opened.close();
  }

  const media = (items: ContentItem[], hidden = false): MediaView[] =>
    items.map((it): MediaView => {
      if (it.type === "text" || it.type === "say") return { type: it.type, text: it.value, placement: it.placement };
      if (!it.isRef) return /^https?:\/\//i.test(it.value) ? { type: it.type, url: it.value, placement: it.placement } : { type: "text", text: it.value };
      const file = opened.resolve(it.value, it.type as MediaKind);
      if (!file) return { type: "text", text: hidden ? "[в паке нет файла]" : `[в паке нет файла «${it.value}»]` };
      return { type: it.type, url: hidden ? hiddenMediaUrl(dir, file.path) : mediaUrl(hash, file.path), placement: it.placement, duration: it.duration };
    });

  const { pack } = opened;
  const logo = pack.logo ? opened.resolve(pack.logo, "image") : undefined;
  const info: PackInfo = {
    name: pack.name,
    authors: pack.authors,
    version: pack.version,
    questions: opened.stats.questions,
    rounds: pack.rounds.map((r) => ({
      name: r.name,
      final: r.type === "final",
      themes: r.themes.length,
      questions: r.themes.reduce((n, t) => n + t.questions.length, 0),
    })),
    logo: logo ? mediaUrl(hash, logo.path) : undefined,
    lang: guessLang(pack),
    sizeMb: Math.round((bytes.length / 1048576) * 10) / 10,
  };
  return { hash, dir, opened: { pack: opened.pack, stats: opened.stats, resolve: opened.resolve }, info, media };
}
