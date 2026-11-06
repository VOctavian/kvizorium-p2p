import { useT, type T } from "../i18n.ts";
import { useMemo, useState } from "react";
import { type RoomSummary, type Settings } from "@kvz/protocol";
import { deletePreset, loadLastChoice, loadPresets, saveLastChoice, savePreset, type Preset } from "../createPrefs.ts";
import { abs, send, setPendingPack, useStore } from "../net.ts";
import { SettingsForm, settingsSummary, Stepper } from "../settings.tsx";
import { avatarSrc, coverGradient, HiddenCover, HiddenName, initials, Lock, Modal, Seg, toggleFullscreen, useNow } from "../ui.tsx";

export function Games({ onEditProfile, onSettings }: { onEditProfile: () => void; onSettings: () => void }) {
  const rooms = useStore((s) => s.rooms);
  const conn = useStore((s) => s.status);
  const me = useStore((s) => s.me);
  const t = useT();
  const [q, setQ] = useState("");
  const [f, setF] = useState<Filters>(loadFilters);
  const [moreFilters, setMoreFilters] = useState(false);
  const [sel, setSel] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const now = useNow(30_000);
  const [joining, setJoining] = useState<{ room?: RoomSummary; code?: boolean } | null>(null);
  const patchF = (p: Partial<Filters>) => setF((x) => { const n = { ...x, ...p }; saveFilters(n); return n; });

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rooms.filter((r) => matches(r, f) && (!needle || `${r.name} ${r.packName ?? ""} ${r.hostName} ${r.id}`.toLowerCase().includes(needle)));
  }, [rooms, q, f]);
  const selected = list.find((r) => r.id === sel) ?? list[0];
  const changed = JSON.stringify(f) !== JSON.stringify(NO_FILTERS);

  const join = (r: RoomSummary, asViewer = false) => {
    if (r.hasPassword) setJoining({ room: r });
    else send({ t: "joinRoom", roomId: r.id, asViewer });
  };

  return (
    <div className="stage single">
      <div className="main">
        <header className="hud">
          <div className="logo"><span className="mark" aria-hidden="true" />{t.appName}</div>
          <span className="chip"><span className={`dot ${conn === "open" ? "" : "off"}`} aria-hidden="true" />{conn === "open" ? t.games.online : t.games.connecting}</span>
          <span className="chip">{t.games.openGames} <b>{rooms.length}</b></span>
          <button className="chip" onClick={onEditProfile} title={t.games.editProfile}>
            {me?.avatar && <img src={abs(me.avatar)} alt="" />}<b>{me?.name ?? "…"}</b>
          </button>
          <button className="chip" onClick={onSettings}>{t.settings}</button>
          <button className="chip" onClick={() => { location.hash = "showcase"; location.reload(); }}>{t.games.showcase}</button>
          <button className="chip" onClick={toggleFullscreen} title={t.fullscreenHint} aria-label={t.fullscreen}>⛶</button>
        </header>

        <section className="screen">
          <div className="games three">
            <div className="panel games-list">
              <div className="toolbar">
                <input className="input" id="room-search" type="search" placeholder={t.games.search} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t.games.searchLabel} />
              </div>
              <div className="quick-filters" role="group" aria-label={t.games.filters}>
                <Seg value={f.status} onChange={(v) => patchF({ status: v })} options={[["all", t.games.all], ["wait", t.games.wait], ["play", t.games.play]]} />
                <Seg value={f.password} onChange={(v) => patchF({ password: v })} options={[["any", t.games.passwordAny], ["yes", t.games.withPass], ["no", t.games.noPassword]]} />
                <Seg value={f.oral} onChange={(v) => patchF({ oral: v })} options={[["any", t.games.oralAny], ["yes", t.games.oralYes], ["no", t.games.oralNo]]} />
                <Seg value={f.lang} onChange={(v) => patchF({ lang: v })} options={[["any", t.games.langAny], ["ru", t.games.langRu], ["other", t.games.langOther]]} />
                <button type="button" className={`btn sm ghost ${moreFilters ? "on" : ""}`} aria-expanded={moreFilters} onClick={() => setMoreFilters(!moreFilters)}>{t.games.filtersMore}{moreExtra(f) ? ` · ${moreExtra(f)}` : ""} ▾</button>
                {changed && <button type="button" className="btn sm ghost" onClick={() => { setF(NO_FILTERS); saveFilters(NO_FILTERS); }}>{t.games.resetFilters}</button>}
              </div>
              {moreFilters && (
                <div className="more-filters settings">
                  <div className="setting"><span className="setting-label">{t.games.anonFilter}</span>
                    <Seg value={f.anon} onChange={(v) => patchF({ anon: v })} options={[["any", t.games.any], ["yes", t.games.anonYes], ["no", t.games.anonNo]]} /></div>
                  <div className="setting"><span className="setting-label">{t.games.seatsFilter}</span>
                    <span className="row" style={{ gap: 8 }}>{t.games.from} <Stepper id="f-seats-min" value={f.seatsMin} min={1} max={f.seatsMax} onChange={(v) => patchF({ seatsMin: v })} /> {t.games.to} <Stepper id="f-seats-max" value={f.seatsMax} min={f.seatsMin} max={12} onChange={(v) => patchF({ seatsMax: v })} /></span></div>
                  <div className="setting"><span className="setting-label">{t.games.typeFilter}</span>
                    <Seg value={f.type} onChange={(v) => patchF({ type: v })} options={[["any", t.games.any], ["classic", t.game.classic], ["simple", t.game.simple]]} /></div>
                  <div className="setting"><span className="setting-label">{t.games.falseStartFilter}</span>
                    <Seg value={f.falseStart} onChange={(v) => patchF({ falseStart: v })} options={[["any", t.games.any], ["yes", t.games.fsYes], ["no", t.games.fsNo]]} /></div>
                </div>
              )}
              <div className="room-list" role="listbox" aria-label={t.games.list}>
                {list.length ? list.map((r) => (
                  <button key={r.id} className="room" role="option" aria-selected={selected?.id === r.id} onClick={() => setSel(r.id)} onDoubleClick={() => join(r)}>
                    {r.packHidden ? <HiddenCover className="cover" /> : <span className="cover" style={{ background: coverGradient(r.packName ?? r.name) }}>{initials(r.packName ?? r.name)}</span>}
                    <span className="info"><b>{r.name}</b><span>{r.packHidden ? <HiddenName className="inline" /> : r.packName ?? t.games.noPack} · {r.hostFree ? t.games.hostFree : t.games.hosts(r.hostName)} · {roomTime(r, now, t)}</span></span>
                    <span className="seats">{r.players}<small>/{r.maxPlayers}</small></span>
                    {r.status === "play" ? <span className="pill play">{r.round ? t.tx(r.round) : t.games.going}</span> : r.players >= r.maxPlayers ? <span className="pill full">{t.games.full}</span> : <span className="pill wait">{t.games.wait}</span>}
                    <span>{r.hasPassword && <Lock />}</span>
                  </button>
                )) : (
                  <div className="empty-list">
                    <b>{rooms.length ? t.games.nothingFound : t.games.nobody}</b>
                    <span>{rooms.length ? t.games.resetHint : t.games.createHint}</span>
                    <button className="btn primary" onClick={() => setCreating(true)}>{t.games.create}</button>
                  </div>
                )}
              </div>
              <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
                <button className="btn" onClick={() => setJoining({ code: true })}>{t.games.byCode}</button>
                <button className="btn primary" onClick={() => setCreating(true)}>{t.games.create}</button>
              </div>
            </div>

            <aside className="panel detail">
              {selected ? (
                <>
                  {selected.packHidden ? <HiddenCover className="big-cover" /> : <div className="big-cover" style={{ background: coverGradient(selected.packName ?? selected.name) }}>{initials(selected.packName ?? selected.name)}</div>}
                  <div>
                    <p className="eyebrow" style={{ marginBottom: 4 }}>{selected.hasPassword ? t.games.withPassword : t.games.open} · {t.games.code} <span className="code">{selected.id}</span></p>
                    <h2>{selected.name}</h2>
                  </div>
                  <dl className="kv">
                    <dt>{t.games.pack}</dt><dd>{selected.packHidden ? <HiddenName /> : selected.packName ?? t.games.notChosen}</dd>
                    <dt>{t.games.host}</dt><dd>{selected.hostFree ? t.games.hostFree : selected.hostName}</dd>
                    <dt>{t.games.answers}</dt><dd>{selected.oral ? t.games.oral : t.games.written}</dd>
                    <dt>{t.games.rules}</dt><dd>{selected.gameType === "classic" ? t.games.classic : t.games.simple}{selected.allowViewers ? "" : t.games.noViewers}</dd>
                    {selected.lang && <><dt>{t.games.langLabel}</dt><dd>{selected.lang === "ru" ? t.games.langRuValue : t.games.langOtherValue}</dd></>}
                    <dt>{t.games.status}</dt><dd>{selected.status === "play" ? (selected.round ? t.tx(selected.round) : t.games.going) : t.games.gathering}</dd>
                    <dt>{selected.startedAt ? t.games.going : t.games.created}</dt><dd>{selected.startedAt ? elapsed(now - selected.startedAt, t) : stamp(selected.createdAt)}</dd>
                  </dl>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <div className="av-stack">{selected.avatars.map((a) => <img key={a.id} src={avatarSrc(a, false)} alt="" />)}</div>
                    <span className="seats">{selected.players}<small>{t.games.playersOf(selected.maxPlayers)}</small></span>
                  </div>
                  <div className="actions2">
                    <button className="btn ghost" onClick={() => join(selected, true)}>{t.games.watch}</button>
                    <button className="btn primary" onClick={() => join(selected)}>{selected.status === "wait" && selected.players < selected.maxPlayers ? t.enter : t.games.asViewer}</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="eyebrow" style={{ margin: 0 }}>{t.games.notSelected}</p>
                  <p className="dim" style={{ margin: 0 }}>{t.games.selectHint}</p>
                </>
              )}
            </aside>

            <StatsPanel now={now} />
          </div>
        </section>
      </div>

      {creating && <CreateRoom onClose={() => setCreating(false)} />}
      {joining && (
        <JoinModal room={joining.room} askCode={!!joining.code} onClose={() => setJoining(null)} />
      )}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Y-m-d H:i:s in local time */
