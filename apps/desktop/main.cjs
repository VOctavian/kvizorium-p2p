// Desktop shell for Steam / PC: runs the game server in-process and opens the web client in a window.
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const smoke = process.argv.includes("--smoke");
process.on("uncaughtException", (e) => { console.error("[kvz] ошибка:", e); if (smoke) app.exit(1); });
process.on("unhandledRejection", (e) => { console.error("[kvz] ошибка:", e); if (smoke) app.exit(1); });
const res = (...p) => (app.isPackaged ? path.join(process.resourcesPath, ...p) : null);
const paths = {
  server: res("server", "index.cjs") ?? path.join(__dirname, "..", "server", "dist", "index.cjs"),
  web: res("web") ?? path.join(__dirname, "..", "web", "dist"),
  packs: res("packs") ?? path.join(__dirname, "..", "..", "packs"),
  appId: app.isPackaged ? path.join(path.dirname(process.execPath), "steam_appid.txt") : path.join(__dirname, "steam_appid.txt"),
};

/* ---- Steam (optional): install `steamworks.js` and put your App ID in steam_appid.txt ---- */
let steam = null;
let steamName;
try {
  const sw = require("steamworks.js");
  const appId = Number(process.env.STEAM_APP_ID || fs.readFileSync(paths.appId, "utf8").trim());
  steam = sw.init(appId);
  steamName = steam.localplayer.getName();
  sw.electronEnableSteamOverlay();
} catch (e) {
  console.log("[kvz] Steam не подключён:", e.code === "MODULE_NOT_FOUND" ? "нет модуля steamworks.js" : e.message);
}

let port = 0;

async function startGameServer() {
  const { startServer } = require(paths.server);
  const opts = { host: "0.0.0.0", staticDir: paths.web, packsDir: paths.packs, dataDir: path.join(app.getPath("userData"), "data") };
  try {
    return await startServer({ ...opts, port: Number(process.env.KVZ_PORT) || 8787 });
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    return startServer({ ...opts, port: 0 });
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#070b1f",
    autoHideMenuBar: true,
    title: "Квизориум",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => !smoke && win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.key === "F11") { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
  if (smoke) {
    win.webContents.once("did-finish-load", () => { console.log(`SMOKE OK port=${port}`); app.quit(); });
    win.webContents.once("did-fail-load", (_e, code, desc) => { console.log(`SMOKE FAIL ${code} ${desc}`); app.exit(1); });
  }
  win.loadURL(`http://localhost:${port}/`);
  return win;
}

ipcMain.on("kvz:config", (e) => { e.returnValue = { serverUrl: `http://localhost:${port}`, steamName }; });
ipcMain.on("kvz:fullscreen", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  win?.setFullScreen(!win.isFullScreen());
});

app.whenReady().then(async () => {
  if (smoke) console.log("[kvz] app ready, starting server from", paths.server);
  const server = await startGameServer();
  port = server.port;
  console.log(`[kvz] локальный сервер: http://localhost:${port} (друзья в сети подключаются по IP этого компьютера)`);
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  app.on("before-quit", () => server.close());
});

app.on("window-all-closed", () => app.quit());
