# Tiger Data Schema — Full Inventory

Everything the app needs to store, split by what's relational (users, resumes, job postings, session metadata) versus time-series (the actual signal data per session).

---

## Relational tables

### `users`
- `user_id` (PK)
- `name`, `email`
- `account_created_at`
- `total_session_count`

### `resumes`
- `resume_id` (PK)
- `user_id` (FK)
- `filename`
- `uploaded_at`
- `backboard_document_id` — the actual resume content/parsing lives in Backboard; Tiger Data holds the pointer + metadata, not the file content itself

### `job_postings`
- `job_posting_id` (PK)
- `user_id` (FK)
- `title`, `company`
- `uploaded_at`
- `backboard_document_id` — same pattern: postable text/RAG content lives in Backboard, Tiger Data stores the reference and any structured fields worth querying on (title, company, date)
- `active` (boolean — which posting the user is currently practicing against)

### `baselines`
- `baseline_id` (PK)
- `user_id` (FK)
- `captured_at`
- One column per baseline-eligible signal:
  - `baseline_stress_index`
  - `baseline_pulse`
  - `baseline_breathing_rate`
  - `baseline_blink_rate`
  - `baseline_fidget_score`
  - `baseline_eda`
  - `baseline_arterial_pressure`
  - `baseline_breathing_amplitude`
  - `baseline_inhale_exhale_ratio`
- Recapture periodically if baselines should drift with the user over time, versioned by `captured_at`

### `sessions`
- `session_id` (PK)
- `user_id` (FK)
- `job_posting_id` (FK, nullable — only for Interview Mode)
- `session_type` (`interview` / `focus`)
- `targeted_weakness` (nullable — set if launched from "practice this")
- `started_at`, `ended_at`, `duration_seconds`

---

## Time-series (hypertable, one row per session — or finer time-window if needed)

### `session_metrics` (hypertable on `recorded_at`)
- `session_id` (FK)
- `user_id` (FK)
- `recorded_at`

**Speech**
- `filler_word_count`, `filler_word_rate`
- `speaking_rate_wpm`
- `pause_frequency`, `avg_pause_duration`
- `topic_relevance_score`

**Perception**
- `gaze_away_seconds`
- `posture_stability_score`

**Presage — vitals (already in use)**
- `dominant_emotion`, `emotion_breakdown` (jsonb: happy/neutral/surprise/sad/angry/fear/disgust/contempt)
- `stress_index_baevsky`, `rmssd`, `sdnn`, `mean_nn`
- `pulse_rate`
- `breathing_rate`
- `blink_rate`

**Presage — proposed additions**
- `apnea_event_count`
- `fidget_score_seat`, `fidget_score_knee`
- `eda_level`
- `arterial_pressure_relative`
- `breathing_upper_lower_ratio`
- `inhale_exhale_ratio`
- `respiratory_line_length`
- `breathing_amplitude`

**Computed**
- `consistency_confidence_score` (Module 2 composite)
- `overall_session_score` (1–10 final combiner output)

---

## Derived/aggregated (via Tiger Data continuous aggregates, not manually written)

- Rolling averages per signal per user (last 5 / 10 sessions)
- Delta-from-baseline per baselined signal
- Ranked weakness list (which signals are trending worse vs. improving) — computed as a continuous aggregate or on read for the dashboard, not stored as its own table
