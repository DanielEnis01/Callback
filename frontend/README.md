# Frontend

React + Vite + Tailwind, wrapped in Electron so the app can run as a
desktop window with real webcam access. This started as a Figma Make
static mock — the UI/flow (`App` → `Login` → `Dashboard` →
`CalibrationSession` / `SessionMeeting`) is unchanged; the "Camera
preview" placeholders in Calibration and the interview session now show
a real live feed from `getUserMedia` via `CameraFeed` / `useCamera`.

The "Live monitoring" panel in `SessionMeeting` is still mock data that
drifts randomly — real gaze/posture/filler-word signals from the
perception pipeline get wired in later.

## Run in the browser (no camera-permission dance, quick iteration)

First, create a local environment file and add a SmartSpectra API key:

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

## Resume uploads and interview preparation

Run `npm start` in `../backend` as well as this frontend. The backend reads
`BACKBOARD_API_KEY` from its own `.env`. The frontend uses
`VITE_API_BASE_URL` (default `http://localhost:3001`) to reach it in both browser
and Electron modes; Backboard credentials are never sent to the renderer.

Upload a PDF of up to 10 MB in **Settings → Resume** or the profile step before
calibration. The UI waits for Backboard to index the document and shows upload,
processing, retry, and removal states. The selected resume and assistant IDs are
remembered locally. Old profiles that saved only a filename must upload the file
once. Replacing a resume removes the old document after the new one is ready.

**Start session** opens the per-session resume, job-posting, and practice-focus
screen, then starts the Gemini/ElevenLabs voice conversation. The Backboard
`prepareInterview()` helper and session-start API remain available, but the
voice flow currently uses its own opening greeting and static recruiter prompt.
The login screen is still a mock, so context is per browser/device until real
accounts exist.

`src/backboard.ts` owns the API calls and saved upload state;
`src/ResumeUpload.tsx` is the shared uploader. See the
[backend API contract](../backend/docs/backboard.md) for the complete lifecycle.

Run `npm test` on Node 22.14+ for the mocked resume flow tests and `npm run build`
for the production bundle. No Backboard requests are made by the tests.
