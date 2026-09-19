const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

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

    // THE actual bug, finally found: every single DLL in nativeDir --
    // including trivial ones like VCRUNTIME140.dll with almost no
    // dependencies of its own -- failed to koffi.load() individually and
    // identically. That's not a missing-dependency problem, because a file
    // with no real dependencies can't have a missing dependency. It means
    // the PATH ITSELF isn't reachable by a real OS call.
    //
    // require.resolve() returns a path under "...\app.asar\node_modules\...".
    // Node's OWN fs functions (existsSync, readdirSync, readFileSync --
    // which is why the earlier diagnostics logged this directory as
    // existing, with all the right files listed) are patched by Electron
    // to transparently redirect asarUnpack'd files to the real, physical
    // "app.asar.unpacked" directory electron-builder actually writes them
    // to on disk. But koffi's native module calls the raw Win32
    // LoadLibraryW API directly, which is NOT patched and knows nothing
    // about asar -- app.asar is one opaque archive file as far as Windows
    // is concerned, so "...\app.asar\node_modules\..." doesn't exist as a
    // real directory at all, and EVERY load through it fails the same way,
    // which is exactly what the probe showed. This has nothing to do with
    // which DLLs are bundled -- every DLL-bundling round trip so far was
    // fixing a real but ultimately irrelevant gap, because nothing in that
    // directory was ever reachable by the native loader in the first place.
    if (nativeDir.includes(`${path.sep}app.asar${path.sep}`)) {
      const unpackedDir = nativeDir.replace(
        `${path.sep}app.asar${path.sep}`,
        `${path.sep}app.asar.unpacked${path.sep}`
      );
      debugLog(`nativeDir was inside app.asar (unreachable by native LoadLibrary calls) -- rewriting to the real on-disk unpacked path: ${unpackedDir}`);
      nativeDir = unpackedDir;
    }

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

    // The SDK's own ffi.js independently computes the native library path
    // itself (js/resolve-native.js, via its own require.resolve() call) --
    // so even with nativeDir corrected above for OUR SetDllDirectoryW/PATH
    // setup, the SDK's internal resolution would still recompute the same
    // broken app.asar-relative path on its own and fail identically.
    // resolve-native.js already has an override for exactly this situation
    // (its own top comment calls it "the sole dev/override escape hatch"):
    // SMARTSPECTRA_CAPI_PATH, a full path to the shared library that skips
    // its require.resolve()-based lookup entirely. Setting it here, to the
    // already-corrected on-disk path, means the SDK loads the real file
    // instead of independently rediscovering the same broken one.
    const capiPath = path.join(nativeDir, "smartspectra_capi.dll");
    process.env.SMARTSPECTRA_CAPI_PATH = capiPath;
    debugLog(
      `SMARTSPECTRA_CAPI_PATH set to ${capiPath} (exists: ${fs.existsSync(capiPath)}) ` +
      `to bypass the SDK's own require.resolve()-based lookup, which would ` +
      `otherwise recompute the same unreachable app.asar path independently.`
    );
  } catch (err) {
    debugLog(`FAILED to resolve/prepare nativeDir: ${(err && err.stack) || err}`);
  }
}

const { app, BrowserWindow, session, systemPreferences, dialog } = require("electron");

// Google actively blocks Google sign-in (the signInWithPopup flow in
// AuthContext.tsx) inside Electron's default User-Agent -- it contains an
// "Electron/x.y.z" token that Google's OAuth endpoint recognizes as an
// embedded webview and refuses with "Error 403: disallowed_useragent",
// regardless of the popup window's own webPreferences being otherwise
// correct. This has nothing to do with Firebase config or network
// connectivity; it's Google's own embedded-browser detection.
//
// The standard workaround (used across the Electron+Firebase ecosystem) is
// to present a normal desktop Chrome User-Agent instead. Built from
// process.versions.chrome so it always matches the REAL Chromium version
// this Electron build actually ships, rather than a UA string that goes
// stale the next time Electron is upgraded.
const PLATFORM_UA_TOKEN = {
  win32: "Windows NT 10.0; Win64; x64",
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  linux: "X11; Linux x86_64",
}[process.platform] || "Windows NT 10.0; Win64; x64";
app.userAgentFallback =
  `Mozilla/5.0 (${PLATFORM_UA_TOKEN}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${process.versions.chrome} Safari/537.36`;

