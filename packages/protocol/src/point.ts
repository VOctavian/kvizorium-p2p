/**
 * "Point" questions (SIGame answerType "point"): the answer is a spot on the question's picture.
 * Coordinates are shares of the picture's width and height (0..1, from the top left corner).
 * A click counts if it is within `answerDeviation` × the picture's longer side of the right spot.
 */
export interface Point {
  x: number;
  y: number;
  /** The picture's height / width, when known (it decides what "the longer side" is). */
  r?: number;
}

/** Reads "0.39,0.82" or "0.39,0.82,0.66" (the third number: height / width). */
export function parsePoint(s: string | undefined): Point | undefined {
  const m = /^\s*(-?[\d.]+)\s*[,;]\s*(-?[\d.]+)(?:\s*[,;]\s*([\d.]+))?\s*$/.exec(s ?? "");
  if (!m) return undefined;
  const x = Number(m[1]), y = Number(m[2]), r = m[3] ? Number(m[3]) : undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < -0.01 || x > 1.01 || y < -0.01 || y > 1.01) return undefined;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), r: r && Number.isFinite(r) && r > 0.05 && r < 20 ? r : undefined };
}

export const pointToText = (p: Point) => `${p.x.toFixed(4)},${p.y.toFixed(4)}${p.r ? `,${p.r.toFixed(4)}` : ""}`;

/** For people: "📍 39% · 82%". */
export function pointLabel(s: string | undefined): string | undefined {
  const p = parsePoint(s);
  return p && `📍 ${Math.round(p.x * 100)}% · ${Math.round(p.y * 100)}%`;
}

/** Default allowance when the pack doesn't say. */
export const POINT_DEVIATION = 0.1;

/** Whether `given` is close enough to `right`. The given point's own ratio (from the picture on screen) wins. */
export function pointHits(given: Point, right: Point, deviation = POINT_DEVIATION): boolean {
  const r = given.r ?? right.r ?? 1;
  const dx = given.x - right.x;
  const dy = (given.y - right.y) * r;
  return Math.hypot(dx, dy) <= deviation * Math.max(1, r) + 1e-9;
}
