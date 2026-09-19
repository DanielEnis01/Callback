const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// --- Diagnostics -------------------------------------------------------
// Previously, if SmartSpectra's native module failed to load, the only
// symptom was a bare uncaught-exception crash dialog with zero information
// about why. This log file captures exactly what we tried and what Windows
// told us, so the next report actually contains something to act on
// instead of another guess.
const DEBUG_LOG_PATH = path.join(os.tmpdir(), "callback-smartspectra-debug.log");
function debugLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, stamped + "\n");
  } catch {
    // best effort only -- logging itself must never take the app down
  }
}
try {
  fs.writeFileSync(DEBUG_LOG_PATH, "");
} catch {
  // ignore -- if we can't even create the log, debugLog's appendFileSync
  // calls below will just silently no-op
}

debugLog(
  `Callback starting -- platform=${process.platform} arch=${process.arch} ` +
    `electron=${process.versions.electron} node=${process.versions.node} ` +
    `execPath=${process.execPath}`
);

// Windows does NOT search the directory of a DLL that's being dynamically
// loaded via koffi.load() as part of its classic/default LoadLibrary search
// order -- only the app's own exe directory, System32, and (dead last) PATH.
// So the very first attempt to load smartspectra_capi.dll can fail to
// resolve its sibling dependencies (MSVCP140.dll, opencv_world4100.dll,
// smartspectra.dll, ...) even though every one of those files is physically
// sitting right next to it, unpacked from the asar.
//
// Two independent fixes are applied here, in the order Windows actually
// consults them:
//   1. SetDllDirectoryW(nativeDir) -- a real Win32 API call (made through
//      koffi, which is already a dependency) that inserts nativeDir into
//      the *process-wide* DLL search order at position 2, right after the
//      app's own directory and before System32. This is the mechanism
//      Microsoft documents for exactly this situation -- a DLL with private
//      dependencies living next to it -- and it's consulted far earlier
//      than PATH.
//   2. Prepending nativeDir to PATH, kept as a second, redundant safety net
//      in case SetDllDirectoryW can't be reached for some reason.
// A previous build shipped only fix #2 alone and the crash persisted, so
// this build adds #1 and, either way, logs exactly what happened instead of
// guessing a third time blind.
let nativeDir = null;
if (process.platform === "win32") {
  try {
    nativeDir = path.dirname(
      require.resolve("@smartspectra/node-sdk-win32-x64/package.json")
    );
    debugLog(`nativeDir resolved: ${nativeDir}`);
    debugLog(`nativeDir exists: ${fs.existsSync(nativeDir)}`);
    try {
      debugLog(`nativeDir contents: ${fs.readdirSync(nativeDir).join(", ")}`);
    } catch (e) {
      debugLog(`could not list nativeDir: ${e && e.message}`);
    }

    process.env.PATH = `${nativeDir};${process.env.PATH || ""}`;
    debugLog(
      `PATH prepended. New PATH (first 400 chars): ${(process.env.PATH || "").slice(0, 400)}`
    );

    try {
      const koffi = require("koffi");
      const kernel32 = koffi.load("kernel32.dll");
      const SetDllDirectoryW = kernel32.func("__stdcall", "SetDllDirectoryW", "bool", ["str16"]);
      const ok = SetDllDirectoryW(nativeDir);
      debugLog(`SetDllDirectoryW("${nativeDir}") returned ${ok}`);
    } catch (e) {
      debugLog(`SetDllDirectoryW attempt failed: ${(e && e.stack) || e}`);
    }
  } catch (err) {
    debugLog(`FAILED to resolve/prepare nativeDir: ${(err && err.stack) || err}`);
  }
}

const { app, BrowserWindow, session, systemPreferences, dialog } = require("electron");

let bindSmartSpectraIpc = null;
try {
  debugLog("requiring @smartspectra/node-sdk/main ...");
  ({ bindSmartSpectraIpc } = require("@smartspectra/node-sdk/main"));
  debugLog("SmartSpectra SDK loaded OK");
} catch (err) {
  debugLog(`SmartSpectra SDK FAILED to load: ${(err && err.stack) || err}`);
}

const isDev = !app.isPackaged;
const startUrl = process.env.ELECTRON_START_URL || "http://localhost:5173";

async function createWindow() {
  // SmartSpectra's native capture (used by usePresageSession) reads the
  // camera directly, outside Chromium's normal getUserMedia/permission
  // flow — it needs this explicit macOS TCC grant or it silently gets no
  // frames. Ported from TestCamera/main.js, where this same call is what
  // makes the SDK actually receive video.
  if (process.platform === "darwin") {
    // Ask for both camera and microphone -- camera for SmartSpectra/preview,
    // microphone for the voice conversation loop (useConversation.ts).
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
  if (bindSmartSpectraIpc) {
    bindSmartSpectraIpc(win);
  } else {
    debugLog("Skipping bindSmartSpectraIpc -- SDK never loaded, see errors above.");
    dialog.showErrorBox(
      "Callback — vitals module failed to load",
      "Callback started, but the vitals-measurement component didn't load " +
        "correctly, so that feature won't work in this session.\n\n" +
        `Details were written to:\n${DEBUG_LOG_PATH}\n\n` +
        "Please send that file over so this can get fixed."
    );
  }

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
  // its camera permission prompt. (SmartSpectra's own camera acquisition
  // is covered by askForMediaAccess above, not this — this is for
  // CalibrationSession's plain getUserMedia camera.)
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
