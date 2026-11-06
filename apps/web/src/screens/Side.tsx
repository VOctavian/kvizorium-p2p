import { LANGS, useT } from "../i18n.ts";
import { memo, useEffect, useRef, useState } from "react";
import type { ChatItem, RoomView } from "@kvz/protocol";
import { abs, send, useStore, type Profile } from "../net.ts";
import { keyFromEvent, keyLabel } from "../hotkeys.ts";
import { getPrefs, HOST_KEY_DEFAULTS, setPrefs, usePrefs, type HostKeys } from "../prefs.ts";
import { DEFAULT_SOUNDS, playSound, SOUND_EVENTS, SOUND_PICKER, VARIANTS } from "../sounds.ts";

const HOST_KEY_ROWS: [keyof HostKeys, "keyRight" | "keyWrong" | "keyX2" | "keyZero" | "keyHalf" | "keyMinus2" | "keyMinusHalf" | "keyAdvance"][] = [
  ["right", "keyRight"], ["wrong", "keyWrong"], ["x2", "keyX2"], ["half", "keyHalf"], ["zero", "keyZero"], ["minusHalf", "keyMinusHalf"], ["minus2", "keyMinus2"], ["advance", "keyAdvance"],
];
import { MultButtons } from "../judge.tsx";
import { ProfileForm } from "../profile.tsx";
import { SettingsForm, settingsSummary } from "../settings.tsx";
import { avatarSrc, coverGradient, HiddenCover, initials, PackName, ReactBar, Seg } from "../ui.tsx";

import { PeoplePanel } from "./PersonMenu.tsx";

export type SideTab = "chat" | "people" | "scores" | "info" | "account" | "settings";

const I = {
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  people: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5" /><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M17.5 14.8c2 .8 3.4 2.6 4 5.2" /></>,
  scores: <><path d="M12 3v18" /><path d="M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 2 2.6 4.5 3 4.5 1.3 4.5 3-2 3-4.5 3-4.5-1.3-4.5-3" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>,
  account: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></>,
};
const Icon = ({ name }: { name: keyof typeof I }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{I[name]}</svg>
);

/** Right column below the host card: one panel at a time in the chat's place, tab bar underneath. */
export function SidePanel({ room, canHost, onProfile }: { room: RoomView; canHost: boolean; onProfile: (p: Profile) => void }) {
  const [tab, setTab] = useState<SideTab>("chat");
  const unread = useUnread(tab === "chat");
  const t = useT();
  const tabs: [SideTab, string][] = [
    ["chat", t.side.chat],
    ["people", t.menu.people],
    ...(canHost && room.phase !== "lobby" ? [["scores", t.side.scores] as [SideTab, string]] : []),
    ["info", t.side.room],
    ["account", t.account],
    ["settings", t.settings],
  ];
  const current = tabs.some(([t]) => t === tab) ? tab : "chat";
  return (
    <>
      <div className="side-body">
        {current === "chat" && <Chat viewers={room.viewers.length} canFix={canHost} voiceUrl={room.voiceUrl} />}
        {current === "people" && <PeoplePanel room={room} />}
        {current === "scores" && <ScoresPanel room={room} />}
        {current === "info" && <InfoPanel room={room} canHost={canHost} />}
        {current === "account" && <AccountPanel onProfile={onProfile} />}
        {current === "settings" && <SettingsPanel />}
      </div>
      <nav className="side-tabs" aria-label={t.side.panels}>
        {tabs.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={current === id} onClick={() => setTab(id)} title={label}>
            <Icon name={id} /><span>{label}</span>
            {id === "chat" && unread > 0 && current !== "chat" && <b className="badge">{unread > 99 ? "99+" : unread}</b>}
          </button>
        ))}
      </nav>
    </>
  );
}

/** Messages that arrived while the chat panel was hidden. */
function useUnread(open: boolean) {
  const chat = useStore((s) => s.chat);
  const seen = useRef(0);
  const lastMsg = chat.filter((c) => c.kind === "msg").at(-1)?.id ?? 0;
  if (open) seen.current = lastMsg;
  return open ? 0 : chat.filter((c) => c.kind === "msg" && c.id > seen.current).length;
}

