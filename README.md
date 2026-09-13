# Callback — AI Interview Coach

**HackRice · Work & Productivity**

A desktop mock-interview coach. An AI recruiter interviews you by voice about
*your* résumé and *the* job you're applying for, watches how you carry yourself
while you answer, and scores 23 traits from what you actually said and did — then
remembers it, so the next interview knows where you were weak.

**Sponsor tracks:** ElevenLabs · Presage · Tiger Data · Backboard · Gemini API · Vultr · GoDaddy

---

## What it actually does

**1. Set up a session.** Upload a résumé (PDF) and paste the job posting.

**2. Get interviewed.** Gemini reads both and designs **four questions for you
specifically** — 1 behavioral, 2 grilling named projects on your résumé, 1 on a
requirement from the posting, asked in that order. The recruiter speaks through
ElevenLabs, listens, and asks a clarifying follow-up when an answer is too thin
to assess. It ends itself after the fourth question.

The résumé is passed to Gemini as the **raw PDF**, not extracted text — no
parsing step, no lossy intermediate.

**3. Get measured, while you talk.** Three signal sources run at once:

| Source | Measures |
|---|---|
| **Presage SmartSpectra** | pulse, stress, emotional signal from the camera |
| **MediaPipe Face Mesh** | gaze direction, blink rate, posture shifts, fidgeting |
| **Python analysis service** | STAR structure, filler words, hedging, repeated words, unfinished sentences, tangents, non-answers |

**4. Get results.** A per-question critique with a rating and a concrete fix,
strengths and weaknesses, and **23 traits scored 0–10** — from Verbal Clarity and
Eye Contact to Answer Structure, Quantifying Impact and Outcome Focus.

**5. Practise one weakness.** Click any trait → the next session is built to
attack it. The planner is told your current score and picks whatever question mix
best exercises that skill (four behavioral for Answer Structure; all résumé for
Action Detail), and the live monitor collapses to show only that trait's signal.
The recruiter never mentions it — the targeting is invisible, so the score still
means something.

**6. It remembers.** Every Q&A pair and session summary is embedded into
Backboard. Later sessions retrieve semantically similar past answers, so the
planner skips what you've mastered, deliberately re-asks what you fumbled (badged
*Revisiting* in the UI), and the analysis writes **progress notes** comparing how
you told the same story this time versus last.

---

## The data split — why two stores

This is the part worth understanding:

- **Tiger Data (Postgres + TimescaleDB)** owns the **numbers**. Traits, trends,
  composites, goals, biometric time series. It answers *"how has this changed."*
  Hypertables and continuous aggregates back the trend charts.
- **Backboard** owns the **language**. What you actually said, and what the coach
  told you about it. It answers *"what did he say last time someone asked about a
  team conflict"* — a similarity question SQL cannot serve.

Neither replaces the other. Retrieved memories are wrapped in a delimited block
with `<`/`>` escaped before reaching a prompt — it's the user's own past speech,
so it's treated as data, never instructions.

---

## Architecture

```
  Electron desktop app (React + Vite)
    │
    ├── MediaPipe Face Mesh ──┐  gaze / posture / blink      (in-renderer)
    ├── Presage SmartSpectra ─┤  pulse / stress / emotion    (native bridge)
    │                         │
    └── HTTPS ────────────────┴──►  Node / Express backend
                                      │
                ┌─────────────────────┼──────────────────────┐
                │                     │                      │
         Gemini API            Python analysis        ElevenLabs TTS
      plan · turns · analysis   (spawned child)         recruiter voice
                │                     │
                └──────────┬──────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
        Tiger Data                 Backboard
     numbers · trends          language · memory
```

Every integration degrades instead of failing. Gemini down → static analysis
still renders. Backboard down or unconfigured → interview runs exactly as it did
before memory existed. Python missing → biometric and AI halves still score. A
memory outage must never cost you your session.

Gemini calls walk a **model fallback chain** (`GEMINI_MODEL` →
`GEMINI_TURN_FALLBACKS` → `GEMINI_ANALYSIS_MODEL`) with per-model retry. Free-tier
quota is metered per model per day, so a model that's exhausted or overloaded is
stepped over rather than retried — and retired model names are pruned at boot so
a bad config is caught at startup, not three questions into an interview.

---

## Running it

You need **two processes**: the backend, and the Electron app.

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env      # then fill it in — see below
npm run dev               # http://127.0.0.1:3001
```

Ask a teammate for the Firebase service-account JSON and save it at
`backend/firebase-service-account.json`. It's auto-discovered and gitignored —
no paths to edit. (For hosting, paste its contents into
`FIREBASE_SERVICE_ACCOUNT_JSON` instead; no file needed.)

`.env` needs: `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `BACKBOARD_API_KEY`,
`FIREBASE_PROJECT_ID`, and the `TIGER_DATA_*` connection block. Leave
`BACKBOARD_API_KEY` blank to run without memory — every memory path no-ops
cleanly.

`python3` is optional but recommended: the backend spawns
`python/analysis_service.py` on boot for the speech analysis. Plain stdlib, no
pip install. Without it, transcript signals are skipped.

The schema in `backend/sql/tigerdata.sql` is idempotent and re-applied on every
boot, so there's no migration step.

### 2. Desktop app

```bash
cd frontend
npm install
cp .env.example .env      # VITE_FIREBASE_*, VITE_SMARTSPECTRA_API_KEY
npm run electron:dev
```

Electron (not a browser) is required — the Presage SDK runs natively in the main
process and is bridged to the renderer over a MessagePort. macOS will prompt for
camera and microphone on first launch; both are required.

### Checks

```bash
cd backend  && npm test              # 22 tests
cd frontend && npm test              # 17 tests
cd frontend && npm run build         # typecheck + production build
cd backend  && npm run gemini:check  # which Gemini models your key can reach
```

---

## Deploying

The backend is the only thing that needs hosting — Tiger Data and Backboard are
already remote. Two things to know before you try:

1. Packaged Electron loads `dist/index.html` over `file://`, so the page origin
   is `null`. Firebase's `signInWithPopup` rejects that, and so will CORS. Serve
   `dist/` from a local HTTP server inside Electron and `loadURL` it, then add
   that origin to Firebase's authorised domains and to `FRONTEND_ORIGIN`.
2. `VITE_*` values are **inlined at build time** and ship inside the app.
   Firebase web keys are public by design and fine; `VITE_SMARTSPECTRA_API_KEY`
   is a real vendor key and will be readable by anyone who downloads a build.

Backend secrets (`GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `BACKBOARD_API_KEY`,
`TIGER_DATA_PASSWORD`) are read at runtime from `backend/.env` and never enter
the Electron bundle.

---

## Layout

```
backend/
  src/
    routes/       services · analytics · data · documents · tts · stt
    services/     gemini · elevenlabs · backboard · analytics ·
                  sessionAnalysis · memoryRecords · pythonAnalysis · tigerdata
    integrations/backboard/   HTTP client (throttled, typed errors)
    middleware/auth.js        Firebase ID-token verification
  sql/            idempotent schema + continuous aggregates
frontend/
  src/            Dashboard · SessionMeeting · Results · Trends · Calibration
  electron/       main + preload (Presage native bridge, media permissions)
python/
  analysis_service.py         rule-based speech analysis (stdlib only)
```

---

## A note on the signals

Facial and vocal outputs are **engagement, focus and stress indicators for
coaching** — not diagnoses, not a lie detector, not a clinical measurement. A
signal with no recorded data is not shown rather than guessed at.
