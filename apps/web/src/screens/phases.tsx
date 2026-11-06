import { tr, useT } from "../i18n.ts";
import { keyLabel, useHotkey } from "../hotkeys.ts";
import { MultButtons } from "../judge.tsx";
import { usePrefs } from "../prefs.ts";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { pointLabel, pointToText, type MediaView, type PlayerView, type RoomView, type TimerView } from "@kvz/protocol";
import { abs, send, sendPack, toast, useStore } from "../net.ts";
import { SettingsForm, settingsSummary } from "../settings.tsx";
import { LibraryButton } from "./Library.tsx";
import { hasMenu, hostRights, isLeader, MoreButton, openPersonMenu } from "./PersonMenu.tsx";
import { preloadMedia } from "../ui.tsx";
import { avatarSrc, AwayText, coverGradient, LinkMark, FitText, HiddenCover, initials, Lock, MediaList, Modal, PackName, Seg, TimerBar, useGrowText, useNow, secondsLeft, type Playback, type PointLayer, type Reading } from "../ui.tsx";

const nameOf = (room: RoomView, id?: string) => room.players.find((p) => p.id === id)?.name ?? (room.host?.id === id ? room.host?.name : undefined) ?? tr().player;
const isManager = isLeader;
const canHost = hostRights;
const me = (room: RoomView): PlayerView | undefined => room.players.find((p) => p.id === room.me.id);

/* ---------- lobby ---------- */