/* ---------- chat with game feed ---------- */

/** The gear by the chat's filters: which kinds of lines to show at all (kept on this device). */
function ChatOptions({ open, setOpen, hidden }: { open: boolean; setOpen: (v: boolean) => void; hidden: Set<string> }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("pointerdown", close);
    addEventListener("keydown", esc);
    return () => { removeEventListener("pointerdown", close); removeEventListener("keydown", esc); };
  }, [open, setOpen]);
  const toggle = (k: string, show: boolean) => {
    const next = new Set(getPrefs().chatHide ?? []);
    if (show) next.delete(k); else next.add(k);
    setPrefs({ chatHide: [...next] });
  };
  return (
    <div className="chat-opts-wrap" ref={ref}>
      <button type="button" className={`chat-gear ${hidden.size ? "on" : ""}`} aria-expanded={open} aria-label={t.side.chatOptions} title={t.side.chatOptions} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.6h4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" transform="translate(-1 0)" /></svg>
      </button>
      {open && (
        <div className="chat-opts" role="dialog" aria-label={t.side.chatOptions}>
          <p className="eyebrow">{t.side.chatOptions}</p>
          {CHAT_KINDS.map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={!hidden.has(k)} onChange={(e) => toggle(k, e.target.checked)} />
              <span>{t.side.kinds[k]}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

const MAX_SHOWN = 150;
const time = (at: number, locale: string) => new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

const ChatRow = memo(function ChatRow({ m, canFix }: { m: ChatItem; canFix: boolean }) {
  const t = useT();
  if (m.kind === "ev") {
    const f = m.fix;
    return (
      <div className={`ev ${m.tone ?? ""} ${f && canFix ? "fixable" : ""}`} onMouseEnter={f && canFix ? (e) => { const el = e.currentTarget; requestAnimationFrame(() => el.scrollIntoView({ block: "nearest" })); } : undefined}>
        <span>{m.line ? t.tx(m.line) : m.text}{f?.fixed && <span className="fixed-tag"> · {t.side.fixed} {f.delta > 0 ? "+" : ""}{f.delta}</span>}</span>
        <time>{time(m.at, t.locale)}</time>
        {f && canFix && (
          <div className="fix" aria-label={t.side.fixScore}>
            <MultButtons current={f.mult ?? (f.correct ? 1 : -1)} onPick={(mult) => send({ t: "fixScore", chatId: m.id, mult })} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={`msg ${m.role === "viewer" ? "viewer" : m.role === "host" ? "host" : ""}`}>
      <img src={abs(m.avatar) || avatarSrc({ id: m.fromId ?? "?" }, false)} alt="" loading="lazy" />
      <div>
        <div className="meta"><b>{m.name}</b>{m.role === "host" ? t.side.hostTag : m.role === "viewer" ? t.side.viewerTag : ""}{time(m.at, t.locale)}</div>
        <div className="txt">{m.text}</div>
      </div>
    </div>
  );
});

/** What a chat line is about, for the chat's settings (each kind can be hidden). */
const CHAT_KINDS = ["players", "viewers", "host", "scores", "buzz", "picks", "stakes", "people", "other"] as const;
type ChatKind = (typeof CHAT_KINDS)[number];
/** A line about points: a judged answer, a stake won or lost, a corrected score. */
const isScore = (m: ChatItem) => m.kind === "ev" && (!!m.fix || m.tone === "good" || m.tone === "bad" || (m.line?.params as { delta?: unknown } | undefined)?.delta != null);
function kindOf(m: ChatItem): ChatKind {
  if (m.kind === "msg") return m.role === "viewer" ? "viewers" : m.role === "host" ? "host" : "players";
  if (isScore(m)) return "scores";
  if (m.tone === "buzz") return "buzz";
  if (m.tone === "pick") return "picks";
  if (m.tone === "bid") return "stakes";
  if (/^ev\.(join|left|kicked|hostLeft|hostTaken|swapped|newLeader)/.test(m.line?.key ?? "")) return "people";
  return "other";
}
type ChatFilter = "all" | "msg" | "ev" | "score";

const Chat = memo(function Chat({ viewers, canFix, voiceUrl }: { viewers: number; canFix: boolean; voiceUrl?: string }) {
  const items = useStore((s) => s.chat);
  const { chatHide } = usePrefs();
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [text, setText] = useState("");
  const [opts, setOpts] = useState(false);
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  const hidden = new Set(chatHide ?? []);
  const shown = items.filter((m) => {
    if (hidden.has(kindOf(m))) return false;
    if (filter === "score") return isScore(m);
    return filter === "all" || m.kind === filter;
  }).slice(-MAX_SHOWN);
  const lastId = shown.at(-1)?.id;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId, filter]);
  return (
    <section className="panel chat" aria-label={t.side.chat}>
      {canFix ? <VoiceLink url={voiceUrl} /> : voiceUrl && <VoiceButton url={voiceUrl} />}
      <div className="chat-head">
        <h2>{t.side.chat} <span className="faint" style={{ fontSize: 12, fontFamily: "var(--font-body)" }}>· {t.side.viewers(viewers)}</span></h2>
        <div className="chat-tools">
          <div className="seg">
            {([["all", t.side.all], ["msg", t.side.chat], ["ev", t.side.feed], ["score", t.side.answers]] as const).map(([v, l]) => (
              <button key={v} aria-pressed={filter === v} onClick={() => setFilter(v)}>{l}</button>
            ))}
          </div>
          <ChatOptions open={opts} setOpen={setOpts} hidden={hidden} />
        </div>
      </div>
      {canFix && <p className="note" style={{ margin: 0 }}>{t.side.fixHint}</p>}
      <div className="chat-list" ref={listRef} aria-live="polite">
        {shown.length === 0 && <p className="chat-empty">{t.side.empty}</p>}
        {shown.map((m) => <ChatRow key={m.id} m={m} canFix={canFix} />)}
      </div>
      <ReactBar />
      <form className="chat-input" onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        send({ t: "chat", text });
        setText("");
      }}>
        <input className="input" id="chat-text" value={text} maxLength={300} placeholder={t.side.message} aria-label={t.side.messageLabel} onChange={(e) => setText(e.target.value)} />
        <button className="btn sm primary" type="submit">{t.side.send}</button>
      </form>
    </section>
  );
});

/* ---------- voice chat link ---------- */

/** Opens the host's voice chat (Discord, Zoom…) in a new tab. */
function VoiceButton({ url }: { url: string }) {
  const t = useT();
  return (
    <a className="btn sm primary voice-btn" href={url} target="_blank" rel="noopener noreferrer" title={t.side.voiceOpen}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
      {t.side.voice}
    </a>
  );
}

/** Host: field for the voice chat link; once saved, the same button the players see. */
function VoiceLink({ url }: { url?: string }) {
  const t = useT();
  const [value, setValue] = useState(url ?? "");
  useEffect(() => setValue(url ?? ""), [url]);
  return (
    <form className="voice-form" onSubmit={(e) => { e.preventDefault(); send({ t: "voice", url: value.trim() || null }); }}>
      <label className="voice-label" htmlFor="voice-url">{t.side.voiceLink}</label>
      <div className="voice-row">
        <input className="input" id="voice-url" type="url" inputMode="url" value={value} maxLength={500} placeholder={t.side.voicePlaceholder} onChange={(e) => setValue(e.target.value)} />
        {value.trim() !== (url ?? "") && <button className="btn sm primary" type="submit">{t.side.voiceSave}</button>}
        {url && value.trim() === url && <button className="btn sm ghost" type="button" onClick={() => send({ t: "voice", url: null })}>{t.side.voiceRemove}</button>}
      </div>
      {url && <VoiceButton url={url} />}
    </form>
  );
}

/* ---------- scores (host) ---------- */

function ScoresPanel({ room }: { room: RoomView }) {
  const step = room.question?.price || 100;
  const t = useT();
  return (
    <section className="panel side-panel" aria-label={t.side.playerScores}>
      <h2>{t.side.scores}</h2>
      <p className="note">{t.side.stepNote(step)}</p>
      <div className="score-list">
        {room.players.map((p) => <ScoreRow key={p.id} id={p.id} name={p.name} avatar={avatarSrc(p, false)} score={p.score} step={step} />)}
      </div>
    </section>
  );
}

const ScoreRow = memo(function ScoreRow({ id, name, avatar, score, step }: { id: string; name: string; avatar: string; score: number; step: number }) {
  const [value, setValue] = useState(String(score));
  useEffect(() => setValue(String(score)), [score]);
  const t = useT();
  const save = (n: number) => { if (n !== score) send({ t: "setScore", id, score: n }); setValue(String(n)); };
  return (
    <div className="score-row">
      <img src={avatar} alt="" />
      <b title={name}>{name}</b>
      <button className="btn sm icon" onClick={() => save(score - step)} aria-label={t.side.minus(step)}>−</button>
      <form onSubmit={(e) => { e.preventDefault(); save(Number(value) || 0); }}>
        <input className="input" inputMode="numeric" value={value} aria-label={t.side.scoreOf(name)} onChange={(e) => setValue(e.target.value.replace(/[^\d-]/g, ""))} onBlur={() => save(Number(value) || 0)} />
      </form>
      <button className="btn sm icon" onClick={() => save(score + step)} aria-label={t.side.plus(step)}>+</button>
    </div>
  );
});

/* ---------- room info ---------- */

function InfoPanel({ room, canHost }: { room: RoomView; canHost: boolean }) {
  const manage = room.me.id === room.leaderId;
  const autoHost = room.settings.hostMode === "auto" || !room.host;
  const t = useT();
  return (
    <section className="panel side-panel" aria-label={t.side.room}>
      <div className="info-head">
        {room.pack?.hidden && !room.pack.revealed && room.me.role !== "host" ? <HiddenCover className="cover" /> : <span className="cover" style={{ background: coverGradient(room.pack?.name ?? room.name) }}>{initials(room.pack?.name ?? room.name)}</span>}
        <div style={{ minWidth: 0 }}><h2>{room.name}</h2><span className="note">{t.side.code} <span className="code">{room.id}</span>{room.hasPassword ? t.side.withPassword : ""}</span></div>
      </div>
      <dl className="kv">
        <dt>{t.games.pack}</dt><dd>{room.pack ? <PackName pack={room.pack} host={room.me.role === "host"} /> : t.games.notChosen}</dd>
        {room.pack && <><dt>{t.side.rounds}</dt><dd>{t.side.roundsValue(room.pack.rounds.length, room.pack.questions)}</dd></>}
        <dt>{t.games.host}</dt><dd>{autoHost ? t.games.autoHost : room.host!.name}</dd>
        <dt>{t.side.players}</dt><dd>{t.side.playersValue(room.players.length, room.settings.maxPlayers)}</dd>
        <dt>{t.side.viewersLabel}</dt><dd>{room.viewers.length}</dd>
      </dl>
      <div className="summary-tags">{settingsSummary(room.settings).map((s) => <span key={s} className="tag">{s}</span>)}</div>
      <SettingsForm value={room.settings} onChange={(s) => send({ t: "settings", settings: s })} disabled={!manage} autoHost={autoHost} inGame={room.phase !== "lobby"} sections={["type", "time", "rules"]} />
      {!manage && <p className="note">{t.game.hostChanges}</p>}
      {manage && <CloseRoom />}
    </section>
  );
}

/** Leader: close the room for everyone (asks first). */
function CloseRoom() {
  const t = useT();
  const [sure, setSure] = useState(false);
  if (!sure) return <button type="button" className="btn ghost danger close-room" onClick={() => setSure(true)}>{t.closing.close}</button>;
  return (
    <div className="close-room confirm">
      <p className="note">{t.closing.closeConfirm}</p>
      <div className="row">
        <button type="button" className="btn sm danger" onClick={() => send({ t: "closeRoom" })}>{t.closing.closeYes}</button>
        <button type="button" className="btn sm ghost" onClick={() => setSure(false)}>{t.cancel}</button>
      </div>
    </div>
  );
}

/* ---------- account ---------- */

function AccountPanel({ onProfile }: { onProfile: (p: Profile) => void }) {
  const me = useStore((s) => s.me);
  const [saved, setSaved] = useState(false);
  const t = useT();
  const stored = (() => { try { return { name: localStorage.getItem("kvz.name") ?? me?.name ?? "", avatar: localStorage.getItem("kvz.avatar") ?? undefined, gender: (localStorage.getItem("kvz.gender") as Profile["gender"]) ?? undefined }; } catch { return { name: me?.name ?? "" }; } })();
  return (
    <section className="panel side-panel" aria-label={t.account}>
      <h2>{t.account}</h2>
      <ProfileForm initial={stored} submitLabel={saved ? t.saved : t.save} onDone={(p) => {
        onProfile(p);
        send({ t: "profile", name: p.name, avatar: p.avatar ?? null, gender: p.gender ?? null });
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }} />
    </section>
  );
}

/* ---------- device settings ---------- */

export function SettingsPanel({ bare }: { bare?: boolean }) {
  const p = usePrefs();
  const t = useT();
  const s = t.prefs;
  const body = (
    <div className="settings-form">
      <section>
        <p className="eyebrow">{s.sound}</p>
        <div className="settings">
          <div className="setting"><span><span className="setting-label">{s.media}</span><span className="note">{s.mediaNote}</span></span>
            <Volume id="pref-volume" value={p.volume} onChange={(v) => setPrefs({ volume: v })} /></div>
          <div className="setting"><span><span className="setting-label">{s.sfx}</span><span className="note">{s.sfxNote}</span></span>
            <Volume id="pref-sfx" value={p.sfx} onChange={(v) => setPrefs({ sfx: v })} onRelease={() => playSound("good")} /></div>
        </div>
      </section>
      {SOUND_PICKER && <section>
        <p className="eyebrow">{s.signals}</p>
        <p className="note" style={{ margin: "0 0 8px" }}>{s.signalsNote} {s.recNote}</p>
        <div className="settings">
          {SOUND_EVENTS.map((ev) => {
            const cur = p.sounds?.[ev] ?? DEFAULT_SOUNDS[ev];
            const pick = (i: number) => { setPrefs({ sounds: { ...getPrefs().sounds, [ev]: i } }); if (i >= 0) playSound(ev, i); };
            return (
              <div className="setting" key={ev}><span><span className="setting-label">{s.events[ev]}</span></span>
                <div className="seg sound-pick" role="radiogroup" aria-label={s.events[ev]}>
                  {VARIANTS[ev].map((v, i) => (
                    <button key={i} type="button" role="radio" aria-checked={cur === i} className={v.file ? "rec" : ""} title={`${v.name ?? s.made} — ${s.listen}`} onClick={() => pick(i)}>{i + 1}</button>
                  ))}
                  <button type="button" role="radio" aria-checked={cur === -1} className={cur === -1 ? "on" : ""} onClick={() => pick(-1)}>{s.off}</button>
                </div>
              </div>
            );
          })}
        </div>
      </section>}
      <section>
        <p className="eyebrow">{s.screen}</p>
        <div className="settings">
          <div className="setting"><span><span className="setting-label">{s.lang}</span></span>
            <Seg value={p.lang} onChange={(v) => setPrefs({ lang: v })} options={LANGS} /></div>
          <div className="setting"><span><span className="setting-label">{s.graphics}</span><span className="note">{p.fx === "low" ? s.fxLow : p.fx === "mid" ? s.fxMid : s.fxHigh}</span></span>
            <Seg value={p.fx} onChange={(v) => setPrefs({ fx: v })} options={[["low", s.fast], ["mid", s.normal], ["high", s.pretty]]} /></div>
          <div className="setting"><span><span className="setting-label">{s.motion}</span><span className="note">{s.motionNote}</span></span>
            <Seg value={p.motion} onChange={(v) => setPrefs({ motion: v })} options={[["full", s.all], ["reduced", s.minimum]]} /></div>
        </div>
      </section>
      <section>
        <p className="eyebrow">{s.controls}</p>
        <div className="settings">
          <KeyRow label={s.answerKey} value={p.answerKey} onChange={(k) => setPrefs({ answerKey: k })} />
          <KeyRow label={s.passKey} value={p.passKey} onChange={(k) => setPrefs({ passKey: k })} />
        </div>
        <p className="note" style={{ marginTop: 6 }}>{s.keysNote}</p>
      </section>
      <section>
        <p className="eyebrow">{s.hostControls}</p>
        <div className="settings">
          {HOST_KEY_ROWS.map(([k, label]) => (
            <KeyRow key={k} label={s[label]} value={p.hostKeys[k]} onChange={(v) => setPrefs({ hostKeys: { ...p.hostKeys, [k]: v } })} />
          ))}
        </div>
        <p className="note" style={{ marginTop: 6 }}>{s.hostKeysNote}</p>
        <button type="button" className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => setPrefs({ hostKeys: HOST_KEY_DEFAULTS })}>{s.resetKeys}</button>
      </section>
      <p className="note">{s.deviceOnly}</p>
    </div>
  );
  return bare ? body : <section className="panel side-panel" aria-label={t.settings}><h2>{t.settings}</h2>{body}</section>;
}

function KeyRow({ label, value, onChange }: { label: string; value: string; onChange: (k: string) => void }) {
  const t = useT();
  const [listen, setListen] = useState(false);
  useEffect(() => {
    if (!listen) return;
    const down = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== "Escape") onChange(keyFromEvent(e));
      setListen(false);
    };
    addEventListener("keydown", down, true);
    return () => removeEventListener("keydown", down, true);
  }, [listen, onChange]);
  return (
    <div className="setting key-setting">
      <span><span className="setting-label">{label}</span></span>
      <span className="row" style={{ gap: 8 }}>
        <kbd className="key-cap">{listen ? t.prefs.pressKey : keyLabel(value, t.q.space)}</kbd>
        <button type="button" className="btn sm" onClick={() => setListen(true)}>{t.prefs.change}</button>
      </span>
    </div>
  );
}

