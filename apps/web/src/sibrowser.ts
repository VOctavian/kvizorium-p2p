/**
 * The SIBrowser pack library (https://www.sibrowser.ru): search and download right from the game.
 *
 * SIBrowser has no API and doesn't let other sites read it from a browser, so everything goes
 * through a small proxy that forwards only its search pages and pack downloads: the game server's
 * /sib/ (and Vite's, while developing), or a Cloudflare Worker for the serverless version
 * (deploy/sib-proxy.worker.js, its address in the build setting VITE_SIB_PROXY). Pages come as
 * HTML and are read here.
 */
import { MAX_PACK_MB } from "@kvz/protocol";

const SITE = "https://www.sibrowser.ru";
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export interface SibPack {
  id: number;
  name: string;
  author?: string;
  date?: string;
  sizeText?: string;
  sizeMb?: number;
  tags: string[];
  categories: string[];
  description?: string;
  rounds: { name: string; themes: string }[];
  questions?: number;
  media?: { text: number; photo: number; audio: number; video: number };
  logo: string;
  page: string;
}

export interface SibQuery { q?: string; sort?: "date" | "downloads"; category?: string; tag?: string; page?: number }

/** SIBrowser's categories with their names on its site. */
export const SIB_CATEGORIES: { id: string; name: string }[] = [
  { id: "music", name: "Музыка" }, { id: "videogames", name: "Видеоигры" }, { id: "anime", name: "Аниме" },
  { id: "movies", name: "Кино" }, { id: "social", name: "Общественные науки" }, { id: "meme", name: "Мемы" },
];
/** Its most used tags. */
export const SIB_TAGS = ["Общие знания", "Смешанная (солянка)", "Музыка", "Игры", "Кино", "Аниме", "Сериалы", "Мультфильмы", "Мемы", "Эрудиция", "История", "Юмор"];

/** Where the proxy is; undefined when this build has none. */
export function sibBase(serverBase: string, peerMode: boolean): string | undefined {
  try { const own = localStorage.getItem("kvz.sib"); if (own) return own.replace(/\/+$/, ""); } catch { /* blocked */ }
  if (env.VITE_SIB_PROXY) return env.VITE_SIB_PROXY.replace(/\/+$/, "");
  if (!peerMode) return `${serverBase}/sib`;
  return env.DEV ? "/sib" : undefined;
}

function pathFor(q: SibQuery): string {
  const p = new URLSearchParams();
  if (q.sort === "downloads") p.set("sort", "download_count");
  if (q.page && q.page > 1) p.set("page", String(q.page));
  let path = "/";
  const text = q.q?.trim();
  if (text) { path = "/packages"; p.set("q", text); }
  else if (q.tag) path = `/tags/${encodeURIComponent(q.tag)}`;
  else if (q.category) path = `/categories/${encodeURIComponent(q.category)}`;
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

const clean = (s?: string | null) => (s ?? "").replace(/\s+/g, " ").trim();

function sizeMb(text: string): number | undefined {
  const m = /([\d\s]+(?:[.,]\d+)?)\s*(КБ|МБ|ГБ|KB|MB|GB)/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1].replace(/\s/g, "").replace(",", "."));
  const unit = m[2].toUpperCase();
  return unit.startsWith("К") || unit.startsWith("K") ? n / 1024 : unit.startsWith("Г") || unit.startsWith("G") ? n * 1024 : n;
}

function parseCard(a: Element): SibPack | undefined {
  const link = [...a.querySelectorAll("a[href^='/packages/']")].map((x) => /^\/packages\/(\d+)$/.exec(x.getAttribute("href") ?? "")).find(Boolean);
  if (!link) return undefined;
  const id = Number(link[1]);
  const text = clean(a.textContent);
  const media = /Текст\s*(\d+)%\s*Фото\s*(\d+)%\s*Звук\s*(\d+)%\s*Видео\s*(\d+)%/.exec(text);
  const cats = /Категории\s+(.+?)(?:Играть|Скачать|$)/.exec(text)?.[1] ?? "";
  const rounds: SibPack["rounds"] = [];
  const head = [...a.querySelectorAll("h2")].find((h) => /Темы в раундах/.test(h.textContent ?? ""));
  if (head?.parentElement) {
    for (const span of head.parentElement.querySelectorAll("span.text-neutral-500")) {
      rounds.push({ name: clean(span.previousSibling?.textContent).replace(/:$/, ""), themes: clean(span.textContent) });
    }
  }
  const sizeText = clean(a.querySelector("[itemprop=contentSize]")?.textContent) || undefined;
  return {
    id,
    name: clean(a.querySelector("[itemprop~=headline]")?.textContent) || `#${id}`,
    author: clean(a.querySelector("[itemprop=author] [itemprop=name]")?.textContent) || undefined,
    date: clean(a.querySelector("time")?.textContent) || undefined,
    sizeText,
    sizeMb: sizeText ? sizeMb(sizeText) : undefined,
    tags: [...a.querySelectorAll("a[rel=tag]")].map((x) => clean(x.textContent)).filter(Boolean),
    categories: [...cats.matchAll(/([А-ЯЁA-Z][А-Яа-яЁёA-Za-z. ]+?)\s+\d+%/g)].map((m) => m[1].trim()),
    description: clean(a.querySelector("[itemprop=description]")?.textContent) || undefined,
    rounds,
    questions: Number(/(\d+)\s+вопрос/.exec(text)?.[1]) || undefined,
    media: media ? { text: +media[1], photo: +media[2], audio: +media[3], video: +media[4] } : undefined,
    logo: `${SITE}/packages/${id}/logo.webp`,
    page: `${SITE}/packages/${id}`,
  };
}

export class SibError extends Error {}

/** One page of results (SIBrowser gives 5 a page); `more`: there is a next page. */
export async function searchSib(base: string, q: SibQuery, signal?: AbortSignal): Promise<{ total?: number; items: SibPack[]; more: boolean }> {
  let res: Response;
  try { res = await fetch(base + pathFor(q), { signal }); } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new SibError("network");
  }
  if (!res.ok) throw new SibError(String(res.status));
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  let items = [...doc.querySelectorAll("article")].map(parseCard).filter((x): x is SibPack => !!x);
  // A text search can't be narrowed by category on the site: done here, on what came.
  const cat = q.q?.trim() && q.category ? SIB_CATEGORIES.find((c) => c.id === q.category)?.name : undefined;
  if (cat) items = items.filter((p) => p.categories.includes(cat));
  const total = Number(doc.querySelector("meta[itemprop=numberOfItems]")?.getAttribute("content")) || undefined;
  return { total, items, more: !!doc.querySelector("a[rel=next]") };
}

export const tooBig = (p: SibPack) => (p.sizeMb ?? 0) > MAX_PACK_MB;

/** Downloads a pack through the proxy, as a file to load like one picked from the disk. */
export async function downloadSib(base: string, p: SibPack, onProgress: (share: number) => void, signal?: AbortSignal): Promise<File> {
  const res = await fetch(`${base}/packages/${p.id}/direct_download`, { signal });
  if (!res.ok || !res.body) throw new SibError(String(res.status));
  const total = Number(res.headers.get("content-length")) || (p.sizeMb ? p.sizeMb * 1048576 : 0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (got > MAX_PACK_MB * 1048576) { void reader.cancel(); throw new SibError("tooBig"); }
    if (total) onProgress(Math.min(1, got / total));
  }
  const name = `${p.name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100)}.siq`;
  return new File(parts as BlobPart[], name, { type: "application/zip" });
}
