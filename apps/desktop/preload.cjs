const { contextBridge, ipcRenderer } = require("electron");

const config = ipcRenderer.sendSync("kvz:config");
contextBridge.exposeInMainWorld("kvz", {
  desktop: true,
  serverUrl: config.serverUrl,
  steamName: config.steamName,
  toggleFullscreen: () => ipcRenderer.send("kvz:fullscreen"),
});
