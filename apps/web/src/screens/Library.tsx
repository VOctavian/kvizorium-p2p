import { useEffect, useRef, useState } from "react";
import { MAX_PACK_MB } from "@kvz/protocol";
import { useT } from "../i18n.ts";
import { PEER_MODE, serverBase } from "../net.ts";
import { downloadSib, searchSib, SIB_CATEGORIES, SIB_TAGS, sibBase, tooBig, type SibPack, type SibQuery } from "../sibrowser.ts";
import { Modal, Seg } from "../ui.tsx";

/** The button that opens the SIBrowser library; a pack picked there arrives as a file. */
export function LibraryButton({ onPick, className }: { onPick: (f: File) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  return (
    <>
      <button type="button" className={`btn lib-open ${className ?? ""}`} onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.2 4.2-1.4 1.4-4.2-4.2A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z" /></svg>
        {t.lib.open}
      </button>
      {open && <Library onClose={() => setOpen(false)} onPick={(f) => { setOpen(false); onPick(f); }} />}
    </>
  );
}

const PAGE_SET = 2;

function Library({ onClose, onPick }: { onClose: () => void; onPick: (f: File) => void }) {
  const t = useT();
  const L = t.lib;
  const base = sibBase(serverBase(), PEER_MODE);
  const [text, setText] = useState("");
  const [q, setQ] = useState<SibQuery>({ sort: "date" });
  const [items, setItems] = useState<SibPack[]>([]);
  const [total, setTotal] = useState<number>();
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [dl, setDl] = useState<{ id: number; share: number }>();
  const abort = useRef<AbortController | undefined>(undefined);

  // Typing: search a moment after the last key.
  useEffect(() => {
    const h = setTimeout(() => setQ((cur) => (cur.q === text.trim() ? cur : { ...cur, q: text.trim() || undefined, tag: text.trim() ? undefined : cur.tag })), 450);
    return () => clearTimeout(h);
  }, [text]);

  /** Loads the next pages (two at once: SIBrowser gives five a page). */
  const load = async (query: SibQuery, from: number, reset: boolean) => {
    if (!base) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setLoading(true);
    setError(false);
    // A new search: the old results go at once (SIBrowser may take a few seconds to answer).
    if (reset) { setItems([]); setTotal(undefined); setMore(false); }
    try {
      const pages = await Promise.all(Array.from({ length: PAGE_SET }, (_, i) => searchSib(base, { ...query, page: from + i }, ctl.signal)));
      if (ctl.signal.aborted) return;
      const got = pages.flatMap((p) => p.items);
      setItems((cur) => {
        const all = reset ? got : [...cur, ...got];
        return all.filter((p, i) => all.findIndex((x) => x.id === p.id) === i);
      });
      setTotal(pages[0].total);
      setMore(pages[pages.length - 1].more);
      setPage(from + PAGE_SET - 1);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(true);
    } finally {
      if (!ctl.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => { void load(q, 1, true); return () => abort.current?.abort(); }, [q.q, q.sort, q.tag, q.category]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (p: SibPack) => {
    if (!base || dl) return;
    setDl({ id: p.id, share: 0 });
    try {
      const file = await downloadSib(base, p, (share) => setDl({ id: p.id, share }));
      onPick(file);
    } catch {
      setError(true);
      setDl(undefined);
    }
  };

  return (
    <Modal title={L.title} onClose={onClose} wide>
      {!base ? (
        <div className="lib-none">
          <p>{L.noProxy}</p>
          <a className="btn" href="https://www.sibrowser.ru/" target="_blank" rel="noreferrer">{L.onSite}</a>
        </div>
      ) : (
        <div className="lib">
          <div className="lib-filters">
            <input className="input" id="lib-search" type="search" autoFocus value={text} placeholder={L.search} aria-label={L.search} onChange={(e) => setText(e.target.value)} />
            <Seg value={q.sort ?? "date"} onChange={(v) => setQ({ ...q, sort: v })} options={[["date", L.newest], ["downloads", L.popular]]} />
            <div className="lib-chips" role="group" aria-label={L.category}>
              <span className="note">{L.category}</span>
              <button type="button" className="chip-btn" aria-pressed={!q.category} onClick={() => setQ({ ...q, category: undefined })}>{L.any}</button>
              {SIB_CATEGORIES.map((c) => (
                <button key={c.id} type="button" className="chip-btn" aria-pressed={q.category === c.id} onClick={() => setQ({ ...q, category: c.id, tag: undefined })}>{c.name}</button>
              ))}
            </div>
            <div className="lib-chips" role="group" aria-label={L.tag}>
              <span className="note">{L.tag}</span>
              <button type="button" className="chip-btn" aria-pressed={!q.tag} onClick={() => setQ({ ...q, tag: undefined })}>{L.any}</button>
              {[...new Set([...SIB_TAGS, ...(q.tag ? [q.tag] : [])])].map((tag) => (
                <button key={tag} type="button" className="chip-btn" disabled={!!q.q} aria-pressed={q.tag === tag} onClick={() => setQ({ ...q, tag, category: undefined })}>{tag}</button>
              ))}
            </div>
            {q.q && <p className="note" style={{ margin: 0 }}>{L.textFirst}</p>}
          </div>

          <div className="lib-head">
            <span className="note">{total != null ? L.found(total) : ""}</span>
            <span className="note">{L.credit}</span>
          </div>

          <div className="lib-list" aria-busy={loading}>
            {items.map((p) => <PackCard key={p.id} p={p} dl={dl?.id === p.id ? dl.share : undefined} busy={!!dl} onPick={() => void pick(p)} onTag={(tag) => { setText(""); setQ({ ...q, q: undefined, tag, category: undefined }); }} />)}
            {!loading && !items.length && !error && <p className="dim">{L.nothing}</p>}
            {error && <p className="lib-error">{L.error}</p>}
            {loading && <p className="dim lib-loading"><span className="spinner" /> {L.loading}</p>}
            {!loading && more && <button type="button" className="btn ghost" onClick={() => void load(q, page + 1, false)}>{L.more}</button>}
          </div>
        </div>
      )}
      <div className="foot"><button type="button" className="btn" onClick={onClose}>{t.cancel}</button></div>
    </Modal>
  );
}

function PackCard({ p, dl, busy, onPick, onTag }: { p: SibPack; dl?: number; busy: boolean; onPick: () => void; onTag: (tag: string) => void }) {
  const t = useT();
  const L = t.lib;
  const big = tooBig(p);
  const m = p.media;
  return (
    <article className="lib-card">
      <img className="lib-logo" src={p.logo} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
      <div className="lib-body">
        <h3>{p.name}</h3>
        <div className="note">{[p.author, p.date, p.sizeText, p.questions ? L.questions(p.questions) : ""].filter(Boolean).join(" · ")}</div>
        {p.tags.length > 0 && (
          <div className="lib-tags">{p.tags.slice(0, 10).map((tag) => <button key={tag} type="button" className="tag" onClick={() => onTag(tag)}>{tag}</button>)}</div>
        )}
        {m && (
          <div className="lib-media">
            {([[L.text, m.text], [L.photo, m.photo], [L.audio, m.audio], [L.video, m.video]] as const).map(([name, v]) => (
              <span key={name}><i style={{ width: `${v}%` }} />{name} {v}%</span>
            ))}
          </div>
        )}
        {p.description && <p className="lib-desc">{p.description}</p>}
        {p.rounds.length > 0 && (
          <details className="lib-rounds">
            <summary>{L.rounds}</summary>
            {p.rounds.map((r, i) => <div key={i}><b>{r.name}:</b> {r.themes}</div>)}
          </details>
        )}
        <div className="lib-actions">
          {dl != null ? (
            <div className="lib-progress"><span>{L.downloading(Math.round(dl * 100))}</span><div className="progress"><i style={{ width: `${dl * 100}%` }} /></div></div>
          ) : (
            <button type="button" className="btn sm primary" disabled={busy || big} onClick={onPick}>{big ? L.tooBig(MAX_PACK_MB) : L.pick}</button>
          )}
          <a className="btn sm ghost" href={p.page} target="_blank" rel="noreferrer">{L.onSite}</a>
        </div>
      </div>
    </article>
  );
}