function stamp(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function elapsed(ms: number, t: T) {
  const min = Math.max(0, Math.floor(ms / 60_000));
  return min < 60 ? t.games.minutes(min) : t.games.hours(Math.floor(min / 60), pad(min % 60));
}
function roomTime(r: RoomSummary, now: number, t: T) {
  return r.startedAt ? t.games.goingFor(elapsed(now - r.startedAt, t)) : t.games.createdAt(stamp(r.createdAt));
}

function CreateRoom({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me);
  const demoPacks = useStore((s) => s.demoPacks);
  const t = useT();
  const [name, setName] = useState(me ? t.create.defaultName(me.name) : "");
  const [password, setPassword] = useState("");
  const [first] = useState(loadLastChoice);
  const [settings, setSettings] = useState<Settings>(first.settings);
  const [asHost, setAsHost] = useState(first.asHost);
  const [presets, setPresets] = useState<Preset[]>(loadPresets);
  const [presetName, setPresetName] = useState<string | null>(null);
  const [pack, setPack] = useState<{ file?: File; demoId?: string; label: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [over, setOver] = useState(false);
  const [err, setErr] = useState("");
  const patch = (p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p }));
  const applyPreset = (p: Preset) => { setSettings(p.settings); setAsHost(p.asHost); };
  const samePreset = (p: Preset) => p.asHost === asHost && JSON.stringify(p.settings) === JSON.stringify(settings);
  const pickFile = (f?: File) => {
    if (!f) return;
    if (!/\.(siq|zip)$/i.test(f.name)) return setErr(t.needSiq);
    setErr("");
    setPack({ file: f, label: f.name });
  };

  return (
    <Modal title={t.create.title} onClose={onClose} wide>
      <form style={{ display: "grid", gap: 16 }} onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return setErr(t.create.needName);
        setPendingPack(pack ? { file: pack.file, demoId: pack.demoId } : null);
        saveLastChoice({ settings, asHost });
        send({ t: "createRoom", name, password: password || undefined, asHost, settings });
        onClose();
      }}>
        <div className="field presets"><span>{t.create.presets}</span>
          <div className="row">
            {presets.map((p) => (
              <span key={p.name} className="preset-chip">
                <button type="button" className="btn sm" aria-pressed={samePreset(p)} onClick={() => applyPreset(p)}>{p.name}</button>
                <button type="button" className="preset-x" aria-label={t.create.deletePreset(p.name)} title={t.create.deletePreset(p.name)} onClick={() => setPresets(deletePreset(p.name))}>×</button>
              </span>
            ))}
            {presetName == null ? (
              <button type="button" className="btn sm ghost" onClick={() => setPresetName("")}>+ {t.create.savePreset}</button>
            ) : (
              <span className="preset-new">
                <input className="input" id="preset-name" autoFocus maxLength={30} placeholder={t.create.presetName} value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { e.preventDefault(); setPresetName(null); }
                    if (e.key === "Enter") { e.preventDefault(); if (presetName.trim()) { setPresets(savePreset({ name: presetName.trim(), settings, asHost })); setPresetName(null); } }
                  }} />
                <button type="button" className="btn sm primary" disabled={!presetName.trim()} onClick={() => { setPresets(savePreset({ name: presetName.trim(), settings, asHost })); setPresetName(null); }}>{t.create.presetSave}</button>
                <button type="button" className="btn sm ghost" onClick={() => setPresetName(null)}>{t.cancel}</button>
              </span>
            )}
          </div>
          {!presets.length && presetName == null && <span className="note">{t.create.noPresets}</span>}
        </div>

        <label className="field"><span>{t.create.roomName}</span><input className="input" id="room-name" value={name} maxLength={40} onChange={(e) => { setName(e.target.value); setErr(""); }} /></label>

        <div className="field"><span>{t.create.pack}</span>
          <div className="pack-pick">
            {pack && (
              <div className="pack-chosen">
                <span className="cover" style={{ background: coverGradient(pack.label) }}>{initials(pack.label)}</span>
                <div style={{ minWidth: 0, flex: 1 }}><b>{pack.label}</b><span className="note">{pack.file ? `${(pack.file.size / 1048576).toLocaleString(t.locale, { maximumFractionDigits: 1 })} ${t.mb} · ${t.create.afterCreate}` : t.create.builtIn}</span></div>
                <button type="button" className="btn sm ghost" onClick={() => setPack(null)}>{t.remove}</button>
              </div>
            )}
            <label className={`drop ${over ? "over" : ""}`} style={{ marginTop: 0 }}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); pickFile(e.dataTransfer.files[0]); }}>
              <span>{t.dropSiq}</span>
              <span className="btn ghost sm file-btn">{t.create.chooseFile}<input type="file" accept=".siq,.zip" onChange={(e) => pickFile(e.target.files?.[0])} /></span>
            </label>
            {demoPacks.length > 0 && (
              <div className="row"><span className="note">{t.create.orBuiltIn}</span>
                {demoPacks.map((p) => <button key={p.id} type="button" className="btn sm" aria-pressed={pack?.demoId === p.id} onClick={() => setPack({ demoId: p.id, label: p.name })}>{p.name}</button>)}
              </div>
            )}
            <label className="check-row">
              <input type="checkbox" id="create-anon" checked={settings.anonPack} onChange={(e) => patch({ anonPack: e.target.checked })} />
              <span><b><Lock /> {t.anon.checkbox}</b><span className="note">{t.anon.note}</span></span>
            </label>
          </div>
        </div>

        <div className="settings" style={{ marginTop: 0 }}>
          <div className="setting"><span><span className="setting-label">{t.create.whoHosts}</span><span className="note">{asHost ? t.create.humanNote : t.create.playNote}</span></span>
            <Seg value={asHost} onChange={setAsHost} options={[[true, t.create.iHost], [false, t.create.iPlay]]} /></div>
          <div className="setting"><span><span className="setting-label">{t.game.answers}</span><span className="note">{settings.oral ? t.create.oralAloud : t.game.writtenNote}</span></span>
            <Seg value={settings.oral} onChange={(v) => patch({ oral: v })} options={[[true, t.game.oral], [false, t.game.written]]} /></div>
          <div className="setting"><span><span className="setting-label">{t.game.seats}</span><span className="note">{t.create.seatsRange}</span></span>
            <Stepper id="create-players" value={settings.maxPlayers} min={1} max={12} onChange={(v) => patch({ maxPlayers: v })} /></div>
        </div>

        <label className="field"><span>{t.create.password}</span><input className="input" id="room-password" value={password} maxLength={30} placeholder={t.create.passwordPlaceholder} onChange={(e) => setPassword(e.target.value)} /></label>

        <button type="button" className="btn ghost advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
          {t.create.advanced} <span className="note">{advanced ? "" : settingsSummary(settings).slice(1, 5).join(" · ")}</span><span className="chev" aria-hidden="true">▾</span>
        </button>
        {advanced && <SettingsForm value={settings} onChange={patch} autoHost={!asHost} sections={["type", "time", "rules"]} />}
        <p className="note" style={{ margin: 0 }}>{t.create.rememberNote}</p>

        {err && <p className="err">{err}</p>}
        <div className="foot"><button type="button" className="btn ghost" onClick={onClose}>{t.cancel}</button><button className="btn primary" type="submit">{t.games.create}</button></div>
      </form>
    </Modal>
  );
}