export function Lobby({ room }: { room: RoomView }) {
  const uploading = useStore((s) => s.upload);
  const t = useT();
  const L = t.lobby;
  const manage = isManager(room);
  const [over, setOver] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const self = me(room);
  const s = room.settings;
  const progress = uploading ? uploading.progress : null;
  const autoHost = s.hostMode === "auto" || !room.host;
  const setSettings = (patch: Partial<typeof s>) => send({ t: "settings", settings: patch });

  const upload = (file?: File) => {
    if (!file) return;
    if (!/\.(siq|zip)$/i.test(file.name)) return toast(t.needSiq);
    void sendPack(room.id, file);
  };

  const freeSlots = Math.max(0, s.maxPlayers - room.players.length);
  // A shared pack spreads between browsers; the game starts once everyone has the first round.
  const share = room.share;
  const sharePct = share && share.total && share.people.length
    ? Math.round((share.people.reduce((n, p) => n + p.have, 0) / (share.total * share.people.length)) * 100)
    : 100;
  const shareTag = (id: string) => {
    const p = share?.people.find((x) => x.id === id);
    if (!share || !p) return null;
    if (p.have >= share.total) return null;
    return <span className={`share-tag ${p.firstRound ? "done" : ""}`}>{p.firstRound ? L.shareFirst : L.shareOf(share.total ? Math.round((p.have / share.total) * 100) : 100)}</span>;
  };
  const waitShare = !!share && !share.ready;
  return (
    <section className="screen">
      <div className="lobby">
        <div className="panel">
          <p className="eyebrow">{L.pack}</p>
          {room.pack ? (
            <div className="pack">
              {room.pack.hidden && !room.pack.revealed && room.me.role !== "host" ? <HiddenCover className="pack-cover" /> : (
                <div className="pack-cover" style={room.pack.logo ? undefined : { background: coverGradient(room.pack.name) }}>
                  {room.pack.logo ? <img src={abs(room.pack.logo)} alt="" /> : initials(room.pack.name)}
                </div>
              )}
              <div style={{ minWidth: 0 }}>
                <h2><PackName pack={room.pack} host={room.me.role === "host"} /></h2>
                {room.pack.authors.length > 0 && <div className="dim" style={{ fontSize: 14 }}>{L.author} {room.pack.authors.join(", ")}</div>}
                <div className="tags">
                  <span className="tag mint">{L.format(room.pack.version)}</span>
                  <span className="tag">{L.rounds(room.pack.rounds.length)}{room.pack.rounds.some((r) => r.final) ? L.hasFinal : ""}</span>
                  <span className="tag">{L.questions(room.pack.questions)}</span>
                  {!(room.pack.hidden && !room.pack.revealed && room.me.role !== "host") && <span className="tag">{room.pack.sizeMb >= 0.1 ? `${room.pack.sizeMb.toLocaleString(t.locale)} ${t.mb}` : L.tiny}</span>}
                </div>
              </div>
            </div>
          ) : (
            <div className="pack">
              <div className="pack-cover">?</div>
              <div><h2>{L.noPack}</h2><div className="dim" style={{ fontSize: 14 }}>{manage ? L.uploadOwn : L.hostPicks}</div></div>
            </div>
          )}
          {share && (
            <div className="share-box">
              <div className="share-head"><span>{L.shareTitle}</span><span>{sharePct}%</span></div>
              <div className="progress"><i style={{ width: `${sharePct}%` }} /></div>
              <p className="note">{L.shareNote}</p>
            </div>
          )}
          {manage && (
            <label className="check-row lobby-anon">
              <input type="checkbox" id="lobby-anon" checked={s.anonPack} onChange={(e) => setSettings({ anonPack: e.target.checked })} />
              <span><b><Lock /> {t.anon.lobbyToggle}</b></span>
            </label>
          )}
          {manage && (
            <>
              <label className={`drop ${over ? "over" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files[0]); }}>
                <span>{room.packLoading ? t.tx(room.packLoading) : progress != null ? (uploading?.convert ? L.converting(uploading.convert.done + 1, uploading.convert.total, Math.round(progress * 100)) : L.sending(Math.round(progress * 100))) : t.dropSiq}</span>
                <span className="btn ghost sm file-btn">{L.choosePack}<input type="file" accept=".siq,.zip" onChange={(e) => upload(e.target.files?.[0])} /></span>
                {progress != null && <div className="progress"><i style={{ width: `${progress * 100}%` }} /></div>}
              </label>
              <LibraryButton onPick={(f) => upload(f)} className="lib-lobby" />
            </>
          )}
          <div className="settings">
            <div className="setting"><span><span className="setting-label">{t.game.answers}</span>{autoHost && s.oral && <span className="note">{t.game.oralNeedsHost}</span>}</span>
              <Seg disabled={!manage} value={s.oral} onChange={(v) => setSettings({ oral: v })} options={[[true, t.game.oral], [false, t.game.written]]} /></div>
          </div>
          {manage && (
            <label className="check-row" style={{ marginTop: 10 }}>
              <input type="checkbox" id="lobby-open-host" checked={s.openHost} onChange={(e) => setSettings({ openHost: e.target.checked })} />
              <span><b>{t.menu.openHost}</b><span className="note">{t.menu.openHostNote}</span></span>
            </label>
          )}
          <div className="summary-tags" style={{ marginTop: 12 }}>{settingsSummary(s, true).slice(1).map((x) => <span key={x} className="tag">{x}</span>)}</div>
          <button className="btn ghost advanced-toggle" style={{ marginTop: 12 }} onClick={() => setShowSettings(true)}>
            {manage ? L.advanced : L.allSettings}<span className="chev" aria-hidden="true">▸</span>
          </button>
          {showSettings && (
            <Modal title={L.gameSettings} onClose={() => setShowSettings(false)} wide>
              <SettingsForm value={s} onChange={setSettings} disabled={!manage} autoHost={autoHost} sections={["type", "time", "rules"]} />
              {!manage && <p className="note">{t.game.hostChanges}</p>}
              <div className="foot"><button className="btn primary" onClick={() => setShowSettings(false)}>{t.done}</button></div>
            </Modal>
          )}
        </div>

        <div className="panel">
          <p className="eyebrow">{L.players(room.players.length, s.maxPlayers)}</p>
          <h2>{room.players.length ? (room.players.every((p) => p.ready) ? L.allReady : L.waitReady) : L.waitPlayers}</h2>
          <div className="host-seat">
            <p className="eyebrow">{L.host}</p>
            {room.host ? (
              <div className="slot host-slot" onContextMenu={hasMenu(room, room.host.id) ? (e) => { e.preventDefault(); openPersonMenu(room.host!.id, e.clientX, e.clientY); } : undefined}>
                <img className="avatar" src={avatarSrc(room.host, false)} alt="" />
                <b>{room.host.name}{room.host.id === room.me.id && <span className="you-tag">{t.you}</span>}{room.host.online && <LinkMark p={room.host} />}</b>
                <span className="right">{shareTag(room.host.id)}{room.host.online ? <span className="ready">{t.online}</span> : <span className="wait"><AwayText p={room.host} /></span>}
                  {hasMenu(room, room.host.id) && <MoreButton id={room.host.id} label={t.menu.title(room.host.name)} />}</span>
              </div>
            ) : (
              <div className="slot empty host-slot">{t.menu.hostFree}
                {(s.openHost || manage) && room.me.role !== "host" && <span className="right"><button className="btn sm primary" onClick={() => send({ t: "takeHost" })}>{t.menu.takeHost}</button></span>}
              </div>
            )}
          </div>
          <div className="slots">
            {room.players.map((p) => (
              <div className="slot" key={p.id} onContextMenu={hasMenu(room, p.id) ? (e) => { e.preventDefault(); openPersonMenu(p.id, e.clientX, e.clientY); } : undefined}>
                <img className="avatar" src={avatarSrc(p, false)} alt="" />
                <b>{p.name}{p.id === room.me.id && <span className="you-tag">{t.you}</span>}{p.id === room.leaderId && <span className="leader-tag">{t.menu.leader}</span>}{p.online && <LinkMark p={p} />}</b>
                <span className="right">
                  {shareTag(p.id)}
                  {!p.online ? <span className="wait"><AwayText p={p} /></span> : p.ready ? <span className="ready">{L.ready(p.gender)}</span> : <span className="wait">{L.notReady(p.gender)}</span>}
                  {hasMenu(room, p.id) && <MoreButton id={p.id} label={t.menu.title(p.name)} />}
                </span>
              </div>
            ))}
            {Array.from({ length: freeSlots }, (_, i) => (
              <div key={i} className="slot empty">{L.freeSeat}
                {manage && <span className="right"><button className="btn sm ghost" onClick={() => send({ t: "seat", action: "remove" })} aria-label={L.removeSeat}>{t.remove}</button></span>}
              </div>
            ))}
            {manage && s.maxPlayers < 12 && <button className="slot add-seat" onClick={() => send({ t: "seat", action: "add" })}>+ {L.addSeat}</button>}
            {room.viewers.length > 0 && <div className="note">{L.viewers(room.viewers.map((v) => v.name).join(", "))}</div>}
          </div>
          <div className="lobby-actions">
            {self && <button className="btn" onClick={() => send({ t: "ready", value: !self.ready })}>{self.ready ? L.notReadyBtn : L.readyBtn}</button>}
            {room.me.role === "viewer" && freeSlots > 0 && <button className="btn" onClick={() => send({ t: "becomePlayer" })}>{L.sitDown}</button>}
            {manage && <button className="btn primary" disabled={!room.pack || !room.players.length || waitShare} onClick={() => send({ t: "start" })}>{!room.pack ? L.pickPackFirst : !room.players.length ? L.needPlayer : waitShare ? L.sharing(sharePct) : L.start}</button>}
            {manage && waitShare && room.players.length > 0 && <button className="btn ghost sm start-anyway" onClick={() => send({ t: "start", force: true })}>{L.startAnyway}</button>}
          </div>
          <p className="note" style={{ marginTop: 10 }}>{L.invite} <span className="code">{room.id}</span>{room.hasPassword ? L.needPassword : ""}.</p>
        </div>
      </div>
    </section>
  );
}

/* ---------- round intro ---------- */

export function RoundIntro({ room }: { room: RoomView }) {
  const b = room.board;
  const t = useT();
  return (
    <section className="screen fit">
      <div className="intro">
        <p className="eyebrow" style={{ margin: 0 }}>{b ? t.intro.roundOf(b.index + 1, b.count) : t.intro.round}</p>
        <h1>{b?.name}</h1>
        <div className="themes">{b?.themes.map((th, i) => <span key={i} style={{ animationDelay: `${i * 90}ms` }}>{th.name}</span>)}</div>
        {canHost(room) && <button className="btn" onClick={() => send({ t: "host", action: "next" })}>{t.intro.toBoard}</button>}
      </div>
    </section>
  );
}

/* ---------- board ---------- */

export function Board({ room }: { room: RoomView }) {
  const b = room.board!;
  const [flipped, setFlipped] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const t = useT();
  const B = t.board;
  const myTurn = room.chooserId === room.me.id;
  const host = canHost(room);
  const active = (myTurn || host) && !room.paused;
  const cols = Math.max(1, ...b.themes.map((th) => th.prices.length));
  const left = b.themes.reduce((n, th) => n + th.prices.filter((p) => p != null).length, 0);
  // Long theme names get a wider column; the text inside still shrinks to fit.
  const longest = Math.max(...b.themes.map((th) => th.name.length));
  const themeW = longest > 80 ? "24vw" : longest > 40 ? "18vw" : longest > 20 ? "14vw" : "11vw";
  // Rows share the height by weight: a long name gets a taller row so it can wrap onto several lines.
  const rowsTpl = b.themes.map((th) => `minmax(0, ${th.name.length > 110 ? 3 : th.name.length > 50 ? 2 : 1}fr)`).join(" ");
  return (
    <section className="screen fit">
      <div className="board-wrap">
        <div className={`board ${active && !editing ? "active" : ""} ${editing ? "editing" : ""}`} style={{ "--cols": cols, "--rows": b.themes.length, "--theme-w": themeW, gridTemplateRows: rowsTpl } as React.CSSProperties} aria-label={B.label}>
          {b.themes.map((th, ti) => {
            const done = th.prices.every((p) => p == null);
            return (
              <Row key={ti}>
                {editing ? (
                  <button className={`theme ${done ? "done" : ""}`} onClick={() => send({ t: "edit", theme: ti, remove: !done })} title={done ? B.restoreTheme : B.removeTheme}>
                    <FitText className="theme-name" text={th.name} /><span className="edit-mark">{done ? "↺" : "✕"}</span>
                  </button>
                ) : (
                  <div className={`theme ${done ? "done" : ""}`}><FitText className="theme-name" text={th.name} /></div>
                )}
                {Array.from({ length: cols }, (_, qi) => {
                  const price = th.prices[qi];
                  const exists = qi < th.prices.length;
                  const key = `${ti}:${qi}`;
                  const played = price == null;
                  if (editing && exists) {
                    const original = th.all?.[qi];
                    return (
                      <button key={key} className={`card edit ${played ? "played" : ""}`} onClick={() => send({ t: "edit", theme: ti, index: qi, remove: !played })} title={played ? B.restoreQuestion : B.removeQuestion}>
                        <span className="card-inner"><span className="face front">{original}<span className="edit-mark">{played ? "↺" : "✕"}</span></span></span>
                      </button>
                    );
                  }
                  return (
                    <button key={key} className={`card ${played ? (exists ? "played" : "empty") : ""} ${flipped === key ? "flipped" : ""}`}
                      disabled={played || !active} aria-label={played ? B.played : `${th.name}, ${price}`}
                      onClick={() => { setFlipped(key); send({ t: "choose", theme: ti, index: qi }); setTimeout(() => setFlipped(null), 1500); }}>
                      <span className="card-inner"><span className="face front">{played ? "" : price}</span><span className="face back">{B.question}</span></span>
                    </button>
                  );
                })}
              </Row>
            );
          })}
        </div>
      </div>
      {room.timer?.kind === "choose" && !editing && <div style={{ marginTop: 10 }}><TimerBar timer={room.timer} label={myTurn ? B.yourTime : B.chooses(nameOf(room, room.chooserId))} /></div>}
      <div className="board-foot">
        <span>{editing ? <span className="your-turn edit">{B.editing}</span> : myTurn ? <span className="your-turn">{B.yourChoice}</span> : <>{B.chooser} <b>{nameOf(room, room.chooserId)}</b></>}{host && !myTurn && !editing ? <span className="faint">{B.hostCanPick}</span> : null}</span>
        <span className="row" style={{ gap: 12 }}>
          <span>{t.q.quote(b.name)} · {B.left} <b>{left}</b>{b.roundEndsAt ? <>{B.roundEnds} <RoundLeft endsAt={b.roundEndsAt} /></> : null}</span>
          {host && !editing && room.players.length > 1 && (
            <select className="input pass-turn" id="pass-turn" value="" aria-label={B.passTurn} onChange={(e) => e.target.value && send({ t: "setChooser", playerId: e.target.value })}>
              <option value="">{B.passTurnMenu}</option>
              {room.players.filter((p) => p.id !== room.chooserId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          {host && room.me.role !== "player" && <button className="btn sm" aria-pressed={editing} onClick={() => setEditing(!editing)}>{editing ? t.done : B.edit}</button>}
        </span>
      </div>
    </section>
  );
}
const Row = ({ children }: { children: React.ReactNode }) => <>{children}</>;
/** Ticks on its own so the board itself doesn't re-render every second. */
function RoundLeft({ endsAt }: { endsAt: number }) {
  const now = useNow(1000);
  const sec = Math.max(0, Math.round((endsAt - now) / 1000));
  return <b>{Math.floor(sec / 60)}:{String(sec % 60).padStart(2, "0")}</b>;
}

function Secs({ timer }: { timer?: TimerView }) {
  const now = useNow(250);
  return <>{secondsLeft(timer, now)}</>;
}

/** Question content; while it is being read, text goes karaoke and pictures appear line by line. */
const QuestionBody = memo(function QuestionBody({ items, reading, playback, point }: { items: MediaView[]; reading?: Reading; playback: Playback; point?: PointLayer }) {
  const ref = useRef<HTMLDivElement>(null);
  useGrowText(ref, [items]);
  return <div className="q-body" ref={ref}><MediaList items={items} reading={reading} playback={playback} point={point} /></div>;
});

/** "📍 39% · 82%" for a point answer, else the text as it is. */
const shown = (a: string) => pointLabel(a) ?? a;

/**
 * Point question: what goes over the picture. A click answers when this browser may answer now
 * (the answering player, or a player of a question for everyone who hasn't handed in yet).
 */
function usePointLayer(room: RoomView, canPick: boolean): PointLayer | undefined {
  const q = room.question;
  const [mine, setMine] = useState<{ x: number; y: number }>();
  const key = q ? `${room.board?.index}:${q.themeIndex}:${q.index}:${q.answeringId ?? ""}` : "";
  useEffect(() => setMine(undefined), [key]);
  return useMemo(() => {
    if (!q?.point) return undefined;
    const names = new Map(room.players.map((p) => [p.id, p.name]));
    return {
      tries: q.point.tries.map((p) => ({ ...p, name: names.get(p.id) })),
      answer: q.stage === "reveal" || room.me.role === "host" ? q.point.answer : undefined,
      // My click until it's judged (then it is among the tries).
      mine: canPick || !mine || q.point.tries.some((p) => Math.abs(p.x - mine.x) < 0.002 && Math.abs(p.y - mine.y) < 0.002) ? undefined : mine,
      onPick: canPick ? (x: number, y: number, r: number) => { setMine({ x, y }); send({ t: "submit", text: pointToText({ x, y, r }) }); } : undefined,
    };
  }, [q?.point, q?.stage, room.players, room.me.role, canPick, mine]);
}

/** Sends what the player types, at most a few times per second. */
function useThrottledType() {
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (text: string) => {
    clearTimeout(timer.current);
    const wait = 300 - (Date.now() - last.current);
    const go = () => { last.current = Date.now(); send({ t: "type", text }); };
    if (wait <= 0) go();
    else timer.current = setTimeout(go, wait);
  };
}

/* ---------- question ---------- */

export function QuestionScreen({ room }: { room: RoomView }) {
  const q = room.question!;
  const self = me(room);
  const sendType = useThrottledType();
  const t = useT();
  const tm = room.timer;
  const st = room.settings;
  const readStart = q.stage === "reading" && tm?.kind === "read" ? tm.endsAt - tm.duration * 1000 : undefined;
  const reading = useMemo<Reading | undefined>(
    () => (readStart != null ? { startedAt: readStart, speed: st.readSpeed, karaoke: st.karaoke, imageReveal: st.imageReveal } : undefined),
    [readStart, st.readSpeed, st.karaoke, st.imageReveal],
  );
  const oralLive = room.settings.oral && room.settings.hostMode === "human" && !!room.host?.online;
  const [early, setEarly] = useState(false);
  const [answer, setAnswer] = useState("");
  const enterKey = `${q.themeIndex}:${q.index}`;
  const cardRef = useRef<HTMLDivElement>(null);
  const answeringMe = q.stage === "answering" && q.answeringId === room.me.id;
  const canBuzz = !!self && !q.soloId && !q.wrongIds.includes(self.id);
  const iPassed = !!self && q.passedIds.includes(self.id);
  const hostView = canHost(room);
  const label = t.kind[q.kind];

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter");
    setAnswer("");
  }, [enterKey]);
  useEffect(() => { if (answeringMe) setAnswer(""); }, [answeringMe]);
  // Load the media, then tell the server: the reading starts when everyone has them.
  const loadingNow = !!q.loading && (room.me.role !== "viewer");
  useEffect(() => {
    if (!loadingNow) return;
    let live = true;
    const clip = q.content.some((m) => m.type === "audio" || m.type === "video");
    void preloadMedia(q.content, clip ? 28_000 : 7000).then(() => { if (live) send({ t: "mediaReady", key: enterKey }); });
    return () => { live = false; };
  }, [loadingNow, enterKey]);

  const buzz = () => {
    if (!canBuzz || iPassed) return;
    if (q.stage === "reading") { setEarly(true); setTimeout(() => setEarly(false), 1000); }
    send({ t: "buzz" });
  };
  const pass = () => {
    if (!self || q.soloId) return;
    if (q.kind === "forAll" || q.kind === "stakeAll") {
      if (q.stage === "open" && q.forAll?.who.includes(self.id) && !q.forAll.done.includes(self.id)) send({ t: "passQuestion" });
      return;
    }
    if ((q.stage === "reading" || q.stage === "open") && canBuzz && !iPassed) send({ t: "passQuestion" });
  };
  const prefs = usePrefs();
  useHotkey(prefs.answerKey, buzz, !!self);
  useHotkey(prefs.passKey, pass, !!self);

  const answering = q.answeringId ? room.players.find((p) => p.id === q.answeringId) : undefined;
  const everyone = q.kind === "forAll" || q.kind === "stakeAll";
  const pickNow = !!q.point && (everyone
    ? q.stage === "open" && !!self && !!q.forAll?.who.includes(self.id) && !q.forAll.done.includes(self.id)
    : answeringMe && !q.submitted);
  const point = usePointLayer(room, pickNow);
  return (
    <section className="screen fit">
      <div className={`question ${hostView ? "" : "solo"}`}>
        <div className={`q-card ${q.stage === "answering" ? "is-answer" : ""}`} ref={cardRef}>
          <div className="q-head">
            <span className="eyebrow" style={{ margin: 0 }}>{q.theme}</span>
            {label && <span className="pill kind">{label}</span>}
            <span className="q-price">{q.price}</span>
          </div>
          {q.loading ? (
            <div className="q-loading" role="status"><span className="spinner" aria-hidden="true" />{t.q.loading(q.loading.ready, q.loading.total)}</div>
          ) : !(q.stage === "reveal" && q.answer?.content.length) && <QuestionBody items={q.content} reading={reading} point={point} playback={q.stage === "answering" || q.stage === "judging" ? "hold" : q.stage === "reveal" ? "keep" : "play"} />}
          {pickNow && <div className="point-hint">{t.q.pointHint}</div>}
          {q.options && q.kind !== "forAll" && q.kind !== "stakeAll" && <Options options={q.options} pick={answeringMe && !q.submitted ? (label) => send({ t: "submit", text: label }) : undefined} chosen={q.typed} />}

          {q.stage === "reveal" ? (
            <div className="reveal">
              {q.lastResult && <span className={`result ${q.lastResult.correct ? "good" : "bad"}`}>{nameOf(room, q.lastResult.playerId)}: {q.lastResult.correct ? t.q.resultRight : t.q.resultWrong} · {q.lastResult.delta > 0 ? "+" : ""}{q.lastResult.delta}</span>}
              <span className="eyebrow" style={{ margin: 0 }}>{t.q.correct}</span>
              <b>{q.point ? t.q.pointRight : q.answer?.text[0] ?? "—"}</b>
              {q.answer && q.answer.text.length > 1 && !q.point && <span className="note">{t.q.alsoAccepted} {q.answer.text.slice(1).join(", ")}</span>}
              {q.answer && q.answer.content.length > 0 && <MediaList items={q.answer.content} big={false} />}
            </div>
          ) : q.stage !== "reading" ? (
            <TimerBar timer={room.timer} />
          ) : (
            // Same height as the timer, so the answer button doesn't move when it opens.
            <div className="timer-ghost" aria-hidden><TimerBar /></div>
          )}

          {q.stage === "answering" && answering && (
            <div className="answer-banner">
              <img src={avatarSrc(answering)} alt="" />
              <div style={{ minWidth: 0 }}><small>{t.q.answering}</small><b>{answering.name}</b>{q.typed && q.submitted && <div className="typed">{t.q.quote(shown(q.typed))}</div>}</div>
              <span className="sec"><Secs timer={room.timer} /></span>
            </div>
          )}

          {answeringMe && oralLive && !q.point && <div className="oral-hint">{t.q.oralHint}</div>}
          {answeringMe && !q.submitted && !oralLive && !q.options && !q.point && (
            <form className="answer-form" onSubmit={(e) => { e.preventDefault(); send({ t: "submit", text: answer }); }}>
              <input className="input" id="answer-input" autoFocus value={answer} maxLength={200} placeholder={room.settings.hostMode === "auto" ? t.q.yourAnswer : t.q.sayOrWrite} aria-label={t.q.yourAnswer}
                onChange={(e) => { setAnswer(e.target.value); sendType(e.target.value); }} />
              <button className="btn primary" type="submit">{t.q.answer}</button>
            </form>
          )}

          {(q.kind === "forAll" || q.kind === "stakeAll") && <ForAll room={room} />}
          {self && (q.stage === "reading" || q.stage === "open") && !q.soloId && q.kind !== "forAll" && q.kind !== "stakeAll" && (
            <div className="buzz-row">
              <button className={`buzzer ${early ? "early" : q.stage === "open" && canBuzz && !iPassed ? "" : "wait"}`} onClick={buzz} disabled={!canBuzz || iPassed}>
                {early ? t.q.early : iPassed ? t.q.passed : !canBuzz ? t.q.alreadyAnswered : q.stage === "open" ? <>{t.q.answer} <kbd>{keyLabel(prefs.answerKey, t.q.space)}</kbd></> : <>{t.q.waitHost} <kbd>{keyLabel(prefs.answerKey, t.q.space)}</kbd></>}
              </button>
              {canBuzz && !iPassed && <button className="btn pass-btn" onClick={pass}>{t.q.pass} <kbd>{keyLabel(prefs.passKey, t.q.space)}</kbd></button>}
            </div>
          )}
        </div>

        {hostView && <HostPanel room={room} />}
      </div>
    </section>
  );
}

function HostPanel({ room }: { room: RoomView }) {
  const q = room.question!;
  const human = room.me.role === "host";
  const t = useT();
  return (
    <aside className="panel host-panel">
      <p className="eyebrow" style={{ margin: 0 }}>{t.q.panel}</p>
      {q.answer && (
        <div className="answer"><div className="eyebrow" style={{ marginBottom: 4 }}>{t.q.correct}</div><p>{q.point ? t.q.pointRight + " — " + q.answer.text.map(shown).join(" / ") : q.answer.text.join(" / ") || "—"}</p></div>
      )}
      {q.stage === "answering" && (
        <>
          {room.settings.oral && !q.point ? <div className="typed">{t.q.listen(nameOf(room, q.answeringId))}</div> : <div className="typed">{q.typed ? t.q.quote(shown(q.typed)) : <span className="faint">{q.point ? t.q.pointWait : t.q.nothingYet}</span>}</div>}
          {human && !q.options && !q.point && (
            <MultButtons onPick={(mult) => send({ t: "judge", correct: mult > 0, mult })} />
          )}
          {(q.options || q.point) && <p className="note">{t.q.optionsAuto}</p>}
        </>
      )}
      {q.stage === "reading" && <button className="btn" onClick={() => send({ t: "host", action: "open" })}>{t.q.openButtons}</button>}
      {q.stage !== "reveal" && <button className="btn ghost" onClick={() => send({ t: "host", action: "skip" })}>{t.q.skip}</button>}
      {q.stage === "reveal" && <button className="btn primary" onClick={() => send({ t: "host", action: "next" })}>{t.q.next}</button>}
      <p className="note">{human ? t.q.hostNote : t.q.autoNote}</p>
    </aside>
  );
}

function Options({ options, pick, chosen }: { options: { label: string; text: string; wrong?: boolean }[]; pick?: (label: string) => void; chosen?: string }) {
  return (
    <div className="options">
      {options.map((o) => (
        <button key={o.label} type="button" className={`option ${chosen === o.label ? "chosen" : ""} ${o.wrong ? "wrong" : ""}`} disabled={!pick || o.wrong} onClick={() => pick?.(o.label)}>
          <b>{o.label}</b><span>{o.text}</span>
        </button>
      ))}
    </div>
  );
}

/** "For everyone": every player writes; the host checks each answer. */
function ForAll({ room }: { room: RoomView }) {
  const q = room.question!;
  const f = q.forAll;
  const self = me(room);
  const [text, setText] = useState("");
  const sendType = useThrottledType();
  const t = useT();
  if (q.stage === "reading" || !f) return null;
  const done = !!self && f.done.includes(self.id);
  const judging = q.stage === "judging";
  const mine = !!self && f.who.includes(self.id);
  const answering = room.players.filter((p) => f.who.includes(p.id));
  return (
    <div className="controls">
      {q.stage === "open" && mine && !done && q.options && (
        <Options options={q.options} pick={(label) => send({ t: "submit", text: label })} />
      )}
      {q.stage === "open" && mine && !done && q.point && (
        <div className="row"><button className="btn pass-btn" type="button" onClick={() => send({ t: "passQuestion" })}>{t.q.pass}</button></div>
      )}
      {q.stage === "open" && mine && !done && !q.options && !q.point && (
        <form className="answer-form" onSubmit={(e) => { e.preventDefault(); send({ t: "submit", text }); }}>
          <input className="input" id="forall-answer" autoFocus value={text} maxLength={200} placeholder={t.q.yourAnswer} aria-label={t.q.yourAnswer}
            onChange={(e) => { setText(e.target.value); sendType(e.target.value); }} />
          <button className="btn primary" type="submit">{t.q.handIn}</button>
          <button className="btn pass-btn" type="button" onClick={() => send({ t: "passQuestion" })}>{t.q.pass}</button>
        </form>
      )}
      {q.stage === "open" && self && !mine && <p className="dim" style={{ margin: 0 }}>{t.stakeAll.notIn}</p>}
      {q.stage === "open" && (
        <div className="row">{answering.map((p) => (
          <span key={p.id} className="tag" style={f.done.includes(p.id) ? { color: "var(--mint)", borderColor: "rgba(67,240,196,.5)" } : undefined}>{p.name} {f.done.includes(p.id) ? "✓" : "…"}</span>
        ))}</div>
      )}
      {f.answers && (
        <div className="answers">
          {f.answers.map((a) => {
            const p = room.players.find((x) => x.id === a.id);
            if (!p) return null;
            return (
              <div key={a.id} className={`answer-row ${a.correct == null ? "" : a.correct ? "good" : "bad"}`}>
                <img className="avatar" src={avatarSrc(p, false)} alt="" />
                <div className="txt"><b>{p.name}</b>{a.stake != null && <span className="faint"> · {t.stakeAll.stake(a.stake)}</span>}<div>{a.answer ? t.q.quote(q.options?.find((o) => o.label === a.answer) ? `${a.answer}) ${q.options.find((o) => o.label === a.answer)!.text}` : shown(a.answer)) : <span className="faint">{t.q.noAnswer}</span>}</div></div>
                {a.delta != null && <span className={`result ${a.delta > 0 ? "good" : "bad"}`}>{a.delta > 0 ? "+" : a.delta < 0 ? "−" : ""}{Math.abs(a.delta)}</span>}
                {judging && room.me.role === "host" && a.answer && (
                  <MultButtons current={a.correct == null ? undefined : a.correct ? 1 : -1} onPick={(mult) => send({ t: "judge", correct: mult > 0, playerId: a.id, mult })} />
                )}
              </div>
            );
          })}
        </div>
      )}
      {done && q.stage === "open" && <p className="dim" style={{ margin: 0 }}>{t.q.handedIn(shown(f.myAnswer ?? ""))}</p>}
    </div>
  );
}

/* ---------- stakes for everyone ---------- */

export function StakeAll({ room }: { room: RoomView }) {
  const s = room.stakeAll!;
  const self = me(room);
  const t = useT();
  const mine = !!self && s.participants.includes(self.id);
  const max = Math.max(1, self?.score ?? 1);
  const [value, setValue] = useState(() => Math.min(s.price || 1, max));
  return (
    <section className="screen fit">
      <div className="center-panel">
        <div className="panel">
          <p className="eyebrow">{t.stakeAll.head(s.theme)}</p>
          <h2>{t.stakeAll.title}</h2>
          <p className="dim">{t.stakeAll.note}</p>
          <div className="bids">
            {room.players.filter((p) => s.participants.includes(p.id)).map((p) => (
              <div key={p.id} className={`bid ${s.done.includes(p.id) ? "lead" : ""}`}>
                <img className="avatar" src={avatarSrc(p, false)} alt="" /><b>{p.name}</b>
                <span className="val">{s.done.includes(p.id) ? "✓" : "…"}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel controls">
          <TimerBar timer={room.timer} />
          {mine && s.myStake == null ? (
            <form className="controls" onSubmit={(e) => { e.preventDefault(); send({ t: "stakeAll", value }); }}>
              <p className="eyebrow" style={{ margin: 0 }}>{t.stakeAll.yourStake}</p>
              <div className="big-val">{value}</div>
              <input type="range" id="stake-all" min={1} max={max} step={1} value={value} onChange={(e) => setValue(Number(e.target.value))} aria-label={t.stakeAll.yourStake} />
              <div className="grid2">
                <button type="button" className="btn amber" onClick={() => setValue(max)}>{t.stakeAll.allIn}</button>
                <button className="btn primary" type="submit">{t.stakeAll.put}</button>
              </div>
            </form>
          ) : (
            <p className="dim">{mine ? t.stakeAll.yours(s.myStake ?? 0) : t.stakeAll.notIn}</p>
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------- auction ---------- */

export function Stake({ room }: { room: RoomView }) {
  const s = room.stake!;
  const q = room.question!;
  const self = me(room);
  const myTurn = s.turnId === room.me.id && !!self;
  const max = self?.score ?? 0;
  const [value, setValue] = useState(s.minBid);
  useEffect(() => setValue(Math.min(Math.max(s.minBid, value), Math.max(s.minBid, max))), [s.minBid, max]);
  const canRaise = !s.allIn && max >= s.minBid;
  const t = useT();
  const S = t.stake;
  return (
    <section className="screen fit">
      <div className="center-panel">
        <div className="panel">
          <p className="eyebrow">{S.head(q.theme, s.nominal)}</p>
          <h2>{S.title}</h2>
          <div className="stake-big">{s.value || s.nominal}</div>
          <div className="dim" style={{ fontSize: 14 }}>{s.leaderId ? <>{S.leader} <b>{nameOf(room, s.leaderId)}</b>{s.allIn ? S.allIn : ""}</> : S.noBids}</div>
          <div className="bids">
            {room.players.map((p) => (
              <div key={p.id} className={`bid ${s.leaderId === p.id ? "lead" : ""} ${s.passed.includes(p.id) ? "pass" : ""} ${s.turnId === p.id ? "turn" : ""}`}>
                <img className="avatar" src={avatarSrc(p, false)} alt="" /><b>{p.name}</b>
                <span className="val">{s.leaderId === p.id ? s.value : s.passed.includes(p.id) ? S.pass : s.turnId === p.id ? S.turn : p.score}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel controls">
          <TimerBar timer={room.timer} />
          {myTurn ? (
            <>
              <p className="eyebrow" style={{ margin: 0 }}>{S.yourBid}</p>
              <div className="big-val">{canRaise ? value : max}</div>
              {canRaise && max > s.minBid && <input type="range" id="stake-range" min={s.minBid} max={max} step={100} value={value} onChange={(e) => setValue(Number(e.target.value))} aria-label={S.size} />}
              <div className="note">{S.range(s.minBid, max)}</div>
              <div className="grid2">
                {canRaise && <button className="btn primary" onClick={() => send({ t: "bid", kind: "bid", value })}>{S.bid(value)}</button>}
                {max > s.value && <button className="btn amber" onClick={() => send({ t: "bid", kind: "allin" })}>{S.allInBtn(max)}</button>}
                {s.leaderId && <button className="btn" onClick={() => send({ t: "bid", kind: "pass" })}>{S.pass}</button>}
              </div>
            </>
          ) : (
            <p className="dim">{s.turnId ? <>{S.bidding} <b>{nameOf(room, s.turnId)}</b></> : S.summing}</p>
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------- cat in the bag ---------- */

export function Secret({ room }: { room: RoomView }) {
  const s = room.secret!;
  const giver = s.giverId === room.me.id || (canHost(room) && room.me.role === "host");
  const recipient = s.recipientId === room.me.id;
  const prices = s.priceChoice ? range(s.priceChoice.min, s.priceChoice.max, s.priceChoice.step) : [];
  const t = useT();
  const C = t.secret;
  return (
    <section className="screen fit">
      <div className="center-panel">
        <div className="panel">
          <p className="eyebrow">{C.title}</p>
          <h2>{C.theme(s.theme)}</h2>
          <div className="stake-big" style={{ color: "var(--rose)" }}>{s.priceChoice && !s.recipientId ? `${s.priceChoice.min}–${s.priceChoice.max}` : s.price}</div>
          <p className="dim">{s.recipientId ? <>{C.goesTo[0]}<b>{nameOf(room, s.recipientId)}</b>{C.goesTo[1]}</> : <><b>{nameOf(room, s.giverId)}</b>{C.chooses}</>}</p>
        </div>
        <div className="panel controls">
          <TimerBar timer={room.timer} />
          {!s.recipientId && giver ? (
            <>
              <p className="eyebrow" style={{ margin: 0 }}>{C.toWhom}</p>
              <div className="pick-grid">
                {room.players.filter((p) => s.candidates.includes(p.id)).map((p) => (
                  <button key={p.id} className="pick" onClick={() => send({ t: "giveSecret", to: p.id })}><img src={avatarSrc(p)} alt="" /><b>{p.name}</b><span className="note">{p.score}</span></button>
                ))}
              </div>
            </>
          ) : recipient && s.priceChoice ? (
            <>
              <p className="eyebrow" style={{ margin: 0 }}>{C.choosePrice}</p>
              <div className="row">{prices.map((v) => <button key={v} className="btn" onClick={() => send({ t: "secretPrice", value: v })}>{v}</button>)}</div>
            </>
          ) : (
            <p className="dim">{C.waiting}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function range(min: number, max: number, step: number) {
  const out: number[] = [];
  for (let v = min; v <= max && out.length < 20; v += step || max - min || 1) out.push(v);
  return out;
}

/* ---------- final ---------- */

export function Final({ room }: { room: RoomView }) {
  const f = room.final!;
  const q = room.question;
  const self = me(room);
  const inFinal = !!self && f.participants.includes(self.id);
  const [stake, setStake] = useState(1);
  const sendType = useThrottledType();
  const [answer, setAnswer] = useState(f.myAnswer ?? "");
  const theme = f.themes.find((th) => !th.removed)?.name;
  const myTurn = f.turnId === room.me.id;
  const t = useT();
  const F = t.final;
  // A final "find it on the picture": the finalist answers with a click.
  const pickFinal = !!q?.point && inFinal && room.phase === "finalAnswer" && !f.answersDone.includes(room.me.id);
  const point = usePointLayer(room, pickFinal);

  let body: React.ReactNode;
  if (room.phase === "finalThemes") {
    body = (
      <>
        <p className="dim">{myTurn ? F.removeOne : <>{F.removedBy} <b>{nameOf(room, f.turnId)}</b></>}</p>
        <div className="final-themes">
          {f.themes.map((th, i) => myTurn && !th.removed
            ? <button key={i} className="final-theme" onClick={() => send({ t: "removeTheme", index: i })}>{th.name}<span className="note">{F.remove}</span></button>
            : <div key={i} className={`final-theme ${th.removed ? "removed" : ""}`}>{th.name}</div>)}
        </div>
      </>
    );
  } else if (room.phase === "finalStakes") {
    body = inFinal && f.myStake == null ? (
      <form className="controls" onSubmit={(e) => { e.preventDefault(); send({ t: "finalStake", value: stake }); }}>
        <p className="dim">{F.themeIs} <b>{theme}</b>{F.howMuch}</p>
        <div className="big-val">{stake}</div>
        <input type="range" id="final-stake" min={1} max={Math.max(1, self!.score)} step={1} value={stake} onChange={(e) => setStake(Number(e.target.value))} aria-label={F.stakeLabel} />
        <div className="grid2"><button type="button" className="btn amber" onClick={() => setStake(self!.score)}>{F.allIn}</button><button className="btn primary" type="submit">{F.place}</button></div>
      </form>
    ) : (
      <Waiting room={room} done={f.stakesDone} what={inFinal ? F.yourStake(f.myStake) : F.staking(theme)} />
    );
  } else if (room.phase === "finalAnswer") {
    const done = f.answersDone.includes(room.me.id);
    body = (
      <>
        {q && <div className="q-body"><MediaList items={q.content} point={point} /></div>}
        {pickFinal && <div className="point-hint">{t.q.pointHint}</div>}
        {inFinal && !done && !q?.point ? (
          <form className="answer-form" onSubmit={(e) => { e.preventDefault(); send({ t: "submit", text: answer }); }}>
            <input className="input" id="final-answer" autoFocus value={answer} maxLength={200} placeholder={F.yourAnswer} aria-label={F.answerLabel} onChange={(e) => { setAnswer(e.target.value); sendType(e.target.value); }} />
            <button className="btn primary" type="submit">{F.handIn}</button>
          </form>
        ) : <Waiting room={room} done={f.answersDone} what={inFinal && done ? F.handedIn : F.writing} />}
      </>
    );
  } else {
    const judging = room.phase === "finalJudge";
    body = (
      <>
        {q?.answer && <div className="reveal"><span className="eyebrow" style={{ margin: 0 }}>{t.q.correct}</span><b>{q.point ? t.q.pointRight : q.answer.text.join(" / ")}</b></div>}
        {q?.point && <div className="q-body"><MediaList items={q.content} point={point} /></div>}
        {f.answers ? (
          <div className="answers">
            {f.answers.map((a) => {
              const p = room.players.find((x) => x.id === a.id);
              return (
                <div key={a.id} className={`answer-row ${a.correct == null ? "" : a.correct ? "good" : "bad"}`}>
                  <img className="avatar" src={p ? avatarSrc(p, false) : undefined} alt="" />
                  <div className="txt"><b>{p?.name}</b>{a.stake != null && <span className="faint">{F.stake(a.stake)}</span>}<div>{t.q.quote(a.answer ? shown(a.answer) : "—")}</div></div>
                  {judging && room.me.role === "host" ? (
                    <div className="row">
                      <button className="btn sm good" aria-pressed={a.correct === true} onClick={() => send({ t: "judge", correct: true, playerId: a.id })}>{t.right}</button>
                      <button className="btn sm bad" aria-pressed={a.correct === false} onClick={() => send({ t: "judge", correct: false, playerId: a.id })}>{t.wrong}</button>
                    </div>
                  ) : a.correct != null ? <span className={`result ${a.correct ? "good" : "bad"}`}>{a.correct ? t.right : t.wrong}</span> : null}
                </div>
              );
            })}
          </div>
        ) : <p className="dim">{F.checking}</p>}
      </>
    );
  }

  return (
    <section className="screen fit">
      <div className="q-card" style={{ gap: 16 }}>
        <div className="q-head"><span className="eyebrow" style={{ margin: 0 }}>{F.title}{theme && room.phase !== "finalThemes" ? ` · ${theme}` : ""}</span><span className="pill kind">{F.title}</span></div>
        {room.phase !== "finalReveal" && room.phase !== "finalJudge" && <TimerBar timer={room.timer} />}
        {body}
        {canHost(room) && room.phase === "finalReveal" && <button className="btn" onClick={() => send({ t: "host", action: "next" })}>{F.toResults}</button>}
      </div>
    </section>
  );
}

function Waiting({ room, done, what }: { room: RoomView; done: string[]; what: string }) {
  const f = room.final!;
  return (
    <div className="controls">
      <p className="dim">{what}</p>
      <div className="row">{f.participants.map((id) => {
        const p = room.players.find((x) => x.id === id);
        return <span key={id} className="tag" style={done.includes(id) ? { color: "var(--mint)", borderColor: "rgba(67,240,196,.5)" } : undefined}>{p?.name} {done.includes(id) ? "✓" : "…"}</span>;
      })}</div>
    </div>
  );
}

/* ---------- results ---------- */

export function Results({ room }: { room: RoomView }) {
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const top = [sorted[1], sorted[0], sorted[2]].filter(Boolean) as PlayerView[];
  const winner = sorted[0];
  const t = useT();
  const R = t.results;
  return (
    <section className="screen fit">
      <div className="results">
        <p className="eyebrow" style={{ margin: 0 }}>{R.over}{room.pack && <> · <PackName pack={room.pack} host={room.me.role === "host"} /></>}</p>
        <h1>{winner ? (winner.id === room.me.id ? R.youWon : R.winner(winner.name)) : R.over}</h1>
        <div className="ranks">
          {top.map((p) => {
            const place = sorted.indexOf(p) + 1;
            return (
              <div key={p.id} className={`rank p${place}`}>
                <img className="avatar" src={avatarSrc(p)} alt="" /><b>{p.name}</b>
                <div className="stand"><span className="place">{place}</span><span className="pts">{p.score.toLocaleString(t.locale)}</span></div>
              </div>
            );
          })}
        </div>
        {sorted.length > 3 && <p className="dim">{sorted.slice(3).map((p, i) => `${i + 4}. ${p.name} · ${p.score}`).join("   ")}</p>}
        {room.pack && (room.pack.downloadUrl || (room.pack.hidden && !room.pack.revealed && (isManager(room) || canHost(room)))) && (
          <div className="pack-after">
            {room.pack.hidden && !room.pack.revealed && (isManager(room) || canHost(room)) && (
              <>
                <p className="note">{R.hiddenNote}</p>
                <button className="btn" onClick={() => send({ t: "revealPack" })}><Lock /> {R.reveal}</button>
              </>
            )}
            {room.pack.downloadUrl && <a className="btn ghost" href={abs(room.pack.downloadUrl)} download>{R.download}</a>}
          </div>
        )}
        <div className="row" style={{ justifyContent: "center" }}>
          <button className="btn" onClick={() => send({ t: "leaveRoom" })}>{R.toList}</button>
          {isManager(room) && <button className="btn primary" onClick={() => send({ t: "host", action: "end" })}>{R.newGame}</button>}
        </div>
      </div>
    </section>
  );
}
