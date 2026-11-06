import { useT, type T } from "../i18n.ts";
import { memo, useEffect, useRef, useState } from "react";
import type { Multiplier, PlayerView, QuestionView, RoomView, TimerView } from "@kvz/protocol";
import { send, toast, useStore, type Profile } from "../net.ts";
import { usePrefs } from "../prefs.ts";
import { playSound } from "../sounds.ts";
import { VolumeChip } from "./Side.tsx";
import { useHotkey } from "../hotkeys.ts";
import { avatarSrc, HOST_AVATAR, LinkBanner, LinkMark, PackName, ReactionLayer, toggleFullscreen, useDrainStyle } from "../ui.tsx";

/** Anyone's name in the room (for a reaction from someone who just left, nothing). */
const nameIn = (room: RoomView, id: string) => (room.host?.id === id ? room.host : room.players.find((p) => p.id === id) ?? room.viewers.find((v) => v.id === id))?.name;
import { Board, Final, Lobby, QuestionScreen, Results, RoundIntro, Secret, Stake, StakeAll } from "./phases.tsx";
import { SidePanel } from "./Side.tsx";
import { hasMenu, hostRights, isLeader, MoreButton, openPersonMenu, PersonMenu } from "./PersonMenu.tsx";

export function RoomScreen({ onProfile }: { onProfile: (p: Profile) => void }) {
  const room = useStore((s) => s.room);
  useGameSignals(room);
  useHostKeys(room);
  if (!room) return null;
  const manage = hostRights(room);
  const inGame = room.phase !== "lobby" && room.phase !== "gameOver";
  const dense = (room.board?.themes.length ?? 0) > 8 && (room.phase === "choosing" || room.phase === "roundIntro");
  return (
    <div className={`stage ${dense ? "dense" : ""}`}>
      <div className="main">
        <Hud room={room} manage={manage} />
        <LinkBanner />
        <ReactionLayer names={(id) => nameIn(room, id)} />
        <div className="area">
          <Center room={room} />
        </div>
        {inGame && (
          <PlayerRow players={room.players} seats={room.settings.maxPlayers} question={room.question} timer={room.timer} phase={room.phase} chooserId={room.chooserId}
            stakeTurn={room.stake?.turnId} secret={room.secret} finalTurn={room.final?.turnId} finalists={room.final?.participants}
            meId={room.me.id} leader={isLeader(room)} canSit={room.me.role === "viewer"}
            menuFor={(id) => hasMenu(room, id)} />
        )}
      </div>
      <aside className="side">
        <HostCard host={room.host} auto={!room.host} line={room.hostLine} meIsHost={room.me.role === "host"} canTake={!room.host && (room.settings.openHost || isLeader(room)) && (room.me.role === "viewer" || room.phase === "lobby")} menu={!!room.host && hasMenu(room, room.host.id)} />
        <SidePanel room={room} canHost={manage} onProfile={onProfile} />
      </aside>
      <PersonMenu room={room} />
    </div>
  );
}

/** The host's keyboard: score the answering player, jump forward. Keys are set in Settings. */
function useHostKeys(room?: RoomView) {
  const { hostKeys: k } = usePrefs();
  const on = !!room && hostRights(room) && room.phase !== "lobby" && room.phase !== "gameOver";
  const q = room?.question;
  const judging = on && room!.phase === "question" && q?.stage === "answering" && !q.options;
  const judge = (mult: Multiplier) => send({ t: "judge", correct: mult > 0, mult });
  useHotkey(k.right, () => judge(1), judging);
  useHotkey(k.wrong, () => judge(-1), judging);
  useHotkey(k.x2, () => judge(2), judging);
  useHotkey(k.zero, () => judge(0), judging);
  useHotkey(k.half, () => judge(0.5), judging);
  useHotkey(k.minus2, () => judge(-2), judging);
  useHotkey(k.minusHalf, () => judge(-0.5), judging);
  useHotkey(k.advance, () => send({ t: "host", action: "advance" }), on);
}

