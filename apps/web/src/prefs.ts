import { useSyncExternalStore } from "react";
import type { SoundEvent } from "./sounds.ts";

/** Per-device preferences: they never leave this browser. */
export interface Prefs {
  lang: "ru" | "en";
  /** Pack audio and video, 0..1 */
  volume: number;
  /** Interface signals (buttons open, your turn, right/wrong), 0..1 */
  sfx: number;
  /** Which variant each game signal plays (see sounds.ts); -1 = off. */
  sounds?: Partial<Record<SoundEvent, number>>;
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
