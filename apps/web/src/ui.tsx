import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { REACTIONS, type MediaView, type PersonView, type TimerView } from "@kvz/protocol";
import { abs, getState, onReaction, send, useStore, type Reaction } from "./net.ts";
import { mediaUrl, readyUrl, shareVersion, subscribeShare, whenReady } from "./share.ts";
import { getPrefs } from "./prefs.ts";
import { tr, useT } from "./i18n.ts";

/* ---------- default animated avatars (SVG with SMIL, so they move like a GIF) ---------- */

const svg = (s: string) => "data:image/svg+xml," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>${s}</svg>`);
const blink = (x: number) => `<ellipse cx='${x}' cy='31' rx='3' ry='4' fill='#0b0f26'><animate attributeName='ry' values='4;4;0.4;4' keyTimes='0;0.9;0.95;1' dur='3.2s' repeatCount='indefinite'/></ellipse>`;
const PALETTES = [["#43f0c4", "#1f9e80", "#b9fff0"], ["#ff74b3", "#c94585", "#ffd6e8"], ["#8a7bff", "#5b4dd1", "#e6e2ff"], ["#ffd27a", "#d9a441", "#fff0cc"], ["#7ad7ff", "#3b8fc4", "#d8f3ff"], ["#ff9b6a", "#c4602d", "#ffe0cf"]];
const FACES = [
  (b: string, d: string, l: string) => `<rect width='64' height='64' fill='${b}'/><circle cx='32' cy='72' r='30' fill='${d}'/><circle cx='32' cy='32' r='17' fill='${l}'/><path d='M15 28q17-22 34 0q-8-6-17-6t-17 6z' fill='#0b2a24'/>${blink(25)}${blink(39)}<path d='M26 39q6 5 12 0' stroke='#0b0f26' stroke-width='2.5' fill='none' stroke-linecap='round'/>`,
  (b: string, d: string, l: string) => `<rect width='64' height='64' fill='${b}'/><circle cx='32' cy='72' r='30' fill='${d}'/><polygon points='16,22 20,6 28,18' fill='${l}'/><polygon points='48,22 44,6 36,18' fill='${l}'/><circle cx='32' cy='32' r='17' fill='${l}'/>${blink(25)}${blink(39)}<path d='M29 38l3 2 3-2' stroke='#0b0f26' stroke-width='2' fill='none'/>`,
  (b: string, d: string, l: string) => `<rect width='64' height='64' fill='${b}'/><circle cx='32' cy='72' r='30' fill='${d}'/><line x1='32' y1='10' x2='32' y2='17' stroke='${l}' stroke-width='2'/><circle cx='32' cy='9' r='3' fill='#ffd27a'><animate attributeName='fill' values='#ffd27a;#ff74b3;#43f0c4;#ffd27a' dur='1.6s' repeatCount='indefinite'/></circle><rect x='15' y='17' width='34' height='28' rx='8' fill='${l}'/><rect x='19' y='24' width='26' height='10' rx='5' fill='#0b0f26'/><circle cy='29' r='3' fill='#43f0c4'><animate attributeName='cx' values='23;41;23' dur='2s' repeatCount='indefinite'/></circle>`,
  (b: string, d: string, l: string) => `<rect width='64' height='64' fill='${b}'/><circle cx='32' cy='72' r='30' fill='${d}'/><circle cx='32' cy='32' r='14' fill='${l}'/><ellipse cx='32' cy='32' rx='24' ry='7' fill='none' stroke='#0b0f26' stroke-width='2' transform='rotate(-20 32 32)'/><g><animateTransform attributeName='transform' type='rotate' from='0 32 32' to='360 32 32' dur='4s' repeatCount='indefinite'/><circle cx='55' cy='32' r='4' fill='#ff74b3'/></g>${blink(27)}${blink(37)}`,
];
const cache = new Map<string, string>();
/** Animated SVG faces cost CPU per <img>, so long lists (chat, slots) use the still version. */
export function defaultAvatar(id: string, animated = true): string {
  const key = (animated ? "a:" : "s:") + id;
  let a = cache.get(key);
  if (!a) {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const [b, d, l] = PALETTES[h % PALETTES.length];
    let body = FACES[(h >>> 4) % FACES.length](b, d, l);
    if (!animated) body = body.replace(/<animate(Transform)?[^>]*\/>/g, "");
    a = svg(body);
    cache.set(key, a);
  }
  return a;
}
export const HOST_AVATAR = svg(`<rect width='64' height='64' fill='#dfe5ff'/><circle cx='32' cy='72' r='30' fill='#8a97d6'/><circle cx='32' cy='30' r='16' fill='#ffffff'/><g><animateTransform attributeName='transform' type='rotate' from='0 32 30' to='360 32 30' dur='6s' repeatCount='indefinite'/><path d='M32 4l3 7-3 2-3-2z' fill='#8a7bff'/></g>${blink(26)}${blink(38)}<path d='M27 37q5 4 10 0' stroke='#0b0f26' stroke-width='2.2' fill='none' stroke-linecap='round'/>`);
export const avatarSrc = (p: { id: string; avatar?: string }, animated = true) => abs(p.avatar) || defaultAvatar(p.id, animated);

/* ---------- time ---------- */

export function useNow(ms = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now + getState().offset;
}

export function secondsLeft(timer: TimerView | undefined, now: number) {
  if (!timer) return 0;
  if (timer.pausedLeft != null) return Math.ceil(timer.pausedLeft);
  return Math.max(0, Math.ceil((timer.endsAt - now) / 1000));
}

/**
 * Drain animation for a timer bar. It is computed once per timer (not per render), so
 * re-renders never restart the CSS animation — that restart was what made the bars jerk.
 */
export function useDrainStyle(timer?: TimerView): React.CSSProperties | undefined {
  const endsAt = timer?.endsAt;
  const paused = timer?.pausedLeft;
  const duration = timer?.duration ?? 1;
  return useMemo(() => {
    if (endsAt == null) return undefined;
    if (paused != null) return { transform: `scaleX(${Math.min(1, paused / duration)})` };
    const left = Math.max(0, (endsAt - (Date.now() + getState().offset)) / 1000);
    return { "--from": Math.min(1, left / duration), animation: `drainFrom ${left.toFixed(3)}s linear forwards` } as React.CSSProperties;
  }, [endsAt, paused, duration]);
}

function TimerSecs({ timer }: { timer: TimerView }) {
  const now = useNow(250);
  const t = useT();
  return <b>{secondsLeft(timer, now)} {t.sec}</b>;
}

export const TimerBar = memo(function TimerBar({ timer, label }: { timer?: TimerView; label?: string }) {
  const style = useDrainStyle(timer);
  const t = useT();
  if (!timer) return <div className="timer"><div className="timer-row"><span>{label ?? " "}</span></div><div className="bar"><i style={{ transform: "scaleX(0)" }} /></div></div>;
  return (
    <div className="timer">
      <div className="timer-row"><span>{label ?? t.timer[timer.kind]}{timer.pausedLeft != null ? t.paused : ""}</span><TimerSecs timer={timer} /></div>
      <div className={`bar ${timer.kind}`}><i key={timer.endsAt + ":" + (timer.pausedLeft ?? "")} style={style} /></div>
    </div>
  );
});

/* ---------- media ---------- */

/** How the host "reads" the question: karaoke text and pictures appearing line by line. */
export interface Reading {
  /** Server time the reading started. */
  startedAt: number;
  /** Characters per second. */
  speed: number;
  karaoke: boolean;
  /** Seconds for a picture to appear from the top; 0 = at once. */
  imageReveal: number;
}

/** Text whose letters change colour as they are read, like karaoke. Ticks only while it is being read. */
function Karaoke({ text, start, speed }: { text: string; start: number; speed: number }) {
  const calc = () => Math.max(0, Math.min(text.length, Math.floor(((Date.now() + getState().offset - start) / 1000) * speed)));
  const [n, setN] = useState(calc);
  useEffect(() => {
    if (calc() >= text.length) { setN(text.length); return; }
    const id = setInterval(() => {
      const v = calc();
      setN(v);
      if (v >= text.length) clearInterval(id);
    }, 40);
    return () => clearInterval(id);
  }, [text, start, speed]);
  return <><span className="sung">{text.slice(0, n)}</span><span className="unsung">{text.slice(n)}</span></>;
}

function RevealImage({ src, start, seconds }: { src?: string; start: number; seconds: number }) {
  const style = useMemo(() => {
    const elapsed = (Date.now() + getState().offset - start) / 1000;
    return { animation: `revealDown ${seconds}s steps(${Math.max(8, Math.round(seconds * 8))}, end) forwards`, animationDelay: `${-Math.max(0, elapsed)}s` };
  }, [src, start, seconds]);
  const t = useT();
  return <img src={src} alt={t.media.image} style={style} onLoad={keepAspect} />;
}

/**
 * Remembers a picture's or video's proportions in `--ar`, so CSS can scale it up
 * until it touches the sides or the top and bottom of its box.
 */
function keepAspect(e: React.SyntheticEvent<HTMLImageElement | HTMLVideoElement>) {
  const el = e.currentTarget;
  const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
  const h = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
  if (w > 0 && h > 0) el.style.setProperty("--ar", String(w / h));
}

/**
 * What a playing clip does: plays, pauses while a player answers ("hold"), or stays as it is
 * ("keep": paused stays paused, e.g. when the answer is shown).
 */
export type Playback = "play" | "hold" | "keep";

/** "WMV" for a type the browser surely can't play, else undefined. */
function unplayable(kind: "audio" | "video", mime?: string): string | undefined {
  if (!mime) return undefined;
  if (document.createElement(kind).canPlayType(mime) !== "") return undefined;
  return mime.split("/")[1].replace(/^x-(ms-)?/, "").replace("msvideo", "avi").toUpperCase();
}

/**
 * Plays as soon as it appears. Nobody gets controls (the game decides when it plays); if the
 * browser blocks sound, there is only a button to switch it on.
 */
function AutoMedia({ kind, src, mime, playback = "play" }: { kind: "audio" | "video"; src: string; mime?: string; playback?: Playback }) {
  const ref = useRef<HTMLMediaElement>(null);
  const [blocked, setBlocked] = useState(false);
  const [broken, setBroken] = useState(() => unplayable(kind, mime));
  /** Paused by us for an answer: plays on when the answer is over. */
  const held = useRef(false);
  const mode = useRef(playback);
  mode.current = playback;
  const t = useT();
  const start = (el: HTMLMediaElement) => {
    el.play().catch((e: Error) => {
      // Paused on purpose before it got going: not a blocked autoplay.
      if (e?.name === "AbortError") return;
      if (kind === "video") { el.muted = true; el.play().catch(() => {}); }
      setBlocked(true);
    });
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = getPrefs().volume;
    if (mode.current === "play") start(el);
    else held.current = true;
  }, [src, kind]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (playback === "hold") {
      if (!el.paused && !el.ended) { el.pause(); held.current = true; }
    } else if (playback === "play" && held.current) {
      held.current = false;
      if (!el.ended) start(el);
    }
  }, [playback]);
  const unlock = () => {
    const el = ref.current;
    if (!el) return;
    el.muted = false;
    el.play().then(() => setBlocked(false), () => {});
  };
  const block = (e: React.SyntheticEvent) => e.preventDefault();
  // The file is here but this browser can't decode it (WMV, AVI, an unusual codec).
  const failed = () => setBroken((b) => b ?? unplayable(kind, mime) ?? "");
  if (broken != null) return <span className="media-wait bad" role="status">{t.media.unsupported(kind, broken)}</span>;
  return (
    <>
      {kind === "video"
        ? <video ref={ref as React.RefObject<HTMLVideoElement>} src={src} playsInline onLoadedMetadata={keepAspect} onError={failed} disablePictureInPicture disableRemotePlayback controlsList="nodownload noplaybackrate nofullscreen" onContextMenu={block} />
        : <audio ref={ref as React.RefObject<HTMLAudioElement>} src={src} onError={failed} hidden />}
      {kind === "audio" && <span className="eq" aria-label={t.media.audio}><i /><i /><i /><i /><i /> {t.media.audio}</span>}
      {blocked && <button type="button" className="btn sm amber unmute" onClick={unlock}>{t.media.unmute}</button>}
    </>
  );
}

/**
 * Question content. `reading` turns on karaoke text and line-by-line pictures for the reading phase;
 * Sound and video have no controls for anyone: `playback` decides when they play.
 */
export function MediaList({ items, big = true, reading, playback, point }: { items: MediaView[]; big?: boolean; reading?: Reading; playback?: Playback; point?: PointLayer }) {
  const t = useT();
  // A point question is answered on its first picture.
  const pointAt = point ? items.findIndex((m) => m.type === "image") : -1;
  // Next to a picture or video, text is a one-line caption so the media get the room.
  const caption = big && items.some((m) => m.type === "image" || m.type === "video");
  let at = reading?.startedAt ?? 0;
  const nodes = items.map((m, i) => {
        const key = `${i}:${m.url ?? (m.file != null ? `f${m.file}` : m.text)}`;
        const start = at;
        if (reading) {
          if (m.type === "text" || m.type === "say") at += ((m.text ?? "").length / reading.speed) * 1000;
          else if (m.type === "image") at += Math.max(2.5, reading.imageReveal) * 1000;
          else if (m.type === "audio" || m.type === "video") at += (m.duration ?? 8) * 1000;
        }
        return <Later key={key} at={reading && i > 0 ? start : 0} box={m.type === "image" || m.type === "video" ? "q-media visual" : undefined}>{node(m, key, start)}</Later>;
  });
  function node(m: MediaView, key: string, start: number) {
        switch (m.type) {
          case "text": {
            const t = m.text ?? "";
            const len = t.length;
            const size = len > 260 ? "len-xl" : len > 160 ? "len-l" : len > 90 ? "len-m" : "";
            if (caption) return <OneLine key={key} text={t} className="q-text q-caption">{reading?.karaoke ? <Karaoke text={t} start={start} speed={reading.speed} /> : t}</OneLine>;
            return <p key={key} className={big ? `q-text ${size}` : ""}>{reading?.karaoke ? <Karaoke text={t} start={start} speed={reading.speed} /> : t}</p>;
          }
          case "say": return <p key={key} className="q-say">{t.media.host} {reading?.karaoke ? <Karaoke text={m.text ?? ""} start={start} speed={reading.speed} /> : m.text}</p>;
          case "image": if (items[pointAt] === m && point) return <div key={key} className="q-media visual"><WithSrc m={m}>{(src) => <PointImage src={src} layer={point} />}</WithSrc></div>;
            return <div key={key} className="q-media visual"><WithSrc m={m}>{(src) => reading && reading.imageReveal > 0 ? <RevealImage src={src} start={start} seconds={reading.imageReveal} /> : <img src={src} alt={t.media.image} onLoad={keepAspect} />}</WithSrc></div>;
          case "video": return <div key={key} className="q-media visual"><WithSrc m={m}>{(src) => <AutoMedia kind="video" src={src} mime={m.mime} playback={playback} />}</WithSrc></div>;
          case "audio": return <div key={key} className="q-media audio"><WithSrc m={m}>{(src) => <AutoMedia kind="audio" src={src} mime={m.mime} playback={playback} />}</WithSrc></div>;
          case "html": return <p key={key}><WithSrc m={m}>{(src) => <a href={src} target="_blank" rel="noreferrer">{t.media.html}</a>}</WithSrc></p>;
        }
  }
  // Two or more pictures/videos in a row share one line instead of stacking.
  const out: React.ReactNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const visual = (k: number) => items[k] && (items[k].type === "image" || items[k].type === "video");
    if (visual(i) && visual(i + 1)) {
      const group: React.ReactNode[] = [];
      while (visual(i)) group.push(nodes[i++]);
      i--;
      out.push(<div key={`row${i}`} className="media-row" style={{ "--n": group.length } as React.CSSProperties}>{group}</div>);
    } else out.push(nodes[i]);
  }
  return <>{out}</>;
}

/** What a point question draws over its picture, and where a click goes. */
export interface PointLayer {
  /** Set while this browser may answer: called with shares of the width and height and height/width. */
  onPick?: (x: number, y: number, ratio: number) => void;
  tries: { id: string; x: number; y: number; correct?: boolean; name?: string }[];
  /** The right spot and the allowance (share of the longer side). */
  answer?: { x: number; y: number; dev: number };
  /** This browser's click, before it's judged. */
  mine?: { x: number; y: number };
}

/** A picture to click on (point questions), with the clicks and, at the reveal, the right zone. */
function PointImage({ src, layer }: { src: string; layer: PointLayer }) {
  const t = useT();
  const [ratio, setRatio] = useState<number>();
  const [picked, setPicked] = useState<{ x: number; y: number }>();
  const canPick = !!layer.onPick;
  // A new chance to answer starts clean; my click shows at once, until it comes back judged.
  useEffect(() => { if (canPick) setPicked(undefined); }, [canPick]);
  const mine = canPick ? picked : layer.mine;
  const click = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!layer.onPick) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
    const img = e.currentTarget;
    const r = img.naturalWidth && img.naturalHeight ? img.naturalHeight / img.naturalWidth : box.height / box.width;
    setPicked({ x, y });
    layer.onPick(x, y, r);
  };
  const r = ratio ?? 1;
  const a = layer.answer;
  return (
    <span className={`point-wrap ${layer.onPick ? "pickable" : ""}`}>
      <img src={src} alt={t.media.image} onLoad={(e) => { keepAspect(e); const i = e.currentTarget; if (i.naturalWidth) setRatio(i.naturalHeight / i.naturalWidth); }} onClick={click} draggable={false} />
      {a && (
        // The allowance is a share of the longer side: a circle in pixels, so in shares of the width it's dev × max(1, h/w).
        <span className="point-zone" style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%`, width: `${2 * a.dev * Math.max(1, r) * 100}%` }} aria-label={t.q.pointRight} />
      )}
      {layer.tries.map((p, i) => (
        <span key={i} className={`point-mark ${p.correct ? "good" : p.correct === false ? "bad" : ""}`} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} title={p.name} />
      ))}
      {mine && <span className="point-mark mine" style={{ left: `${mine.x * 100}%`, top: `${mine.y * 100}%` }} />}
    </span>
  );
}

