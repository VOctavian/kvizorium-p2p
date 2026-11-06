import { DEFAULT_SETTINGS, type Settings } from "@kvz/protocol";

/**
 * What the "New game" form starts with: the last settings used on this device, or the defaults
 * (anonymous pack, oral answers). Named presets live next to them. All in this browser only.
 */
export interface CreateChoice { settings: Settings; asHost: boolean }
export interface Preset extends CreateChoice { name: string }

const LAST = "kvz.create.last";
const PRESETS = "kvz.create.presets";

export const CREATE_DEFAULTS: CreateChoice = { settings: { ...DEFAULT_SETTINGS, anonPack: true, oral: true }, asHost: true };

function read<T>(key: string): T | undefined {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : undefined; } catch { return undefined; }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ }
}
/** Old saves may lack newer settings: fill them from the defaults. */
const complete = (c: Partial<CreateChoice> | undefined): CreateChoice => ({
  settings: { ...CREATE_DEFAULTS.settings, ...(c?.settings ?? {}) },
  asHost: c?.asHost ?? CREATE_DEFAULTS.asHost,
});

export const loadLastChoice = (): CreateChoice => complete(read<CreateChoice>(LAST));
export const saveLastChoice = (c: CreateChoice) => write(LAST, c);

export const loadPresets = (): Preset[] => (read<Preset[]>(PRESETS) ?? []).filter((p) => p && typeof p.name === "string").map((p) => ({ name: p.name, ...complete(p) }));
export function savePreset(p: Preset): Preset[] {
  const list = loadPresets().filter((x) => x.name !== p.name);
  list.push(p);
  write(PRESETS, list);
  return list;
}
export function deletePreset(name: string): Preset[] {
  const list = loadPresets().filter((x) => x.name !== name);
  write(PRESETS, list);
  return list;
}
