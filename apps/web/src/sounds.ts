/**
 * Game signals, made with Web Audio (no files). Every moment has a few variants to pick from in
 * Settings; the choice lives in this browser only.
 */
import { getPrefs } from "./prefs.ts";

export const SOUND_EVENTS = [
  "open", "turn", "buzz", "good", "bad", "zero", "timeUp",
  "secret", "auction", "noRisk", "stakeAll", "round", "final", "gameOver",
] as const;
export type SoundEvent = (typeof SOUND_EVENTS)[number];

/** One sound: tones and noise bursts laid out in time (seconds from the start). */
interface Tone {
  at: number;
  /** Hz; `to` slides there by the end. */
  f: number;
  to?: number;
  d: number;
  wave?: OscillatorType;
  /** Loudness 0..1 (before the volume setting). */
  g?: number;
  /** Vibrato depth, Hz. */
  vib?: number;
  /** Seconds to fade in (default: a click-free 10 ms). */
  attack?: number;
}
interface Noise { at: number; d: number; g?: number; /** band-pass centre, Hz */ band?: number; q?: number; /** band slides there */ bandTo?: number }
interface Sound { tones?: Tone[]; noise?: Noise[] }

/* ---------- little helpers to write sounds ---------- */

const N: Record<string, number> = {};
{
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  for (let o = 1; o <= 7; o++) names.forEach((n, i) => { N[n + o] = 440 * 2 ** ((o - 4) + (i - 9) / 12); });
}
/** Notes one after another: [note, seconds] pairs. */
const seq = (notes: [string, number][], wave: OscillatorType = "triangle", g = 0.6, gap = 0.92): Tone[] => {
  let at = 0;
  return notes.map(([n, d]) => { const t = { at, f: N[n], d, wave, g }; at += d * gap; return t; });
};
/** Notes together. */
const chord = (notes: string[], d: number, at = 0, wave: OscillatorType = "triangle", g = 0.35): Tone[] => notes.map((n) => ({ at, f: N[n], d, wave, g }));
/** A bell: a note with a quieter overtone, long decay. */
const bell = (n: string, at: number, d = 0.9, g = 0.5): Tone[] => [{ at, f: N[n], d, wave: "sine", g }, { at, f: N[n] * 2.76, d: d * 0.5, wave: "sine", g: g * 0.25 }];
const drumroll = (from: number, len: number, step = 0.045, g = 0.9): Noise[] =>
  Array.from({ length: Math.round(len / step) }, (_, i) => ({ at: from + i * step, d: 0.05, g: g * (0.6 + 0.4 * (i / (len / step))), band: 1800, q: 0.8 }));

/* ---------- the variants ---------- */

