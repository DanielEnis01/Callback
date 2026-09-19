# Frontend

React + Vite + Tailwind, wrapped in Electron so the app can run as a
desktop window with real webcam access. This started as a Figma Make
static mock — the UI/flow (`App` → `Login` → `Dashboard` →
`CalibrationSession` / `SessionMeeting`) is unchanged; the "Camera
preview" placeholders in Calibration and the interview session now show
a real live feed from `getUserMedia` via `CameraFeed` / `useCamera`.

Calibration baselines, original resume PDFs, interview-profile context, and
measured session readings can be saved through the authenticated Tiger Data API.
Each session is created before samples are written; sample writes carry stable
IDs and timestamps, so a retry after a connection loss does not duplicate data.
The gaze, posture, and nervousness-proxy signals come from MediaPipe models
bundled with the app and run entirely on the user's machine. No camera frames
are sent to a vision API.

The current build opens directly to the dashboard. Firebase sign-in components
remain in `src/` but are intentionally not mounted until account setup resumes.

## Run in the browser (no camera-permission dance, quick iteration)

First, create a local environment file:

```
cp .env.example .env
```

No key is needed for vision inference. `.env` is intentionally ignored by Git,
while `.env.example` is safe to commit as the setup template.

Then run:

```
npm install
npm run dev
```

Start the API in a second terminal after following [the backend setup](../backend/README.md):

```
cd ../backend
npm install
npm start
```

Use `VITE_API_BASE_URL` when the API is not running at
`http://127.0.0.1:3001`. Browser development requests can also use the Vite
proxy at `/api`.

## Run as the Electron desktop app (camera in the designated panel)

```
npm install
npm run electron:dev
```

This project requires Node 20.19+ or Node 22. The macOS Electron command
selects Homebrew's `node@22` automatically when it is installed.

This starts the Vite dev server and an Electron window pointed at it.
On first run, macOS will prompt for camera access — allow it and the
live feed appears in the Calibration screen and the interview session's
left panel.

## Structure

- `src/App.tsx` — routes between hero / login / dashboard
- `src/CalibrationSession.tsx`, `src/SessionMeeting.tsx` — the two
  screens with a camera panel
- `src/CameraFeed.tsx`, `src/useCamera.ts` — the live webcam feed
- `src/useMediaPipe.ts` — bundled local face/pose inference
- `src/nervousnessProxy.ts` — local 0–100 visible-behavior coaching proxy
- `electron/main.cjs` — Electron main process; grants the camera
  permission request and opens the window (dev: loads the Vite server,
  prod: loads `dist/`)
- `src/sessionRecorder.ts` — retry-safe session/sample persistence
- `src/dataApi.ts` — Firebase-token-authenticated Tiger Data requests
