// Installs window.__smartspectraBridge via contextBridge so the renderer's
// `SmartSpectraSDK` (see src/usePresageSession.ts) can talk to the real SDK
// instance running in the main process (see main.cjs's bindSmartSpectraIpc).
// Requires contextIsolation: true, which is already how this app's
// BrowserWindow is configured.
require("@smartspectra/node-sdk/preload");
