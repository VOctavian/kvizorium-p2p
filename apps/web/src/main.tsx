import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.tsx";
import { connect, loadProfile } from "./net.ts";
import { initPrefs } from "./prefs.ts";

initPrefs();

if (loadProfile()) connect();
createRoot(document.getElementById("root")!).render(<App />);
