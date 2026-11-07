import { useEffect, useState } from "react";
import { PEER_MODE, connect, loadProfile, send, useStore, type Profile } from "./net.ts";
import { ProfileForm } from "./profile.tsx";
import { Games } from "./screens/Games.tsx";
import { RoomScreen } from "./screens/Room.tsx";
import { SettingsPanel } from "./screens/Side.tsx";
import { Modal } from "./ui.tsx";
import { useT } from "./i18n.ts";
import { warmSounds } from "./sounds.ts";
import { pendingInvite, showRoomInUrl } from "./invite.ts";

export function App() {
  const inRoom = useStore((s) => !!s.room);
  const [profile, setProfile] = useState<Profile | null>(() => loadProfile());
  const [modal, setModal] = useState<"profile" | "settings" | null>(null);
  const t = useT();
  useEffect(() => { document.title = t.appName; }, [t]);
  useEffect(() => { const id = setTimeout(warmSounds, 3000); return () => clearTimeout(id); }, []);
  // The address bar shows the room's link while in it.
  const roomId = useStore((s) => s.room?.id);
  useEffect(() => { if (roomId || !pendingInvite()) showRoomInUrl(roomId); }, [roomId]);

  if (!profile) return <Welcome onDone={(p) => { setProfile(p); connect(); }} />;
  return (
    <div className="shell">
      {inRoom ? <RoomScreen onProfile={setProfile} /> : <Games onEditProfile={() => setModal("profile")} onSettings={() => setModal("settings")} />}
      {modal === "profile" && (
        <Modal title={t.account} onClose={() => setModal(null)}>
          <ProfileForm initial={profile} submitLabel={t.save} onDone={(p) => {
            setProfile(p);
            setModal(null);
            send({ t: "profile", name: p.name, avatar: p.avatar ?? null, gender: p.gender ?? null });
          }} />
        </Modal>
      )}
      {modal === "settings" && (
        <Modal title={t.settings} onClose={() => setModal(null)}>
          <SettingsPanel bare />
          <div className="foot"><button className="btn primary" onClick={() => setModal(null)}>{t.done}</button></div>
        </Modal>
      )}
      <Toast />
    </div>
  );
}

function Toast() {
  const toast = useStore((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || !visible) return null;
  return <div className={`toast ${toast.tone === "info" ? "info" : ""}`} role="status">{toast.text}</div>;
}

function Welcome({ onDone }: { onDone: (p: Profile) => void }) {
  const t = useT();
  return (
    <div className="welcome">
      <div className="panel">
        <div className="logo" style={{ fontSize: 24 }}><span className="mark" aria-hidden="true" />{t.appName}</div>
        <p className="dim" style={{ margin: 0 }}>{t.welcome.about}</p>
        <ProfileForm initial={{ name: window.kvz?.steamName ?? "" }} submitLabel={t.welcome.play} onDone={onDone} showServer={!PEER_MODE} />
      </div>
    </div>
  );
}
