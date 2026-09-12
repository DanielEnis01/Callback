# Frontend

React + Vite + Tailwind, wrapped in Electron so the app can run as a
desktop window with real webcam access. This started as a Figma Make
static mock — the UI/flow (`App` → `Login` → `Dashboard` →
`CalibrationSession` / `SessionMeeting`) is unchanged; the "Camera
preview" placeholders in Calibration and the interview session now show
a real live feed from `getUserMedia` via `CameraFeed` / `useCamera`.

Calibration baselines, original resume PDFs, interview-profile context, and
measured Presage readings are saved through the authenticated Tiger Data API.
Each session is created before samples are written; sample writes carry stable
IDs and timestamps, so a retry after a connection loss does not duplicate data.
Only values actually delivered by Presage are stored. Speech, gaze, and posture
fields stay absent until their respective pipelines produce real measurements.

## Run in the browser (no camera-permission dance, quick iteration)

First, create a local environment file and add a SmartSpectra API key and the
Firebase web configuration:

```
cp .env.example .env
```

Set `VITE_SMARTSPECTRA_API_KEY` in `.env`. Both calibration and the live
interview monitor read this variable at runtime; no API keys are hardcoded in
the source. `.env` is intentionally ignored by Git, while `.env.example` is
safe to commit as the setup template.

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

This starts the Vite dev server and an Electron window pointed at it.
On first run, macOS will prompt for camera access — allow it and the
live feed appears in the Calibration screen and the interview session's
left panel.

## Structure

- `src/App.tsx` — routes between hero / login / dashboard
- `src/CalibrationSession.tsx`, `src/SessionMeeting.tsx` — the two
  screens with a camera panel
- `src/CameraFeed.tsx`, `src/useCamera.ts` — the live webcam feed
- `electron/main.cjs` — Electron main process; grants the camera
  permission request and opens the window (dev: loads the Vite server,
  prod: loads `dist/`)
- `electron/preload.cjs` — empty for now; session-tracking IPC goes
  here later
- `src/sessionRecorder.ts` — retry-safe session/sample persistence
- `src/dataApi.ts` — Firebase-token-authenticated Tiger Data requests
