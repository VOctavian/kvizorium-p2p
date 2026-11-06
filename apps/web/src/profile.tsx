import { useState } from "react";
import type { Gender } from "@kvz/protocol";
import { saveProfile, serverBase, setServerBase, type Profile } from "./net.ts";
import { defaultAvatar, readImageFile, Seg } from "./ui.tsx";
import { useT } from "./i18n.ts";

/** Name, avatar and gender; on the welcome screen also the server address. */
export function ProfileForm({ initial, submitLabel, onDone, showServer }: { initial: Profile; submitLabel: string; onDone: (p: Profile) => void; showServer?: boolean }) {
  const [name, setName] = useState(initial.name);
  const [avatar, setAvatar] = useState(initial.avatar);
  const [gender, setGender] = useState<Gender | "">(initial.gender ?? "");
  const [server, setServer] = useState(() => serverBase());
  const [err, setErr] = useState("");
  const t = useT();
  return (
    <form style={{ display: "grid", gap: 16 }} onSubmit={(e) => {
      e.preventDefault();
      if (!name.trim()) return setErr(t.profile.needName);
      const p: Profile = { name: name.trim().slice(0, 24), avatar, gender: gender || undefined };
      if (showServer) setServerBase(server.trim() && server.trim() !== location.origin ? server.trim() : null);
      saveProfile(p);
      onDone(p);
    }}>
      <div className="av-edit">
        <img src={avatar ?? defaultAvatar(name || t.profile.guest)} alt={t.profile.yourAvatar} />
        <div style={{ display: "grid", gap: 8 }}>
          <label className="btn sm file-btn">{t.profile.upload}
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try { setAvatar(await readImageFile(f)); setErr(""); } catch (x) { setErr((x as Error).message); }
            }} />
          </label>
          {avatar && <button type="button" className="btn sm ghost" onClick={() => setAvatar(undefined)}>{t.remove}</button>}
          <span className="note">{t.profile.formats}</span>
        </div>
      </div>
      <label className="field"><span>{t.profile.name}</span>
        <input className="input" id="profile-name" value={name} maxLength={24} placeholder={t.profile.namePlaceholder} autoFocus={!initial.name} onChange={(e) => { setName(e.target.value); setErr(""); }} />
      </label>
      <div className="field"><span>{t.profile.gender}</span>
        <Seg value={gender} onChange={setGender} options={[["m", t.profile.male], ["f", t.profile.female], ["", t.profile.unset]]} />
        <span className="note">{t.profile.genderNote}</span>
      </div>
      {showServer && (
        <details>
          <summary>{t.profile.server}</summary>
          <label className="field" style={{ marginTop: 10 }}><span>{t.profile.serverUrl}</span>
            <input className="input" id="server-url" value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://192.168.1.10:8787" />
          </label>
        </details>
      )}
      {err && <p className="err">{err}</p>}
      <button className="btn primary" type="submit">{submitLabel}</button>
    </form>
  );
}
