# Callback — Interview & Productivity Coach

**Event:** HackRice · **Track:** Work & Productivity
**Sponsor challenges targeted:** Best Use of ElevenLabs · Best Use of Presage · Best Use of Vultr · Best Use of Tiger Data · Best Use of Backboard · Best Use of Gemini API · Best Domain Name from GoDaddy Registry 

---

## Concept

One multi-agent pipeline, two front-end modes:

- **Interview Mode** — an AI "recruiter" persona (voiced by ElevenLabs) asks mock interview questions and gives feedback on filler words, gaze, posture, and pacing.
- **Focus Mode** — the same perception pipeline runs passively while studying: detects checked-out behavior (phone glances, slouching, scrolling posture), voice-nudges the user, and manages Pomodoro timing.

Same agents, same data backend, two prompts/UI skins — that's the unified-stack story for judges.

---

## Architecture

This isn't a single left-to-right pipeline — several agents talk directly to each other in addition to routing through the reasoning core:

- **Perception agent** (gaze, posture — MediaPipe) and **Speech agent** (filler words, pacing — local ASR) share timing data directly, since a posture shift and a filler word often happen in the same moment and are more informative combined.
- **Presage SDK** (real-time focus/stress signal) feeds both the reasoning core *and* the Feedback model directly — the raw signal is useful for scoring even before Gemini reasons over it.
- **Speech agent** also writes directly into the **Backend data layer**, bypassing Gemini — raw transcripts get logged regardless of what the model says about them.
- **Gemini API** is the reasoning hub: it receives from Perception, Speech, and Presage, and routes out to ElevenLabs (voice) and down to the Backend data layer (session logging).
- **Backend data layer** (Tiger Data + Backboard) and the **Feedback model** reference each other continuously — trend data informs the score, and new scores get logged as trend data.
- **Session dashboard** closes the loop by feeding prior-session context forward into the next session's Perception agent.

```
        Perception agent ──── shared timing ──── Speech agent
               │                                       │  │
               │                                       │  └──── raw transcript ────┐
               ▼                                       ▼                           ▼
                        Gemini API (reasoning core)                    Backend data layer
                         │                    │                        (Tiger Data + Backboard)
                         ▼                    ▼                              │      ▲
                  ElevenLabs voice     [also feeds down]◄────────────────────┘      │
                                                │                                    │
        Presage SDK ── raw signal ──────────────┼───────────────► Feedback model ───┘
               │                                                        │
               └──────────────────────► (also feeds Gemini) ────────────┘
                                                                          ▼
                                                                 Session dashboard
                                                                          │
                                                          (next session) │
                                                                          ▼
                                                                 Perception agent
```

---

## Project structure

```
Callback/
  frontend/     # placeholder — Interview/Focus Mode UI + dashboard (not built yet)
  backend/      # Node/Express backend
    src/
      services/ # one module per integration — gemini, elevenlabs, presage, tigerdata, backboard
      routes/
      index.js
  python/       # placeholder — Perception (MediaPipe) + Speech (ASR) agents (not built yet)
```

Backboard is implemented in `backend/src/services/backboard.js` and exposed at
`/api/backboard`. See [Backboard setup and lifecycle](backend/docs/backboard.md).
The other service modules remain skeletons with stubbed, throwing functions.

---

## Agents

| Agent | Role | Built with |
|---|---|---|
| Perception agent | Gaze, posture, blink-rate tracking from webcam | MediaPipe Face Mesh (local) |
| Speech agent | ASR + filler-word detection + pacing/pause analysis | Local ASR (Vosk/faster-whisper), librosa/parselmouth |
| Presage SDK | Real-time focus/stress/engagement signal from camera | Presage SDK |
| Gemini API | Reasoning core — drives the recruiter persona and generates contextual feedback | Gemini API |
| Backend data layer | Session metrics + long-term memory | Tiger Data (Postgres/Timescale) + Backboard |
| Feedback model | Combines signals into a session score | Trained scorer (XGBoost or small NN) on labeled sessions |
| ElevenLabs | Voices the recruiter persona and Focus Mode nudges | ElevenLabs TTS |
| Session dashboard | Displays trends across sessions | Frontend chart view on Tiger Data queries |

---

## Data layer — Tiger Data + Backboard

Both live in the same architecture but do different jobs, and neither replaces the other:

- **Tiger Data (Postgres/Timescale):** structured, numeric, time-ordered data — filler-word rate per session, gaze-away seconds, engagement/stress trend, Pomodoro session logs. Hypertables + continuous aggregates power the dashboard's trend charts.
- **Backboard:** long-term conversational memory and retrieval — past transcripts, coaching notes, "what went wrong last time on this type of question." Handles embeddings and persistence across sessions without a custom vector pipeline.

After a session ends, Backboard receives the completed transcript and summary for
automatic memory extraction, independently of numeric storage. At the start of
the next session, the backend supplies a plain-text trend sentence to Backboard,
which combines it with retrieved memories and job-posting context for Gemini.
The Backboard integration accepts that sentence from its caller; SQL and live
signal capture are outside its scope.

---

## Sponsor mapping

- **ElevenLabs** — live-voiced recruiter persona; Focus Mode nudges.
- **Presage** — real-time engagement/focus/stress score, used both by Gemini and directly by the Feedback model.
- **Vultr** — hosts the backend/agent orchestration; Cloud GPU tier for local ASR/CV inference if needed.
- **Tiger Data** — time-series habit tracking + continuous-aggregate dashboards.
- **Backboard** — long-term memory/RAG layer, replacing a custom pgvector build.

---

## MVP build order

Be ruthless about scope — build in this order:

1. **Perception agent** (MediaPipe gaze/posture) — get one thing working end to end.
2. **Presage integration** — one real-time metric streaming and logged.
3. **Speech agent** — local ASR + filler-word counting (simple counting is fine for the weekend; a trained disfluency classifier is a stretch goal, not a requirement).
4. **Tiger Data pipeline** — session metrics into a hypertable, one continuous aggregate, one dashboard chart.
5. **Gemini + ElevenLabs** — one working voiced Q&A loop.
6. **Backboard integration** — memory/retrieval layer, added once the core loop works.
7. **Focus Mode** — same pipeline, different prompt/UI; cheap to add once Interview Mode works, and extends track eligibility.

---

## Pitch framing notes

- Frame all facial/vocal outputs as engagement, focus, and stress *indicators* — not diagnoses, not lie detection. This matches how Presage itself frames its intended use cases and keeps the project in the Work & Productivity track rather than reading as medical.
- The most defensible "what did you build" answer for judges is the Perception + Speech agents and the Feedback model — those are built end to end in-house. Backboard and Presage are managed services doing real, necessary work, but they're not the differentiator to lead with if pushed on technical depth.
