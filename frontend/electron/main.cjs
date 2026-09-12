const { app, BrowserWindow, session, systemPreferences } = require("electron");
const { bindSmartSpectraIpc } = require("@smartspectra/node-sdk/main");
const path = require("node:path");

const isDev = !app.isPackaged;
const startUrl = process.env.ELECTRON_START_URL || "http://localhost:5173";

async function createWindow() {
  // SmartSpectra's native capture (used by usePresageSession) reads the
  // camera directly, outside Chromium's normal getUserMedia/permission
  // flow — it needs this explicit macOS TCC grant or it silently gets no
  // frames. Ported from TestCamera/main.js, where this same call is what
  // makes the SDK actually receive video.
  if (process.platform === "darwin") {
    const granted = await systemPreferences.askForMediaAccess("camera");
    if (!granted) {
      console.warn("Camera access was denied in macOS Privacy settings.");
    }
  }

  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron sandboxes preload scripts by default, which blocks plain
      // require() of a third-party npm package (only a small allowlist of
      // built-ins works sandboxed) — that's why preload.cjs's
      // require("@smartspectra/node-sdk/preload") was silently failing to
      // attach window.__smartspectraBridge. contextIsolation stays on, so
      // the renderer's web content is still isolated from Node/Electron —
      // this only widens what our own trusted preload script can do.
      sandbox: false,
    },
  });

  // Wires the renderer's `new SmartSpectraSDK(...)` (src/usePresageSession.ts)
  // to a real SDK instance here in the main process, over the MessagePort
  // preload.cjs's bridge sets up. Without this call, the renderer-side SDK
  // throws as soon as it's constructed.
  bindSmartSpectraIpc(win);

  if (isDev) {
    win.loadURL(startUrl);
    // Opt-in only — set OPEN_DEVTOOLS=1 when you actually need it instead
    // of it popping up on every launch. Manual shortcut works regardless:
    // Cmd+Option+I (macOS).
    if (process.env.OPEN_DEVTOOLS === "1") {
      win.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  // getUserMedia() requests from the renderer land here first — without an
  // explicit allow, Electron silently denies them before macOS even shows
  // its camera permission prompt. (SmartSpectra's own camera acquisition
  // is covered by askForMediaAccess above, not this — this is for
  // CalibrationSession's plain getUserMedia camera.)
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === "media") return callback(true);
    callback(false);
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
