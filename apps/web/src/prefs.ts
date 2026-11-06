import { useSyncExternalStore } from "react";

/** Per-device preferences: they never leave this browser. */
export interface Prefs {
  lang: "ru" | "en";
  /** Pack audio and video, 0..1 */
  volume: number;
  /** Interface signals (buttons open, your turn, right/wrong), 0..1 */
  sfx: number;
  /** Graphics level: fewer animations, normal, frosted glass. */
  fx: "low" | "mid" | "high";
  motion: "full" | "reduced";
  /** Hotkeys: answer (press the button) and pass. */
  answerKey: string;
  passKey: string;
  /** Host keys: scoring an answer and the "jump forward". */
  hostKeys: HostKeys;
}

export interface HostKeys { right: string; wrong: string; x2: string; zero: string; half: string; minus2: string; minusHalf: string; advance: string }
export const HOST_KEY_DEFAULTS: HostKeys = {
  right: "NumpadAdd", wrong: "NumpadSubtract", x2: "Numpad2", zero: "Numpad0", half: "Numpad1", minus2: "Numpad9", minusHalf: "Numpad6", advance: "ArrowRight",
};

const DEFAULTS: Prefs = { lang: "ru", volume: 0.8, sfx: 0.5, fx: "mid", motion: "full", answerKey: "Space", passKey: "Control", hostKeys: HOST_KEY_DEFAULTS };
const KEY = "kvz.prefs";

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    const oldFx = localStorage.getItem("kvz.fx");
    return { ...DEFAULTS, ...(oldFx === "low" || oldFx === "high" ? { fx: oldFx } : {}), ...raw, hostKeys: { ...HOST_KEY_DEFAULTS, ...(raw.hostKeys ?? {}) } };
  } catch {
    return { ...DEFAULTS };
  }
}

let prefs = load();
const listeners = new Set<() => void>();

function apply(p: Prefs) {
  const root = document.documentElement;
  root.dataset.fx = p.fx;
  root.dataset.motion = p.motion;
  root.lang = p.lang;
  for (const el of document.querySelectorAll<HTMLMediaElement>("audio, video")) el.volume = p.volume;
}

export function initPrefs() { apply(prefs); }
export const getPrefs = () => prefs;
export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* storage blocked */ }
  apply(prefs);
  listeners.forEach((l) => l());
}
export function usePrefs(): Prefs {
  return useSyncExternalStore((l) => (listeners.add(l), () => { listeners.delete(l); }), () => prefs);
}

/* ---------- interface signals (Web Audio, no files) ---------- */

let ctx: AudioContext | undefined;
const TUNES: Record<string, [number, number][]> = {
  open: [[880, 0.09]],
  turn: [[660, 0.1], [880, 0.14]],
  good: [[523, 0.09], [659, 0.09], [784, 0.16]],
  bad: [[311, 0.14], [233, 0.22]],
  test: [[660, 0.1], [784, 0.1], [988, 0.14]],
};

export function signal(kind: keyof typeof TUNES) {
  const vol = prefs.sfx;
  if (!vol) return;
  try {
    ctx ??= new AudioContext();
    let t = ctx.currentTime + 0.01;
    for (const [freq, len] of TUNES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25 * vol, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + len + 0.02);
      t += len * 0.9;
    }
  } catch { /* audio unavailable */ }
}