/**
 * Codes are Latin letters and digits. Typed on a Russian layout or copied from a chat, the same-looking
 * Cyrillic letters (А, В, Е, К, М, Н, Р, С, Т, Х, У) are taken for the Latin ones; spaces are dropped.
 */
const LOOKALIKE: Record<string, string> = { А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", У: "Y", З: "3", Ч: "4", Б: "6" };
function normalizeCode(s: string): string {
  return [...s.toUpperCase().replace(/[\s-]+/g, "")].map((c) => LOOKALIKE[c] ?? c).join("").slice(0, 4);
}

function JoinModal({ room, askCode, onClose }: { room?: RoomSummary; askCode: boolean; onClose: () => void }) {
  const [code, setCode] = useState(room?.id ?? "");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const t = useT();
  return (
    <Modal title={room ? t.join.into(room.name) : t.join.byCode} onClose={onClose}>
      <form style={{ display: "grid", gap: 14 }} onSubmit={(e) => {
        e.preventDefault();
        if (code.trim().length < 4) return setErr(t.join.codeLength);
        send({ t: "joinRoom", roomId: normalizeCode(code), password: password || undefined });
        onClose();
      }}>
        {askCode && <label className="field"><span>{t.join.code}</span><input className="input code" id="join-code" value={code} maxLength={8} placeholder="QZ4F" autoFocus onChange={(e) => { setCode(normalizeCode(e.target.value)); setErr(""); }} /></label>}
        {(!room || room.hasPassword) && <label className="field"><span>{t.join.password}{room ? "" : t.join.ifAny}</span><input className="input" id="join-password" type="password" value={password} autoFocus={!askCode} onChange={(e) => setPassword(e.target.value)} /></label>}
        {err && <p className="err">{err}</p>}
        <div className="foot"><button type="button" className="btn ghost" onClick={onClose}>{t.cancel}</button><button className="btn primary" type="submit">{t.enter}</button></div>
      </form>
    </Modal>
  );
}

/* ---------- filters ---------- */

type Tri = "any" | "yes" | "no";
interface Filters {
  status: "all" | "wait" | "play";
  password: Tri;
  oral: Tri;
  lang: "any" | "ru" | "other";
  anon: Tri;
  seatsMin: number;
  seatsMax: number;
  type: "any" | "classic" | "simple";
  falseStart: Tri;
}
const NO_FILTERS: Filters = { status: "all", password: "any", oral: "any", lang: "any", anon: "any", seatsMin: 1, seatsMax: 12, type: "any", falseStart: "any" };
const FILTERS_KEY = "kvz.games.filters";
function loadFilters(): Filters {
  try { return { ...NO_FILTERS, ...(JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "{}") as Partial<Filters>) }; } catch { return { ...NO_FILTERS }; }
}
function saveFilters(f: Filters) { try { localStorage.setItem(FILTERS_KEY, JSON.stringify(f)); } catch { /* storage blocked */ } }
const tri = (want: Tri, v: boolean) => want === "any" || (want === "yes") === v;
function matches(r: RoomSummary, f: Filters) {
  return (f.status === "all" || r.status === f.status)
    && tri(f.password, r.hasPassword) && tri(f.oral, r.oral) && tri(f.anon, r.anonPack) && tri(f.falseStart, r.falseStart)
    && (f.lang === "any" || r.lang === f.lang)
    && r.maxPlayers >= f.seatsMin && r.maxPlayers <= f.seatsMax
    && (f.type === "any" || r.gameType === f.type);
}
/** How many of the filters behind the button are set. */
const moreExtra = (f: Filters) => [f.anon !== "any", f.seatsMin !== 1 || f.seatsMax !== 12, f.type !== "any", f.falseStart !== "any"].filter(Boolean).length;