/** Short sounds for the moments of the game (which one plays for each is picked in Settings). */
function useGameSignals(room?: RoomView) {
  const prev = useRef<{ phase?: string; stage?: string; qkey?: string; myTurn?: boolean; result?: string; round?: number }>({});
  useEffect(() => {
    if (!room) return;
    const q = room.question;
    const p = prev.current;
    const first = p.phase === undefined;
    const myTurn = room.phase === "choosing" && room.chooserId === room.me.id;
    const qkey = q ? `${room.board?.index}:${q.themeIndex}:${q.index}` : undefined;
    const result = q?.lastResult ? `${qkey}:${q.lastResult.playerId}:${q.lastResult.delta}` : undefined;
    const round = room.board?.index;
    prev.current = { phase: room.phase, stage: q?.stage, qkey, myTurn, result, round };
    // Joining in the middle: nothing to announce yet.
    if (first) return;
    const entered = (ph: string) => room.phase === ph && p.phase !== ph;
    if (entered("gameOver")) return playSound("gameOver");
    if (entered("secret")) return playSound("secret");
    if (entered("stake")) return playSound("auction");
    if (entered("stakeAll")) return playSound("stakeAll");
    if ((entered("roundIntro") || entered("finalThemes")) && round !== undefined && (round !== p.round || p.phase === "lobby")) return playSound(room.board?.final ? "final" : "round");
    if (q && qkey !== p.qkey && q.kind === "noRisk") return playSound("noRisk");
    if (result && result !== p.result && q?.lastResult) return playSound(q.lastResult.correct ? "good" : q.lastResult.delta === 0 ? "zero" : "bad");
    if (q && qkey === p.qkey && q.stage === "reveal" && p.stage === "open" && !q.lastResult) return playSound("timeUp");
    if (q && qkey === p.qkey && q.stage === "answering" && p.stage === "open") return playSound("buzz");
    if (q?.stage === "open" && (p.stage !== "open" || qkey !== p.qkey) && q.kind !== "forAll" && q.kind !== "stakeAll" && room.me.role === "player") return playSound("open");
    if (myTurn && !p.myTurn) return playSound("turn");
  }, [room]);
}

function Hud({ room, manage }: { room: RoomView; manage: boolean }) {
  const [copied, setCopied] = useState(false);
  const [rounds, setRounds] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!rounds) return;
    const close = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setRounds(false); };
    addEventListener("pointerdown", close);
    return () => removeEventListener("pointerdown", close);
  }, [rounds]);
  const t = useT();
  const inGame = room.phase !== "lobby" && room.phase !== "gameOver";
  const roundLabel = room.board ? (room.board.final ? <b>{t.room.final}</b> : <>{t.room.round} <b>{room.board.index + 1}</b> {t.room.roundOf(room.board.count)}</>) : null;
  return (
    <header className="hud">
      <div className="logo"><span className="mark" aria-hidden="true" />{t.appName}</div>
      {room.paused && !manage && <span className="chip warn">{t.pause}</span>}
      {room.pack && <span className="chip pack-chip" title={room.pack.hidden && !room.pack.revealed && room.me.role !== "host" ? undefined : room.pack.name}><span className="dot" aria-hidden="true" />{t.room.pack} <b><PackName pack={room.pack} host={room.me.role === "host"} /></b></span>}
      {room.board && (manage && room.pack ? (
        <span className="menu-wrap" ref={menuRef}>
          <button className="chip" aria-expanded={rounds} onClick={() => setRounds(!rounds)}>{roundLabel} ▾</button>
          {rounds && (
            <div className="menu" role="menu">
              <p className="note">{t.room.jumpRound}</p>
              {room.pack.rounds.map((r, i) => (
                <button key={i} role="menuitem" className={i === room.board!.index ? "current" : ""} onClick={() => { setRounds(false); send({ t: "setRound", index: i }); }}>
                  <span>{i + 1}. {r.name}</span><span className="faint">{r.final ? t.room.finalShort : t.room.questionsShort(r.questions)}</span>
                </button>
              ))}
            </div>
          )}
        </span>
      ) : <span className="chip">{roundLabel}</span>)}
      <button className="chip" title={t.room.copyCode} onClick={() => {
        navigator.clipboard?.writeText(room.id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => toast(t.room.codeIs(room.id), "info"));
      }}>{copied ? t.room.copied : <>{t.room.room} <span className="code">{room.id}</span></>}</button>
      {manage && inGame && (
        <button className={`chip ${room.paused ? "warn" : ""}`} onClick={() => send({ t: "host", action: room.paused ? "resume" : "pause" })}>{room.paused ? t.resume : t.pause}</button>
      )}
      <VolumeChip />
      <button className="chip" onClick={toggleFullscreen} title={t.fullscreenHint} aria-label={t.fullscreen}>⛶</button>
      <button className="chip" onClick={() => send({ t: "leaveRoom" })}>{t.room.leave}</button>
    </header>
  );
}