let bindSmartSpectraIpc = null;
try {
  debugLog("requiring @smartspectra/node-sdk/main ...");
  ({ bindSmartSpectraIpc } = require("@smartspectra/node-sdk/main"));
  debugLog("SmartSpectra SDK loaded OK");
} catch (err) {
  debugLog(`SmartSpectra SDK FAILED to load: ${(err && err.stack) || err}`);

  // Two straight builds have bundled every dependency the shipped DLLs'
  // own PE import tables name, and it still fails with the same generic
  // "specified module could not be found" -- which Windows gives both for
  // "this file is missing" AND "one of THIS file's dependencies is
  // missing", with no indication which. Rather than guess a third
  // dependency to bundle, ask the loader that's actually failing
  // (koffi's LoadLibrary call) to try each DLL in nativeDir on its own.
  // Loading a DLL individually exercises the exact same OS dependency
  // resolution as the real failure, so whichever one throws here is the
  // actual broken link on this machine -- not a hypothesis, a direct
  // reproduction.
  if (process.platform === "win32" && nativeDir) {
    debugLog("Probing each DLL in nativeDir individually via koffi.load() " +
      "to find which one actually fails to load...");
    try {
      const koffiProbe = require("koffi");
      // Leaf-first order: load the things everything else depends on
      // before the things that depend on them, so a failure higher up
      // the chain doesn't get masked by an earlier one lower down.
      const probeOrder = [
        "VCRUNTIME140.dll", "VCRUNTIME140_1.dll", "VCRUNTIME140_THREADS.dll",
        "MSVCP140.dll", "MSVCP140_1.dll", "MSVCP140_2.dll",
        "MSVCP140_ATOMIC_WAIT.dll", "MSVCP140_CODECVT_IDS.dll",
        "CONCRT140.dll", "VCCORLIB140.dll",
        "ncrypt.dll", "mfplat.dll", "mf.dll", "mfreadwrite.dll",
        "vulkan-1.dll", "opencv_world4100.dll",
        "smartspectra.dll", "smartspectra_capi.dll",
      ];
      let allDlls;
      try {
        allDlls = fs.readdirSync(nativeDir).filter((f) => f.toLowerCase().endsWith(".dll"));
      } catch (e) {
        allDlls = [];
      }
      // Probe the known set in dependency order, then anything else found
      // in the directory that wasn't already covered above.
      const ordered = [
        ...probeOrder.filter((f) => allDlls.some((x) => x.toLowerCase() === f.toLowerCase())),
        ...allDlls.filter((f) => !probeOrder.some((p) => p.toLowerCase() === f.toLowerCase())),
      ];
      for (const dllName of ordered) {
        const dllPath = path.join(nativeDir, dllName);
        try {
          koffiProbe.load(dllPath);
          debugLog(`  PROBE OK:   ${dllName}`);
        } catch (probeErr) {
          debugLog(`  PROBE FAIL: ${dllName} -- ${(probeErr && probeErr.message) || probeErr}`);
        }
      }
    } catch (probeSetupErr) {
      debugLog(`Probe setup itself failed: ${(probeSetupErr && probeSetupErr.stack) || probeSetupErr}`);
    }
  }
}

const STATIC_MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

// Google's OAuth endpoint rejects signInWithPopup (AuthContext.tsx's
// signInGoogle) when it's launched from a file:// origin -- win.loadFile()
// gives the renderer window.location.origin === "null"/"file://", which
// can't match anything on Firebase's "authorized domains" allowlist, so
// the popup flow fails no matter what app.userAgentFallback is set to
// (that fix addresses a *different* block -- Google's embedded-webview UA
// sniffing -- and was necessary but not sufficient on its own). Serving
// the packaged build over plain HTTP from localhost instead sidesteps
// this: Firebase authorizes "localhost" by default for every project
// regardless of port, and http://localhost gives Chromium a real origin
// the same way any ordinary web app has one.
//
// This is a tiny static file server, not a dev server -- it just serves
// the already-built dist/ directory so the app has a real HTTP origin
// instead of file://. Bound to 127.0.0.1 only, never reachable from the
// LAN, on an OS-assigned ephemeral port.
let staticServer = null;
function startStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const requestPath = decodeURIComponent((req.url || "/").split("?")[0]);
        let filePath = path.join(rootDir, requestPath === "/" ? "index.html" : requestPath);
        // Guard against a request path escaping rootDir via "..".
        if (!filePath.startsWith(rootDir)) filePath = path.join(rootDir, "index.html");
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          // SPA-style fallback so an unrecognized path serves index.html
          // instead of 404ing (there's no client-side router today, but
          // this keeps the server correct if one's ever added).
          filePath = path.join(rootDir, "index.html");
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": STATIC_MIME_TYPES[ext] || "application/octet-stream" });
        fs.createReadStream(filePath).pipe(res);
      } catch (err) {
        res.writeHead(500);
        res.end(String((err && err.message) || err));
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
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
    const distDir = path.join(__dirname, "..", "dist");
    try {
      staticServer ??= await startStaticServer(distDir);
      const port = staticServer.address().port;
      win.loadURL(`http://localhost:${port}/index.html`);
    } catch (err) {
      debugLog(
        `Static server failed to start (${(err && err.message) || err}) -- ` +
        `falling back to file://. Google sign-in will not work under that ` +
        `origin, but the rest of the app still will.`
      );
      win.loadFile(path.join(distDir, "index.html"));
    }
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

  app.on("will-quit", () => {
    staticServer?.close();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
