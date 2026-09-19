const { app, BrowserWindow, session, systemPreferences } = require("electron");
const path = require("node:path");

const isDev = !app.isPackaged;
const startUrl = process.env.ELECTRON_START_URL || "http://localhost:5173";

async function createWindow() {
  if (process.platform === "darwin") {
    // Camera feeds the local MediaPipe models; microphone feeds the local
    // conversation pipeline.
    const [cameraGranted, micGranted] = await Promise.all([
      systemPreferences.askForMediaAccess("camera"),
      systemPreferences.askForMediaAccess("microphone"),
    ]);
    if (!cameraGranted) console.warn("Camera access was denied in macOS Privacy settings.");
    if (!micGranted) console.warn("Microphone access was denied in macOS Privacy settings.");
  }

  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Firebase's signInWithPopup (Google sign-in) calls window.open() under
  // the hood. Electron denies every window.open() by default unless a
  // handler explicitly allows it, so without this the popup silently never
  // appeared and signInWithPopup would just hang or reject. Only Google's
  // own OAuth domains are allowed through; everything else stays denied.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = url.startsWith("https://accounts.google.com/") || url.includes("/__/auth/");
    if (!allowed) return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 500,
        height: 650,
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
      },
    };
  });

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
  // its camera permission prompt.
  // Allow media (camera), microphone, and speech recognition. The mic is
  // used both by getUserMedia (VAD/recording in useConversation.ts) and by
  // Chromium's internal speech-recognition permission surface -- both need
  // to be allowed or media capture throws "not-allowed" before anyone speaks.
  const ALLOWED_PERMISSIONS = new Set(["media", "microphone", "speech", "speechRecognition", "audioCapture"]);

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });

  // setPermissionCheckHandler is the synchronous gate checked *before* the
  // async request handler above -- without it Chromium can deny a
  // permission before the request callback even fires.
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return ALLOWED_PERMISSIONS.has(permission);
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