export const VARIANTS: Record<SoundEvent, Sound[]> = {
  /** Buttons open: answer now. */
  open: [
    { tones: [{ at: 0, f: 880, d: 0.09 }] },
    { tones: [...bell("B5", 0, 0.35, 0.45), ...bell("E6", 0.08, 0.45, 0.4)] },
    { noise: [{ at: 0, d: 0.22, g: 0.35, band: 600, bandTo: 5000, q: 2 }], tones: [{ at: 0.18, f: 1320, d: 0.12, wave: "sine", g: 0.4 }] },
    { tones: [{ at: 0, f: 600, to: 1400, d: 0.14, wave: "square", g: 0.55 }] },
  ],
  /** Your turn to choose. */
  turn: [
    { tones: seq([["E5", 0.1], ["A5", 0.14]]) },
    { tones: seq([["C5", 0.08], ["E5", 0.08], ["G5", 0.08], ["C6", 0.18]], "sine", 0.5) },
    { tones: [...bell("A5", 0, 0.5), ...bell("A5", 0.16, 0.6)] },
    { tones: [{ at: 0, f: 392, d: 0.08, wave: "sine", g: 0.7 }, { at: 0.1, f: 523, d: 0.16, wave: "sine", g: 0.7 }] },
  ],
  /** Someone pressed the button. */
  buzz: [
    { tones: [{ at: 0, f: 1047, d: 0.12, wave: "sine", g: 0.6 }] },
    { tones: [{ at: 0, f: 220, d: 0.28, wave: "square", g: 0.3 }, { at: 0, f: 223, d: 0.28, wave: "square", g: 0.3 }] },
    { tones: bell("G6", 0, 0.5, 0.5) },
    { tones: [{ at: 0, f: 700, to: 1100, d: 0.07, wave: "triangle", g: 0.6 }, { at: 0.07, f: 1100, d: 0.1, wave: "triangle", g: 0.5 }] },
  ],
  /** Right answer. */
  good: [
    { tones: seq([["C5", 0.09], ["E5", 0.09], ["G5", 0.16]]) },
    { tones: [...bell("E6", 0, 0.7), ...bell("G#6", 0.12, 0.9)] },
    { tones: [...seq([["G4", 0.08], ["C5", 0.08], ["E5", 0.08]], "square", 0.45), ...chord(["G5", "C6", "E6"], 0.45, 0.22, "square", 0.22)] },
    { tones: [{ at: 0, f: N.B5, d: 0.07, wave: "square", g: 0.55 }, { at: 0.07, f: N.E6, d: 0.3, wave: "square", g: 0.55 }] },
  ],
  /** Wrong answer. */
  bad: [
    { tones: seq([["D#4", 0.14], ["A#3", 0.22]]) },
    { tones: [{ at: 0, f: 110, d: 0.55, wave: "sawtooth", g: 0.28, vib: 6 }, { at: 0, f: 116, d: 0.55, wave: "sawtooth", g: 0.2 }] },
    { tones: [
      { at: 0, f: N.G4, to: N["F#4"], d: 0.32, wave: "triangle", g: 0.55 },
      { at: 0.33, f: N["F#4"], to: N.F4, d: 0.32, wave: "triangle", g: 0.55 },
      { at: 0.66, f: N.F4, to: N.D4, d: 0.7, wave: "triangle", g: 0.55, vib: 5 },
    ] },
    { tones: [{ at: 0, f: 160, to: 60, d: 0.3, wave: "sine", g: 0.9 }], noise: [{ at: 0, d: 0.12, g: 0.3, band: 300, q: 1 }] },
  ],
  /** Zero points: judged ×0, or nobody got it. */
  zero: [
    { tones: [{ at: 0, f: 440, d: 0.12, wave: "sine", g: 0.5 }, { at: 0.16, f: 440, d: 0.16, wave: "sine", g: 0.5 }] },
    { tones: [{ at: 0, f: 620, to: 380, d: 0.35, wave: "sine", g: 0.55 }] },
    { tones: seq([["A4", 0.12], ["A4", 0.12], ["E4", 0.26]], "triangle", 0.45, 1.05) },
    { noise: [{ at: 0, d: 0.05, g: 1, band: 2500, q: 1 }, { at: 0.14, d: 0.05, g: 1, band: 2000, q: 1 }] },
  ],
  /** Time's up, nobody pressed. */
  timeUp: [
    { tones: [{ at: 0, f: 330, d: 0.18, wave: "square", g: 0.5 }, { at: 0.24, f: 330, d: 0.3, wave: "square", g: 0.5 }] },
    { tones: bell("C5", 0, 1.4, 0.6) },
    { noise: [0, 0.25, 0.5, 0.75].map((at, i) => ({ at, d: 0.03, g: 0.35, band: i % 2 ? 1800 : 2600, q: 4 })), tones: [{ at: 1.0, f: 880, d: 0.4, wave: "sine", g: 0.45 }] },
  ],
  /** Кот в мешке. */
  secret: [
    { tones: [{ at: 0, f: 700, to: 1150, d: 0.18, wave: "sine", g: 0.5 }, { at: 0.18, f: 1150, to: 620, d: 0.35, wave: "sine", g: 0.5, vib: 8 }] },
    { tones: [...seq([["A4", 0.18], ["C5", 0.18], ["E5", 0.18], ["G#5", 0.5]], "sine", 0.45, 1)].map((t) => ({ ...t, vib: 4 })) },
    { noise: [{ at: 0, d: 0.35, g: 0.3, band: 400, bandTo: 4000, q: 2 }], tones: [{ at: 0.35, f: 1200, to: 1800, d: 0.08, wave: "sine", g: 0.6 }, ...bell("E6", 0.43, 0.6)] },
    { tones: [{ at: 0, f: 520, to: 900, d: 0.12, wave: "triangle", g: 0.5 }, { at: 0.14, f: 900, to: 500, d: 0.25, wave: "triangle", g: 0.5 }, { at: 0.5, f: 650, to: 1000, d: 0.12, wave: "triangle", g: 0.45 }] },
  ],
  /** Auction (stakes). */
  auction: [
    { tones: [{ at: 0, f: 140, to: 80, d: 0.14, wave: "sine", g: 0.9 }, { at: 0.22, f: 140, to: 80, d: 0.14, wave: "sine", g: 0.9 }], noise: [{ at: 0, d: 0.05, g: 0.5, band: 1200, q: 1 }, { at: 0.22, d: 0.05, g: 0.5, band: 1200, q: 1 }] },
    { tones: seq([["C5", 0.07], ["D5", 0.07], ["E5", 0.07], ["G5", 0.07], ["C6", 0.25]], "square", 0.55) },
    { noise: [{ at: 0, d: 0.06, g: 0.45, band: 3000, q: 1 }], tones: [...bell("C7", 0.06, 0.6, 0.35), ...bell("E7", 0.12, 0.7, 0.3)] },
    { noise: drumroll(0, 0.6), tones: chord(["C4", "G4", "C5"], 0.5, 0.62, "sawtooth", 0.2) },
  ],
  /** Question without risk. */
  noRisk: [
    { tones: chord(["C5", "E5", "G5"], 0.7, 0, "sine", 0.3) },
    { tones: [...bell("C6", 0, 0.6, 0.35), ...bell("E6", 0.07, 0.6, 0.3), ...bell("G6", 0.14, 0.8, 0.3)] },
    { tones: seq([["G4", 0.12], ["B4", 0.12], ["D5", 0.3]], "sine", 0.5) },
  ],
  /** Stakes for everyone. */
  stakeAll: [
    { noise: drumroll(0, 0.9), tones: chord(["D4", "A4", "D5"], 0.4, 0.92, "sawtooth", 0.2) },
    { tones: seq([["D5", 0.1], ["D5", 0.1], ["A5", 0.35]], "square", 0.55, 1.1) },
    { tones: chord(["C4", "E4", "G4", "C5"], 0.9, 0, "triangle", 0.25).map((t) => ({ ...t, attack: 0.4 })) },
  ],
  /** A new round begins. */
  round: [
    { tones: [...seq([["G4", 0.1], ["C5", 0.1], ["E5", 0.1]], "square", 0.45), ...chord(["C5", "E5", "G5", "C6"], 0.6, 0.28, "square", 0.2)] },
    { noise: [{ at: 0, d: 0.4, g: 0.3, band: 300, bandTo: 3000, q: 1.5 }], tones: chord(["D5", "F#5", "A5"], 0.7, 0.35, "triangle", 0.3) },
    { tones: [...bell("C6", 0, 0.8), ...bell("G5", 0.2, 0.8), ...bell("C6", 0.4, 1.1)] },
  ],
  /** The final round. */
  final: [
    { tones: chord(["C3", "G3", "C4", "D#4"], 1.6, 0, "sawtooth", 0.2).map((t) => ({ ...t, attack: 0.6 })) },
    { noise: drumroll(0, 1.1), tones: [...chord(["C4", "G4", "C5", "E5"], 0.9, 1.12, "square", 0.2)] },
    { tones: seq([["A3", 0.3], ["C4", 0.3], ["E4", 0.3], ["A4", 0.8]], "triangle", 0.5, 1).map((t) => ({ ...t, vib: 3 })) },
  ],
  /** The game is over. */
  gameOver: [
    { tones: [...seq([["C5", 0.12], ["E5", 0.12], ["G5", 0.12], ["C6", 0.12], ["G5", 0.1]], "square", 0.45), ...chord(["C5", "E5", "G5", "C6"], 0.9, 0.56, "square", 0.2)] },
    // Applause: lots of short random claps.
    { noise: Array.from({ length: 70 }, (_, i) => ({ at: (i / 70) * 2.2 + Math.sin(i * 12.9898) * 0.02 + 0.02, d: 0.025, g: 0.7 + 0.3 * Math.abs(Math.sin(i * 78.233)), band: 1500 + 1000 * Math.abs(Math.sin(i * 3.7)), q: 1.2 })) },
    { tones: ["C6", "G5", "E5", "C5", "E5", "G5", "C6", "E6"].flatMap((n, i) => bell(n, i * 0.12, 0.9, 0.3)) },
    { tones: seq([["G4", 0.15], ["G4", 0.15], ["G4", 0.15], ["D#5", 0.7]], "triangle", 0.5, 1.05) },
  ],
};