/**
 * Shows its children from server time `at` on (0 = at once). Until then a same-sized empty box keeps
 * the layout still, and media aren't mounted, so a video can't start early. Once shown, stays shown.
 */
function Later({ at, box, children }: { at: number; box?: string; children: ReactNode }) {
  const due = () => !at || Date.now() + getState().offset >= at;
  const [shown, setShown] = useState(due);
  useEffect(() => {
    if (shown) return;
    if (due()) { setShown(true); return; }
    const id = setTimeout(() => setShown(true), at - (Date.now() + getState().offset));
    return () => clearTimeout(id);
  }, [at, shown]);
  if (shown) return <>{children}</>;
  return box ? <div className={`${box} later`} aria-hidden="true" /> : null;
}

/**
 * Where to show a media item from: the server's link (built-in packs), or a shared pack's file once
 * it has arrived and been decrypted with the key the server gave for this moment.
 */
function useSrc(m: MediaView): string | undefined {
  const ver = useSyncExternalStore(subscribeShare, shareVersion);
  const [src, setSrc] = useState<string | undefined>(() => (m.url ? abs(m.url) : m.file != null ? readyUrl(m.file) : undefined));
  useEffect(() => {
    if (m.url) { setSrc(abs(m.url)); return; }
    if (m.file == null || !m.key) return;
    let live = true;
    void mediaUrl(m.file, m.key, m.mime).then((u) => { if (live && u) setSrc(u); });
    return () => { live = false; };
  }, [m.url, m.file, m.key, m.mime, ver]);
  return src;
}