/** Pack audio and video volume, small, for the top bar: always at hand during the game. */
export function VolumeChip() {
  const { volume } = usePrefs();
  const t = useT();
  const [last, setLast] = useState(volume || 0.8);
  return (
    <span className="chip vol-chip" title={t.prefs.mediaNote}>
      <button type="button" className="vol-icon" aria-label={volume ? t.prefs.mute : t.prefs.unmute} onClick={() => { if (volume) { setLast(volume); setPrefs({ volume: 0 }); } else setPrefs({ volume: last }); }}>
        {volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
      </button>
      <input type="range" min={0} max={100} step={5} value={Math.round(volume * 100)} aria-label={t.prefs.media} aria-valuetext={`${Math.round(volume * 100)}%`}
        onChange={(e) => setPrefs({ volume: Number(e.target.value) / 100 })} />
    </span>
  );
}

function Volume({ id, value, onChange, onRelease }: { id: string; value: number; onChange: (v: number) => void; onRelease?: () => void }) {
  const t = useT();
  return (
    <div className="stepper">
      <input id={id} type="range" min={0} max={100} step={5} value={Math.round(value * 100)} onChange={(e) => onChange(Number(e.target.value) / 100)} onPointerUp={onRelease} onKeyUp={onRelease} aria-valuetext={`${Math.round(value * 100)}%`} />
      <output htmlFor={id} className="stepper-val">{value ? `${Math.round(value * 100)}%` : t.prefs.off}</output>
    </div>
  );
}