/** Which variant plays by default (index into VARIANTS). */
export const DEFAULT_SOUNDS: Record<SoundEvent, number> = {
  open: 0, turn: 0, buzz: 0, good: 0, bad: 0, zero: 0, timeUp: 0,
  secret: 0, auction: 0, noRisk: 0, stakeAll: 0, round: 0, final: 0, gameOver: 0,
};

/* ---------- playing ---------- */

let ctx: AudioContext | undefined;
let noiseBuf: AudioBuffer | undefined;

/** Plays a sound: the chosen variant, or `variant` (for trying them out). Silent if switched off. */
export function playSound(ev: SoundEvent, variant?: number) {
  const p = getPrefs();
  const vol = p.sfx;
  const pick = variant ?? p.sounds?.[ev] ?? DEFAULT_SOUNDS[ev];
  const sound = VARIANTS[ev][pick];
  if (!vol || !sound) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const c = ctx;
    const t0 = c.currentTime + 0.02;
    const out = c.createGain();
    out.gain.value = 0.5 * vol;
    out.connect(c.destination);
    for (const t of sound.tones ?? []) {
      const osc = c.createOscillator();
      const g = c.createGain();
      const start = t0 + t.at;
      osc.type = t.wave ?? "triangle";
      osc.frequency.setValueAtTime(t.f, start);
      if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, start + t.d);
      if (t.vib) {
        const lfo = c.createOscillator();
        const depth = c.createGain();
        lfo.frequency.value = 6;
        depth.gain.value = t.vib;
        lfo.connect(depth).connect(osc.frequency);
        lfo.start(start);
        lfo.stop(start + t.d + 0.05);
      }
      const peak = Math.max(0.0002, t.g ?? 0.6);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + (t.attack ?? 0.01));
      g.gain.exponentialRampToValueAtTime(0.0001, start + t.d);
      osc.connect(g).connect(out);
      osc.start(start);
      osc.stop(start + t.d + 0.05);
    }
    if (sound.noise?.length) {
      noiseBuf ??= (() => {
        const b = c.createBuffer(1, c.sampleRate, c.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        return b;
      })();
      for (const n of sound.noise) {
        const src = c.createBufferSource();
        src.buffer = noiseBuf;
        const f = c.createBiquadFilter();
        f.type = "bandpass";
        const start = t0 + n.at;
        f.frequency.setValueAtTime(n.band ?? 1500, start);
        if (n.bandTo) f.frequency.exponentialRampToValueAtTime(n.bandTo, start + n.d);
        f.Q.value = n.q ?? 1;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, n.g ?? 0.4), start + Math.min(0.01, n.d / 3));
        g.gain.exponentialRampToValueAtTime(0.0001, start + n.d);
        src.connect(f).connect(g).connect(out);
        src.start(start, Math.random() * 0.5);
        src.stop(start + n.d + 0.02);
      }
    }
  } catch { /* audio unavailable */ }
}
