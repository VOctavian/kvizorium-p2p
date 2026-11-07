/**
 * Room links: <site>/<CODE>. Opening one joins that room — after the name is set, and with the
 * password asked first if the room has one. While in a room, the address bar shows its link.
 */
const CODE = /^[A-Za-z0-9]{4}$/;
const parts = location.pathname.split("/");
const last = parts[parts.length - 1] ?? "";

/** The site's own folder ("/" or "/kvizorium-p2p/"), whatever room the address names. */
export const BASE_PATH = CODE.test(last) ? parts.slice(0, -1).join("/") + "/" : location.pathname.replace(/[^/]*$/, "");

let invite: string | undefined = CODE.test(last) ? last.toUpperCase() : undefined;

/** The room code this page was opened with, until it's been used. */
export const pendingInvite = () => invite;
export const clearInvite = () => { invite = undefined; };

export const roomLink = (code: string) => `${location.origin}${BASE_PATH}${code}`;

/** Puts the room's link into the address bar (or takes it out), without reloading. */
export function showRoomInUrl(code?: string) {
  const want = BASE_PATH + (code ?? "");
  if (location.pathname === want) return;
  try { history.replaceState(history.state, "", want + location.search + location.hash); } catch { /* sandboxed */ }
}