function Center({ room }: { room: RoomView }) {
  switch (room.phase) {
    case "lobby": return <Lobby room={room} />;
    case "roundIntro": return <RoundIntro room={room} />;
    case "choosing": return <Board room={room} />;
    case "secret": return <Secret room={room} />;
    case "stake": return <Stake room={room} />;
    case "stakeAll": return <StakeAll room={room} />;
    case "question": return <QuestionScreen room={room} />;
    case "finalThemes":
    case "finalStakes":
    case "finalAnswer":
    case "finalJudge":
    case "finalReveal": return <Final room={room} />;
    case "gameOver": return <Results room={room} />;
  }
}

/* ---------- player row ---------- */

interface RowProps {
  players: PlayerView[];
  seats: number;
  question?: QuestionView;
  timer?: TimerView;
  phase: RoomView["phase"];
  chooserId?: string;
  stakeTurn?: string;
  secret?: RoomView["secret"];
  finalTurn?: string;
  finalists?: string[];
  meId: string;
  leader: boolean;
  canSit: boolean;
  menuFor: (id: string) => boolean;
}

const PlayerRow = memo(function PlayerRow({ players, seats, question: q, timer, phase, chooserId, stakeTurn, secret, finalTurn, finalists, meId, leader, canSit, menuFor }: RowProps) {
  const answering = q?.stage === "answering" ? q.answeringId : undefined;
  const busyId = phase === "choosing" ? chooserId : stakeTurn ?? (secret && !secret.recipientId ? secret.giverId : secret?.recipientId) ?? finalTurn;
  const [flash, setFlash] = useState<{ id: string; good: boolean } | null>(null);
  const t = useT();
  const lastKey = useRef("");
  const result = q?.lastResult;
  useEffect(() => {
    if (!result || !q) return;
    const key = `${q.themeIndex}:${q.index}:${result.playerId}:${result.delta}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    if (result.mult === 0) return;
    setFlash({ id: result.playerId, good: result.correct });
    const t = setTimeout(() => setFlash(null), 1400);
    return () => clearTimeout(t);
  }, [result, q]);
  const label = busyLabel(phase, t, secret);
  const answerTimer = timer?.kind === "answer" ? timer : undefined;
  const free = Math.max(0, seats - players.length);
  return (
    <footer className={`podiums ${answering ? "dim" : ""}`} aria-label={t.room.players}>
      {players.map((p) => {
        const cls = [answering === p.id ? "answering" : "", !answering && busyId === p.id ? "choosing" : "", resultClass(q, p.id), flash?.id === p.id ? (flash.good ? "flash-good" : "flash-bad") : ""].join(" ").trim();
        const state = answering === p.id ? t.room.answering : q?.passedIds.includes(p.id) && q.stage !== "reveal" ? t.q.pass : busyId === p.id ? label : p.online ? (finalists && !finalists.includes(p.id) ? t.room.notInFinal : t.room.inGame) : t.offline;
        return <PlayerCard key={p.id} p={p} cls={cls} state={state} isMe={p.id === meId} menu={menuFor(p.id)} timer={answering === p.id ? answerTimer : undefined} />;
      })}
      {Array.from({ length: free }, (_, i) => (
        <div key={`free${i}`} className="podium seat-free">
          <div className="pic"><span>{t.room.free}</span></div>
          {canSit && <button className="btn sm primary" onClick={() => send({ t: "becomePlayer" })}>{t.room.sit}</button>}
          {leader && <button className="btn sm ghost" onClick={() => send({ t: "seat", action: "remove" })}>{t.remove}</button>}
        </div>
      ))}
      {leader && seats < 12 && (
        <button className="podium seat-add" onClick={() => send({ t: "seat", action: "add" })} aria-label={t.room.addSeat}><span>+</span>{t.room.seat}</button>
      )}
    </footer>
  );
});

/** Card background after an answer: green — right, red — wrong, smoky grey — passed. Lasts until the next question. */
function resultClass(q: QuestionView | undefined, id: string) {
  if (!q) return "";
  const all = q.forAll?.answers?.find((a) => a.id === id);
  if ((q.lastResult?.playerId === id && q.lastResult.correct) || (q.stage === "reveal" && all?.correct)) return "res-good";
  if (q.passedIds.includes(id) || q.zeroIds?.includes(id) || (q.stage === "reveal" && all && (!all.answer || all.mult === 0))) return "res-pass";
  if (q.wrongIds.includes(id) || (q.stage === "reveal" && all?.correct === false)) return "res-bad";
  return "";
}

function busyLabel(phase: RoomView["phase"], t: T, secret?: RoomView["secret"]) {
  switch (phase) {
    case "choosing": return t.room.choosing;
    case "stake": return t.room.staking;
    case "secret": return secret?.recipientId ? t.room.pickingPrice : t.room.givingCat;
    case "finalThemes": return t.room.removingTheme;
    default: return t.room.moving;
  }
}

const PlayerCard = memo(function PlayerCard({ p, cls, state, isMe, menu, timer }: { p: PlayerView; cls: string; state: string; isMe: boolean; menu: boolean; timer?: TimerView }) {
  const drain = useDrainStyle(timer);
  const t = useT();
  return (
    <div className={`podium ${cls}`} onContextMenu={menu ? (e) => { e.preventDefault(); openPersonMenu(p.id, e.clientX, e.clientY); } : undefined}>
      <span className="flag">{t.room.answering}</span>
      {menu && <MoreButton id={p.id} label={t.menu.title(p.name)} className="on-card" />}
      <span className="pic"><img src={avatarSrc(p)} alt="" /><LinkMark p={p} /></span>
      <span className="name" title={p.name}>{p.name}{isMe && <span className="you-tag">{t.you}</span>}</span>
      <span className={`score ${p.score < 0 ? "neg" : ""}`}>{p.score.toLocaleString(t.locale)}</span>
      <span className="state">{state}</span>
      <span className="pbar">{timer && <i key={timer.endsAt} style={drain} />}</span>
    </div>
  );
});

/* ---------- host card (variant C: above the chat) ---------- */

const HostCard = memo(function HostCard({ host, auto, line, meIsHost, canTake, menu }: { host?: RoomView["host"]; auto: boolean; line: RoomView["hostLine"]; meIsHost: boolean; canTake: boolean; menu: boolean }) {
  const t = useT();
  return (
    <div className="host-side" onContextMenu={menu && host ? (e) => { e.preventDefault(); openPersonMenu(host.id, e.clientX, e.clientY); } : undefined}>
      {menu && host && <MoreButton id={host.id} label={t.menu.title(host.name)} className="on-card" />}
      {canTake && <button className="btn sm take-host" onClick={() => send({ t: "takeHost" })}>{t.menu.takeHost}</button>}
      <div className="pic"><img src={auto || !host ? HOST_AVATAR : avatarSrc(host)} alt="" />{!auto && host && <LinkMark p={host} />}</div>
      <div className="who">
        <span className="role">{auto ? t.room.autoHost : t.room.host}</span>
        <b>{auto || !host ? t.appName : host.name}</b>
        <div className="note">{auto || !host ? t.room.autoNote : host.online ? (meIsHost ? t.room.thisIsYou : t.room.onAir) : t.room.hostOffline}</div>
      </div>
      <div className="say" aria-live="polite">{t.tx(line)}</div>
    </div>
  );
});
