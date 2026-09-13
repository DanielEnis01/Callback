# Frontend

React + Vite + Tailwind, wrapped in Electron so the app can run as a
desktop window with real webcam access. This started as a Figma Make
static mock — the UI/flow (`App` → `Login` → `Dashboard` →
`SessionSetup` / `SessionMeeting`) is unchanged; the "Camera
preview" placeholders in Calibration and the interview session now show
a real live feed from `getUserMedia` via `CameraFeed` / `useCamera`.

The "Live monitoring" panel in `SessionMeeting` uses live SmartSpectra and
MediaPipe signals. Speech transcription and the recruiter conversation are
also wired through the backend. Session history, scoring, and persistence are
still prototype data.

The interview uses an average-adult reference for comparison: approximately
70 bpm resting pulse, 15 breaths/min, and population HRV reference values.
There is no mandatory calibration step before an interview.

## Run in the browser (no camera-permission dance, quick iteration)

First, create a local environment file and add a SmartSpectra API key:

```
cp .env.example .env
```

Set `VITE_SMARTSPECTRA_API_KEY` in `.env`. The live interview monitor reads
this variable at runtime; no API keys are hardcoded in the source. `.env` is
intentionally ignored by Git, while `.env.example` is safe to commit as the
setup template.

Then run:

```
npm install
npm run dev
```

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
- `src/SessionSetup.tsx`, `src/SessionMeeting.tsx` — session setup and the
  interview screen with a camera panel
- `src/CameraFeed.tsx`, `src/useCamera.ts` — the live webcam feed
- `electron/main.cjs` — Electron main process; grants the camera
  permission request and opens the window (dev: loads the Vite server,
  prod: loads `dist/`)
- `electron/preload.cjs` — empty for now; session-tracking IPC goes
  here later
