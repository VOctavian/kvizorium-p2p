import { SETTING_LIMITS, type Settings } from "@kvz/protocol";
import { Seg } from "./ui.tsx";
import { tr, useT } from "./i18n.ts";

type NumKey = keyof typeof SETTING_LIMITS;

export function Stepper({ id, value, onChange, min, max, step = 1, unit, zero, disabled }: {
  id: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; unit?: string; zero?: string; disabled?: boolean;
}) {
  const t = useT();
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  return (
    <div className="stepper">
      <button type="button" className="btn sm icon" disabled={disabled || value <= min} onClick={() => set(value - step)} aria-label={t.game.less}>−</button>
      <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => set(Number(e.target.value))} aria-valuetext={value === 0 && zero ? zero : `${value} ${unit ?? ""}`} />
      <button type="button" className="btn sm icon" disabled={disabled || value >= max} onClick={() => set(value + step)} aria-label={t.game.more}>+</button>
      <output htmlFor={id} className="stepper-val">{value === 0 && zero ? zero : `${value}${unit ? ` ${unit}` : ""}`}</output>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <span><span className="setting-label">{label}</span>{hint && <span className="note">{hint}</span>}</span>
      {children}
    </div>
  );
}

type TimeKey = "thinkTime" | "answerTime" | "chooseTime" | "stakeTime" | "finalTime" | "roundTime" | "readSpeed" | "imageReveal";
/** Label and hint come from the dictionary: t.game[key] and t.game[key + "Note"]. */
const TIMES: { key: TimeKey; hint?: boolean; unit: "sec" | "min" | "cps"; step?: number; zero?: "noLimit" | "atOnce" }[] = [
  { key: "thinkTime", hint: true, unit: "sec" },
  { key: "answerTime", hint: true, unit: "sec" },
  { key: "chooseTime", hint: true, unit: "sec", step: 5, zero: "noLimit" },
  { key: "stakeTime", hint: true, unit: "sec" },
  { key: "finalTime", unit: "sec", step: 5 },
  { key: "roundTime", hint: true, unit: "min", zero: "noLimit" },
  { key: "readSpeed", hint: true, unit: "cps" },
  { key: "imageReveal", hint: true, unit: "sec", zero: "atOnce" },
];

/** All game settings. `section` limits which groups are shown. */
export function SettingsForm({ value, onChange, disabled, autoHost, inGame, sections = ["main", "time", "rules"] }: {
  value: Settings;
  onChange: (patch: Partial<Settings>) => void;
  disabled?: boolean;
  autoHost: boolean;
  inGame?: boolean;
  sections?: ("main" | "type" | "time" | "rules")[];
}) {
  const t = useT();
  const g = t.game;
  const unit = { sec: t.sec, min: g.min, cps: g.cps };
  const num = (key: NumKey) => {
    const [min, max] = SETTING_LIMITS[key];
    return { min, max, value: value[key] as number, onChange: (v: number) => onChange({ [key]: v }) };
  };
  return (
    <div className="settings-form">
      {sections.includes("main") && (
        <section>
          <p className="eyebrow">{g.game}</p>
          <div className="settings">
            <Row label={g.seats} hint={inGame ? g.seatsInGame : undefined}>
              <Stepper id="set-players" {...num("maxPlayers")} disabled={disabled || inGame} />
            </Row>
            <Row label={g.answers} hint={autoHost && value.oral ? g.oralNeedsHost : value.oral ? g.oralNote : g.writtenNote}>
              <Seg disabled={disabled} value={value.oral} onChange={(v) => onChange({ oral: v })} options={[[true, g.oral], [false, g.written]]} />
            </Row>
            <Row label={g.type} hint={value.gameType === "classic" ? g.classicNote : g.simpleNote}>
              <Seg disabled={disabled || inGame} value={value.gameType} onChange={(v) => onChange({ gameType: v })} options={[["classic", g.classic], ["simple", g.simple]]} />
            </Row>
          </div>
        </section>
      )}
      {sections.includes("type") && !sections.includes("main") && (
        <section>
          <p className="eyebrow">{g.game}</p>
          <div className="settings">
            <Row label={g.type} hint={value.gameType === "classic" ? g.classicNote : g.simpleNote}>
              <Seg disabled={disabled || inGame} value={value.gameType} onChange={(v) => onChange({ gameType: v })} options={[["classic", g.classic], ["simple", g.simple]]} />
            </Row>
            <Row label={g.answers} hint={autoHost && value.oral ? g.oralNeedsHost : value.oral ? g.oralNote : g.writtenNote}>
              <Seg disabled={disabled} value={value.oral} onChange={(v) => onChange({ oral: v })} options={[[true, g.oral], [false, g.written]]} />
            </Row>
            <Row label={g.finals} hint={g.finalsNote}>
              <Seg disabled={disabled} value={value.finals} onChange={(v) => onChange({ finals: v })} options={[["all", g.finalsAll], ["one", g.finalsOne]]} />
            </Row>
          </div>
        </section>
      )}
      {sections.includes("time") && (
        <section>
          <p className="eyebrow">{g.time}</p>
          <div className="settings">
            {TIMES.map((it) => (
              <Row key={it.key} label={g[it.key]} hint={it.hint ? g[`${it.key}Note` as `${Exclude<TimeKey, "finalTime">}Note`] : undefined}>
                <Stepper id={`set-${it.key}`} {...num(it.key)} step={it.step} unit={unit[it.unit]} zero={it.zero && g[it.zero]} disabled={disabled} />
              </Row>
            ))}
          </div>
        </section>
      )}
      {sections.includes("rules") && (
        <section>
          <p className="eyebrow">{g.rules}</p>
          <div className="settings">
            <Row label={g.falseStart} hint={g.falseStartNote}>
              <Seg disabled={disabled} value={value.falseStart} onChange={(v) => onChange({ falseStart: v })} options={[[true, g.penalty], [false, g.noPenalty]]} />
            </Row>
            <Row label={g.wrongAnswer} hint={g.wrongAnswerNote}>
              <Seg disabled={disabled} value={value.wrongPenalty} onChange={(v) => onChange({ wrongPenalty: v })} options={[[true, g.minusPoints], [false, g.noPenalty]]} />
            </Row>
            <Row label={g.questionText} hint={g.questionTextNote}>
              <Seg disabled={disabled} value={value.karaoke} onChange={(v) => onChange({ karaoke: v })} options={[[true, g.karaoke], [false, g.noHighlight]]} />
            </Row>
            <Row label={g.viewers}>
              <Seg disabled={disabled} value={value.allowViewers} onChange={(v) => onChange({ allowViewers: v })} options={[[true, g.allowed], [false, g.notAllowed]]} />
            </Row>
          </div>
        </section>
      )}
    </div>
  );
}

/** Short tags for the settings, in the current language (callers re-render through useT). */
/** `short`: without the timings and the reading speed (the lobby shows those in the settings). */
export function settingsSummary(s: Settings, short = false): string[] {
  return tr().summary(s, short);
}
