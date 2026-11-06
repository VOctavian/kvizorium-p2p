import type { Multiplier } from "@kvz/protocol";
import { useT } from "./i18n.ts";

/** Top to bottom (or left to right): the best result first, the worst last. */
export const MULT_ORDER: Multiplier[] = [2, 0.5, 1, 0, -1, -0.5, -2];

/** Grid areas for the column layout: ×0,5 and ×2 share a row (×0,5 left, ×2 right). */
const AREA: Record<string, string> = { "2": "m-p2", "0.5": "m-p05", "1": "m-right", "0": "m-zero", "-1": "m-wrong", "-0.5": "m-n05", "-2": "m-n2" };

/** "×2", "×0,5", "0". Negative multipliers carry no minus: the red colour says it. */
export function multLabel(m: number, locale: string) {
  if (m === 0) return "0";
  return `×${Math.abs(m).toLocaleString(locale)}`;
}

/**
 * Host's scoring buttons. In one line when they fit; otherwise a full-width column
 * (the switch is a CSS container query on `.mults`).
 */
export function MultButtons({ onPick, current }: { onPick: (m: Multiplier) => void; current?: number }) {
  const t = useT();
  return (
    <div className="mults">
      <div className="mults-list">
        {MULT_ORDER.map((m) => {
          const tone = m > 0 ? "good" : m < 0 ? "bad" : "zero";
          const main = m === 1 || m === -1;
          const label = m === 1 ? t.right : m === -1 ? t.wrong : multLabel(m, t.locale);
          const hint = m < 0 && !main ? `${t.wrong} ${label}` : label;
          return (
            <button key={m} type="button" className={`mult ${tone} ${main ? "main" : ""} ${AREA[String(m)]}`} aria-pressed={current === m} aria-label={hint} title={hint} onClick={() => onPick(m)}>
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