/* ---------- right column: top packs / latest games ---------- */

function StatsPanel({ now }: { now: number }) {
  const stats = useStore((s) => s.stats);
  const t = useT();
  const [tab, setTab] = useState<"top" | "recent">("top");
  return (
    <aside className="panel stats-panel">
      <div className="seg stats-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "top"} aria-pressed={tab === "top"} onClick={() => setTab("top")}>{t.games.tabTop}</button>
        <button role="tab" aria-selected={tab === "recent"} aria-pressed={tab === "recent"} onClick={() => setTab("recent")}>{t.games.tabRecent}</button>
      </div>
      {tab === "top" ? (
        stats?.top.length ? (
          <ol className="top-packs">
            {stats.top.map((p, i) => (
              <li key={p.hash}>
                <span className="place">{i + 1}</span>
                <span className="cover" style={{ background: coverGradient(p.name) }}>{initials(p.name)}</span>
                <span className="who"><b title={p.name}>{p.name}</b><span className="note">{t.games.gamesCount(p.games)} · {t.games.questionsShort(p.questions)}</span></span>
              </li>
            ))}
          </ol>
        ) : <p className="note">{t.games.topEmpty}</p>
      ) : stats?.recent.length ? (
        <ul className="recent-games">
          {stats.recent.map((g) => (
            <li key={g.id}>
              <span className="who">
                <b title={g.roomName}>{g.roomName}</b>
                <span className="note">{g.packHidden ? <HiddenName className="inline" /> : g.packName} · {elapsed(now - g.endedAt, t)}</span>
                <span className="note">{g.winner ? t.games.winnerIs(g.winner, g.winnerScore ?? 0) : t.games.noWinner} · {t.games.playersN(g.players)}{g.minutes ? ` · ${t.games.lasted(g.minutes)}` : ""}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="note">{t.games.recentEmpty}</p>}
    </aside>
  );
}
