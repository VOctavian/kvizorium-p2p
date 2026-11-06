import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PersonView, RoomView } from "@kvz/protocol";
import { useT } from "../i18n.ts";
import { send } from "../net.ts";
import { avatarSrc } from "../ui.tsx";

/**
 * Context menu on any person in the room (host, player, viewer): right click or the "⋯" button.
 * Leader: host's seat, free the table, remove, remove and ban. Host: pass the turn.
 */

interface MenuAt { id: string; x: number; y: number }
let current: MenuAt | null = null;
const listeners = new Set<() => void>();
function set(m: MenuAt | null) { current = m; listeners.forEach((l) => l()); }
export function openPersonMenu(id: string, x: number, y: number) { set({ id, x, y }); }
/** Opens the menu under a "⋯" button. */
export function openPersonMenuAt(id: string, el: HTMLElement) {
  const r = el.getBoundingClientRect();
  set({ id, x: r.right - 8, y: r.bottom + 4 });
}
const useMenu = () => useSyncExternalStore((l) => (listeners.add(l), () => { listeners.delete(l); }), () => current);

export const isLeader = (room: RoomView) => room.me.id === room.leaderId;
/** Game controls: the host; while nobody hosts (or the host is away), the leader. */
export const hostRights = (room: RoomView) => room.me.role === "host" || (!room.host?.online && isLeader(room));

type Item = { key: string; label: string; danger?: boolean; disabled?: boolean; run?: () => void; confirm?: string };

function itemsFor(room: RoomView, person: PersonView, t: ReturnType<typeof useT>): Item[] {
  const M = t.menu;
  const leader = isLeader(room);
  const self = person.id === room.me.id;
  const isHost = room.host?.id === person.id;
  const player = room.players.some((p) => p.id === person.id);
  const out: Item[] = [];
  if (hostRights(room) && player) {
    out.push({ key: "turn", label: M.passTurn, disabled: room.phase !== "choosing" || room.chooserId === person.id, run: () => send({ t: "setChooser", playerId: person.id }) });
  }
  if (self && !room.host && (room.settings.openHost || leader) && (!player || room.phase === "lobby")) out.push({ key: "take", label: M.takeHost, run: () => send({ t: "takeHost" }) });
  if (self && isHost) out.push({ key: "leave", label: M.leaveHost, run: () => send({ t: "leaveHost" }) });
  if (leader && !self) {
    if (isHost) out.push({ key: "unhost", label: M.removeHost, run: () => send({ t: "setHost", id: null }) });
    else out.push({ key: "host", label: room.host && player ? M.swapHost : M.makeHost, disabled: !person.online, run: () => send({ t: "setHost", id: person.id }) });
    if (player) out.push({ key: "free", label: M.freeSeat, run: () => send({ t: "freeSeat", id: person.id }) });
    out.push({ key: "kick", label: M.kick, danger: true, confirm: player ? M.kickConfirmSeat(person.name) : M.kickConfirm(person.name), run: () => send({ t: "kick", id: person.id }) });
    out.push({ key: "ban", label: M.ban, danger: true, confirm: M.banConfirm(person.name), run: () => send({ t: "ban", id: person.id }) });
  }
  return out;
}

/** Whether the menu has anything for this person (to show the "⋯" button at all). */
export function hasMenu(room: RoomView, id: string) {
  const person = findPerson(room, id);
  if (!person) return false;
  const leader = isLeader(room);
  if (leader && id !== room.me.id) return true;
  if (hostRights(room) && room.players.some((p) => p.id === id)) return true;
  return id === room.me.id && (room.host?.id === id || (!room.host && (room.settings.openHost || leader)));
}

function findPerson(room: RoomView, id: string): PersonView | undefined {
  if (room.host?.id === id) return room.host;
  return room.players.find((p) => p.id === id) ?? room.viewers.find((v) => v.id === id);
}

