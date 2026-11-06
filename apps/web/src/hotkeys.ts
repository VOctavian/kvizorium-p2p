import { useEffect, useRef } from "react";

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta"]);

/** Stored key name: modifiers by `e.key` (both Ctrl keys), everything else by `e.code` (layout-independent). */
export function keyFromEvent(e: KeyboardEvent): string {
  return MODIFIERS.has(e.key) ? e.key : e.code;
}

export function keyLabel(key: string, spaceName: string): string {
  if (key === "Space") return spaceName;
  if (key === "Control") return "Ctrl";
  if (key === "Meta") return "⌘";
  if (/^Key[A-Z]$/.test(key)) return key.slice(3);
  if (/^Digit\d$/.test(key)) return key.slice(5);
  if (/^Numpad\d$/.test(key)) return `Num ${key.slice(6)}`;
  const named: Record<string, string> = { NumpadAdd: "Num +", NumpadSubtract: "Num −", NumpadMultiply: "Num *", NumpadDivide: "Num /", NumpadEnter: "Num Enter", NumpadDecimal: "Num .", ArrowRight: "→", ArrowLeft: "←", ArrowUp: "↑", ArrowDown: "↓" };
  if (named[key]) return named[key];
  return key;
}

const typing = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  return !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
};

/**
 * Calls `handler` when `key` is pressed outside text fields. A modifier key (Ctrl, Shift…) fires
 * when it is released without another key in between, so Ctrl+C and the like keep working.
 */
export function useHotkey(key: string, handler: () => void, enabled = true) {
  const fn = useRef(handler);
  fn.current = handler;
  useEffect(() => {
    if (!enabled || !key) return;
    const isMod = MODIFIERS.has(key);
    let clean = false;
    const down = (e: KeyboardEvent) => {
      if (isMod) {
        clean = e.key === key && !e.repeat;
        return;
      }
      if (e.repeat || typing(e.target) || keyFromEvent(e) !== key) return;
      // Space/Enter would also click a focused button.
      if ((key === "Space" || key === "Enter") && (e.target as HTMLElement)?.tagName === "BUTTON") (e.target as HTMLElement).blur();
      e.preventDefault();
      fn.current();
    };
    const up = (e: KeyboardEvent) => {
      if (!isMod || e.key !== key) return;
      if (clean && !typing(e.target)) fn.current();
      clean = false;
    };
    const blur = () => { clean = false; };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    addEventListener("blur", blur);
    return () => { removeEventListener("keydown", down); removeEventListener("keyup", up); removeEventListener("blur", blur); };
  }, [key, enabled]);
}
