// Installs window.__smartspectraBridge via contextBridge so the renderer's
// `SmartSpectraSDK` (see src/usePresageSession.ts) can talk to the real SDK
// instance running in the main process (see main.cjs's bindSmartSpectraIpc).
// Requires contextIsolation: true, which is already how this app's
// BrowserWindow is configured.
require("@smartspectra/node-sdk/preload");

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__callbackSmartSpectraDiagnostics", {
  onMessage(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, diagnostic) => callback(diagnostic);
    ipcRenderer.on("callback:smartspectra-diagnostic", listener);
    return () => ipcRenderer.removeListener("callback:smartspectra-diagnostic", listener);
  },
});