/** The "⋯" button. */
export function MoreButton({ id, label, className }: { id: string; label: string; className?: string }) {
  return (
    <button type="button" className={`more-btn ${className ?? ""}`} aria-label={label} title={label} aria-haspopup="menu"
      onClick={(e) => { e.stopPropagation(); openPersonMenuAt(id, e.currentTarget); }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
    </button>
  );
}

/** Rendered once per room screen. */
export function PersonMenu({ room }: { room: RoomView }) {
  const menu = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState<Item | null>(null);
  const t = useT();
  useEffect(() => { setConfirm(null); }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) set(null); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && set(null);
    addEventListener("pointerdown", close);
    addEventListener("keydown", esc);
    return () => { removeEventListener("pointerdown", close); removeEventListener("keydown", esc); };
  }, [menu]);
  if (!menu) return null;
  const person = findPerson(room, menu.id);
  if (!person) return null;
  const items = itemsFor(room, person, t);
  if (!items.length) return null;
  const role = room.host?.id === person.id ? t.menu.roleHost : room.players.some((p) => p.id === person.id) ? t.menu.rolePlayer : t.menu.roleViewer;
  const x = Math.max(8, Math.min(menu.x, innerWidth - 260));
  const y = Math.max(8, Math.min(menu.y, innerHeight - (confirm ? 170 : 60 + items.length * 36)));
  const run = (it: Item) => { it.run?.(); set(null); };
  return (
    <div ref={ref} className="ctx-menu" role="menu" style={{ left: x, top: y }} aria-label={t.menu.title(person.name)}>
      <div className="ctx-head"><img src={avatarSrc(person, false)} alt="" /><b>{person.name}</b><span className="faint">{role}</span></div>
      {confirm ? (
        <div className="ctx-confirm">
          <p>{confirm.confirm}</p>
          <div className="grid2">
            <button className="btn sm ghost" onClick={() => setConfirm(null)}>{t.cancel}</button>
            <button className="btn sm bad" autoFocus onClick={() => run(confirm)}>{confirm.label}</button>
          </div>
        </div>
      ) : (
        items.map((it) => (
          <button key={it.key} role="menuitem" className={it.danger ? "danger" : ""} disabled={it.disabled} onClick={() => (it.confirm ? setConfirm(it) : run(it))}>
            {it.label}{it.confirm ? "…" : ""}
          </button>
        ))
      )}
    </div>
  );
}

/** "People" tab under the chat: host, players and viewers, each with the same menu. */
export function PeoplePanel({ room }: { room: RoomView }) {
  const t = useT();
  const M = t.menu;
  const row = (p: PersonView, note: string) => (
    <li key={p.id} className="person" onContextMenu={(e) => { e.preventDefault(); openPersonMenu(p.id, e.clientX, e.clientY); }}>
      <img src={avatarSrc(p, false)} alt="" />
      <span className="who"><b>{p.name}{p.id === room.me.id && <span className="you-tag">{t.you}</span>}</b>
        <span className="note">{note}{p.id === room.leaderId ? ` · ${M.leader}` : ""}{p.online ? "" : ` · ${t.offline}`}</span></span>
      {hasMenu(room, p.id) && <MoreButton id={p.id} label={M.title(p.name)} />}
    </li>
  );
  const free = Math.max(0, room.settings.maxPlayers - room.players.length);
  return (
    <section className="panel side-panel people" aria-label={M.people}>
      <p className="eyebrow">{M.roleHost}</p>
      <ul className="people-list">
        {room.host ? row(room.host, M.roleHost) : (
          <li className="person empty">
            <span className="who"><b>{M.hostFree}</b></span>
            {(room.settings.openHost || isLeader(room)) && room.me.role !== "host" && (room.me.role === "viewer" || room.phase === "lobby") && (
              <button className="btn sm" onClick={() => send({ t: "takeHost" })}>{M.takeHostShort}</button>
            )}
          </li>
        )}
      </ul>
      <p className="eyebrow">{M.players(room.players.length, room.settings.maxPlayers)}</p>
      <ul className="people-list">
        {room.players.map((p) => row(p, `${p.score.toLocaleString(t.locale)} ${M.pts}`))}
        {free > 0 && <li className="person empty"><span className="who"><span className="note">{M.freeSeats(free)}</span></span></li>}
      </ul>
      <p className="eyebrow">{M.viewers(room.viewers.length)}</p>
      <ul className="people-list">
        {room.viewers.length ? room.viewers.map((v) => row(v, M.roleViewer)) : <li className="person empty"><span className="note">{M.noViewers}</span></li>}
      </ul>
    </section>
  );
}