/** A shared file that hasn't arrived yet shows a placeholder instead. */
function WithSrc({ m, children }: { m: MediaView; children: (src: string) => ReactNode }) {
  const src = useSrc(m);
  const t = useT();
  if (!src) return <span className="media-wait"><span className="spinner" />{t.media.waiting}</span>;
  return <>{children(src)}</>;
}

/* ---------- media preloading ---------- */

/** Loads a question's pictures, sound and video into the browser cache; resolves when done or after `ms`. */
export function preloadMedia(items: MediaView[], ms = 7000): Promise<void> {
  const media = items.filter((m) => m.type === "image" || m.type === "audio" || m.type === "video");
  // A shared pack's file: it is ready once it's here and decrypts.
  const shared = media.filter((m) => m.file != null && m.key).map((m) => whenReady(m.file!, m.key!, ms, m.mime));
  const jobs = media.filter((m) => m.url).map((m) => new Promise<void>((done) => {
    const url = abs(m.url)!;
    if (m.type === "image") {
      const img = new Image();
      img.onload = img.onerror = () => done();
      img.src = url;
      return;
    }
    const el = document.createElement(m.type as "audio" | "video") as HTMLMediaElement;
    el.preload = "auto";
    el.muted = true;
    const finish = () => { el.removeAttribute("src"); el.load(); done(); };
    el.addEventListener("canplaythrough", finish, { once: true });
    el.addEventListener("error", finish, { once: true });
    el.src = url;
    el.load();
  }));
  return Promise.race([Promise.all([...jobs, ...shared]).then(() => {}), new Promise<void>((ok) => setTimeout(ok, ms))]);
}

/* ---------- auto-fitting text ---------- */

/**
 * A question with no picture or video: its text grows to fill the box (never past `max` px,
 * never below its CSS size). Only on big screens, where the box has a fixed height.
 */
export function useGrowText(ref: React.RefObject<HTMLElement | null>, deps: unknown[], max = 96) {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const big = matchMedia("(min-width: 900px) and (min-height: 560px)");
    let busy = false;
    const fit = () => {
      if (busy) return;
      busy = true;
      try {
        const texts = [...box.querySelectorAll<HTMLElement>(".q-text:not(.one-line)")];
        for (const el of texts) el.style.fontSize = "";
        if (!texts.length || !big.matches || box.querySelector(".q-media.visual, .media-row")) return;
        const base = parseFloat(getComputedStyle(texts[0]).fontSize) || 20;
        const set = (px: number) => { for (const el of texts) el.style.fontSize = `${px}px`; };
        const fits = () => box.scrollHeight <= box.clientHeight + 1 && texts.every((el) => el.scrollWidth <= el.clientWidth + 1);
        if (!fits()) { for (const el of texts) el.style.fontSize = ""; return; }
        let lo = base, hi = Math.max(base, max);
        set(hi);
        if (fits()) return;
        for (let i = 0; i < 10 && hi - lo > 0.5; i++) {
          const mid = (lo + hi) / 2;
          set(mid);
          if (fits()) lo = mid; else hi = mid;
        }
        set(Math.floor(lo));
      } finally { busy = false; }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    // Lines that appear later (while the question is read) and pictures that arrive change the room left.
    const mo = new MutationObserver(fit);
    mo.observe(box, { childList: true, subtree: true });
    big.addEventListener("change", fit);
    return () => { ro.disconnect(); mo.disconnect(); big.removeEventListener("change", fit); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * Always one line: the font shrinks (down to 60 % of the CSS size) until the text fits;
 * if it still doesn't, it ends with "…" and the full text shows in a tooltip on hover.
 */
export function OneLine({ text, className, children }: { text: string; className?: string; children?: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [cut, setCut] = useState(false);
  const [tip, setTip] = useState<{ x: number; y: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.fontSize = "";
      const max = parseFloat(getComputedStyle(el).fontSize) || 20;
      const fits = () => el.scrollWidth <= el.clientWidth + 1;
      if (fits()) return setCut(false);
      let lo = Math.max(12, max * 0.6), hi = max;
      el.style.fontSize = `${lo}px`;
      if (!fits()) return setCut(true);
      for (let i = 0; i < 10 && hi - lo > 0.25; i++) {
        const mid = (lo + hi) / 2;
        el.style.fontSize = `${mid}px`;
        if (fits()) lo = mid; else hi = mid;
      }
      el.style.fontSize = `${lo}px`;
      setCut(false);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (cut && r) setTip({ x: r.left, y: r.bottom + 6, w: r.width });
  };
  return (
    <>
      <p ref={ref} className={`${className ?? ""} one-line ${cut ? "cut" : ""}`} tabIndex={cut ? 0 : undefined}
        onMouseEnter={show} onMouseLeave={() => setTip(null)} onFocus={show} onBlur={() => setTip(null)}>
        {children ?? text}
      </p>
      {tip && createPortal(<div className="line-tip" role="tooltip" style={{ left: tip.x, top: tip.y, maxWidth: tip.w }}>{text}</div>, document.body)}
    </>
  );
}

/**
 * Text that shrinks until it fits its box, wrapping onto as many lines as the box allows.
 * The box's own CSS font size is the largest size used; `min` is the floor.
 */
export const FitText = memo(function FitText({ text, min = 9, className }: { text: string; min?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const fit = () => {
      el.style.fontSize = "";
      const max = parseFloat(getComputedStyle(box).fontSize) || 16;
      const cs = getComputedStyle(box);
      const availH = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const fits = () => el.scrollHeight <= availH + 1 && el.scrollWidth <= el.clientWidth + 1;
      let lo = min, hi = max;
      el.style.fontSize = `${hi}px`;
      if (fits()) return;
      for (let i = 0; i < 12 && hi - lo > 0.25; i++) {
        const mid = (lo + hi) / 2;
        el.style.fontSize = `${mid}px`;
        if (fits()) lo = mid; else hi = mid;
      }
      el.style.fontSize = `${lo}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [text, min]);
  return <span ref={ref} className={`fit-text ${className ?? ""}`} title={text}>{text}</span>;
});

/* ---------- modal ---------- */

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Seg<T extends string | number | boolean>({ value, options, onChange, disabled }: { value: T; options: [T, string][]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={String(v)} type="button" aria-pressed={v === value} disabled={disabled} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

export const Mic = () => (
  <span className="mic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg></span>
);

/* ---------- anonymous pack ---------- */

/** In place of a pack name the host hid: a lock and a striped "redacted" pill. */
export function HiddenName({ className }: { className?: string }) {
  const t = useT();
  return <span className={`hidden-name ${className ?? ""}`} title={t.anon.hiddenTitle}><Lock />{t.anon.hidden}</span>;
}

/** Cover for a hidden pack: no gradient from the name, just stripes and a lock. */
export function HiddenCover({ className }: { className: string }) {
  return <span className={`${className} hidden-cover`} aria-hidden="true"><Lock /></span>;
}

/** The pack's name as this member may see it; the host also gets a "hidden from players" mark. */
export function PackName({ pack, host }: { pack: { name: string; hidden?: boolean; revealed?: boolean }; host: boolean }) {
  const t = useT();
  if (!pack.hidden || pack.revealed) return <>{pack.name}</>;
  if (!host) return <HiddenName />;
  return <>{pack.name} <span className="anon-badge" title={t.anon.badgeTitle}><Lock />{t.anon.badge}</span></>;
}

export const Lock = () => (
  <svg className="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label={useT().media.locked}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);

export function initials(s: string) {
  return s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}

const COVERS = [["#ff74b3", "#8a7bff"], ["#43f0c4", "#3b6dff"], ["#ffd27a", "#ff7a4d"], ["#8a7bff", "#ff74b3"], ["#43f0c4", "#ffd27a"], ["#3b6dff", "#43f0c4"]];
export function coverGradient(s: string) {
  let h = 0;
  for (const c of s) h = (h * 17 + c.charCodeAt(0)) >>> 0;
  const [a, b] = COVERS[h % COVERS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

export function readImageFile(file: File, maxBytes = 2.5 * 1024 * 1024): Promise<string> {
  return new Promise((ok, fail) => {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return fail(new Error(tr().profile.badImage));
    if (file.size > maxBytes) return fail(new Error(tr().profile.bigImage));
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(new Error(tr().profile.readFail));
    r.readAsDataURL(file);
  });
}

export function toggleFullscreen() {
  if (window.kvz?.toggleFullscreen) return window.kvz.toggleFullscreen();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

/* ---------- connection marks ---------- */

/** "1:42" */
export const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/**
 * On a person's picture: while online, a dot for how the room reaches them (peer mode only:
 * green directly, yellow through another player, orange through the relays); while away, a veil
 * with the time left before the room lets them go.
 */
export function LinkMark({ p }: { p: PersonView }) {
  const t = useT();
  if (!p.online) return <AwayVeil goneAt={p.goneAt} />;
  if (!p.link) return null;
  const title = p.link === 1 ? t.link.direct : p.link === 2 ? t.link.relay : t.link.far;
  return <span className={`link-dot l${p.link}`} title={title} aria-label={title} role="img" />;
}

function AwayVeil({ goneAt }: { goneAt?: number }) {
  const t = useT();
  const now = useNow(1000);
  const left = goneAt != null ? goneAt - now : undefined;
  return (
    <span className="off" title={left != null ? t.link.awayTitle(mmss(left)) : t.link.reconnecting}>
      <span>{t.offline}</span>
      {left != null && <small>{left > 0 ? mmss(left) : t.link.leaving}</small>}
    </span>
  );
}

/** "Offline · 1:42" for lists. */
export function AwayText({ p }: { p: PersonView }) {
  const t = useT();
  const now = useNow(1000);
  const left = p.goneAt != null ? p.goneAt - now : undefined;
  return <span title={left != null ? t.link.awayTitle(mmss(left)) : undefined}>{t.offline}{left != null ? ` · ${left > 0 ? mmss(left) : t.link.leaving}` : ""}</span>;
}

/** This browser's own way to its room, when it isn't the usual one. */
export function LinkBanner() {
  const link = useStore((s) => s.link);
  const t = useT();
  if (!link) return null;
  return <div className={`link-banner ${link}`} role="status">{link === "lost" ? t.link.lost : t.link.farMe}</div>;
}

/* ---------- reactions ---------- */

const MAX_FLYING = 24;
/** Emoji flying up over the game, with who sent them. */
export function ReactionLayer({ names }: { names: (id: string) => string | undefined }) {
  const [flying, setFlying] = useState<(Reaction & { x: number })[]>([]);
  const namesRef = useRef(names);
  namesRef.current = names;
  useEffect(() => onReaction((r) => {
    const item = { ...r, x: 8 + Math.random() * 84 };
    setFlying((f) => [...f.slice(-(MAX_FLYING - 1)), item]);
    setTimeout(() => setFlying((f) => f.filter((x) => x.key !== r.key)), 2800);
  }), []);
  if (!flying.length) return null;
  return (
    <div className="reaction-layer" aria-hidden="true">
      {flying.map((r) => (
        <span key={r.key} className="reaction" style={{ left: `${r.x}%` }}>
          <span className="emo">{r.e}</span><small>{namesRef.current(r.from)}</small>
        </span>
      ))}
    </div>
  );
}

/** A row of reactions; the room lets through a few per person, so the buttons pause after a click. */
export function ReactBar() {
  const t = useT();
  const [cool, setCool] = useState(false);
  const recent = useRef<number[]>([]);
  const fire = (e: string) => {
    const now = Date.now();
    recent.current = recent.current.filter((x) => now - x < 8000);
    if (cool || recent.current.length >= 5) return;
    recent.current.push(now);
    send({ t: "react", e });
    setCool(true);
    setTimeout(() => setCool(false), recent.current.length >= 5 ? 8000 - (now - recent.current[0]) : 650);
  };
  return (
    <div className="react-bar" role="group" aria-label={t.react.title}>
      {REACTIONS.map((e) => <button key={e} type="button" disabled={cool} onClick={() => fire(e)} aria-label={t.react.send(e)} title={t.react.send(e)}>{e}</button>)}
    </div>
  );
}
