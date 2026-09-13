# Callback semantic memory

Backboard remembers **what was said in prior interviews**. It receives one
`qa_pair` per answered planned question and one `session_note` per completed
session. Gemini receives the fresh job posting and raw resume PDF directly.
The previous document-upload, automatic transcript extraction, and Backboard
LLM-generation routes have been removed.

## Try it locally

Use Node.js 22 or newer. In separate terminals:

```sh
cd backend
npm install
npm run dev
```

```sh
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173/?dev=backboard** for the standalone memory lab,
or enter the dashboard through the existing demo login and click
**Backboard dev tools** at the lower left. No resume, camera, microphone,
API key, or completed voice session is needed to use the lab.

1. Keep **Mock — no API calls** selected; click **Check status**.
2. Click **Seed 3 past sessions**. This creates three synthetic sessions, each
   with five Q&A records and one note. Repeating the action reuses those sessions.
3. Click **Find weak answers** or **Inspect planner context** to see the evidence.
4. Click **Create next interview**. One question shows “You struggled with this
   one on … — let’s try again.” The other questions avoid successful prior ones.
5. Open **Edit transcript JSON** to change answers or add a clarifier. User turns
   must retain `questionIndex`; a response to a follow-up has `isClarifying: true`.
6. Click **Compare answers + save**. Inspect `analysis.progressNotes`, then open
   the dashboard's **Results** tab to see the comparisons below Skill Development.
7. Click **Preview exact memory payload** to inspect everything that would be
   sent to Backboard. Click **Retry sync / check idempotency** repeatedly: a synced
   session reports `already_synced` and creates no additional memories.
8. Switch to **Simulated Backboard outage**, create a session, and save answers.
   The analysis persists while sync reports `unavailable`. Switch back to Mock,
   refresh sessions, select the unsynced session, and retry.
9. Choose **Empty retrieval** to exercise no-history prompts, or **Use fresh test
   user** to verify a separate user's history is empty.

Mock, outage, and empty modes share `backend/.data/mock-sessions.json`.
Live mode uses a separate store. Mock search uses word overlap and mock coaching
is explicitly labeled; use Live to assess actual semantic retrieval and Gemini's
qualitative feedback. Diagnostic responses can be downloaded from the panel.

For an entirely terminal-based, free demonstration:

```sh
cd backend
npm run backboard:demo
npm test
```

The demo seeds history in memory, plans a repeat question, compares new answers,
and asserts idempotency and user isolation. It leaves no saved data.

## Live Backboard and Gemini

Copy `.env.example` to `.env` if you do not have one, then set:

| Variable | Purpose / default |
| --- | --- |
| `BACKBOARD_API_KEY` | Server-only Backboard key |
| `BACKBOARD_BASE_URL` | `https://app.backboard.io/api` |
| `BACKBOARD_REQUEST_TIMEOUT_MS` | `5000` per upstream request |
| `BACKBOARD_MIN_INTERVAL_MS` | `250` between request starts |
| `GEMINI_API_KEY` | Direct Gemini planning and analysis |
| `GEMINI_MODEL` | Existing project default: `gemini-3.6-flash`; select a model available to your account |
| `DATABASE_URL` | Postgres/Tiger Data connection; optional locally, required in production |
| `FIREBASE_PROJECT_ID` | Firebase project used to verify Bearer ID tokens |
| `CALLBACK_DATA_FILE` | Local live-mode state path; default `.data/sessions.json` |
| `CALLBACK_MOCK_DATA_FILE` | Mock state path; default `.data/mock-sessions.json` |
| `CALLBACK_DEV_TOOLS` | `npm run dev` sets `1`; always disabled in production |
| `HOST` | Defaults to `127.0.0.1`; set deliberately for deployment |

Select **Live Backboard + Gemini** in the panel. Live seeding uses real API
credits and synthetic interview language under that development user's own
assistant. API keys never enter frontend code or `VITE_` variables.

`npm run backboard:smoke` is a separate opt-in paid test of direct memory write,
search, and duplicate prevention. It creates a disposable assistant and cleans
up only that assistant. The existing 30-minute real-API cooldown is retained.
No paid API smoke test is run by `npm test` or `backboard:demo`.

## Storage and authentication

The spec referenced modules absent from this checkout. The added foundation
provides a single-process, atomic JSON file adapter for local work and a Postgres
adapter for deployment. Files contain interview language and are ignored by git.
Keep one local backend process per data file. With Postgres configured, run:

```sh
cd backend
npm run db:migrate
```

The migration creates `sessions`, `session_ai_analysis`, and
`callback_memory_users`, including `interview_plan` and `memory_synced_at`.
Postgres transactions and per-user advisory locks serialize state mutations.
User state tracks assistant ownership and each deterministic record's write receipt.
The existing Tiger Data metric/trend functions remain separate from memory.

Backend requests use verified `req.user.userId`: the Firebase Admin SDK validates
`Authorization: Bearer <ID token>` against `FIREBASE_PROJECT_ID`. Development
headers are accepted only when explicitly enabled and never in production. Body
`userId` and client assistant IDs cannot select another user's memory namespace.

**The existing login screen is still a demo login.** When connecting the real
Firebase frontend login, call `setAuthTokenProvider` from `frontend/src/backboard.ts`
with a token getter and current UID (and null UID on sign-out). Production
requests without a verified token fail with 401. Do not use a browser-generated
development identity as an authentication mechanism.

Previously uploaded Backboard resume documents are not migrated or deleted.
Select the PDF once again to keep a local copy in IndexedDB. Session-specific
PDF selections override that copy only for the current interview. PDFs are
sent to Gemini with each new plan and are never saved in Backboard or session rows.

## Lifecycle and payloads

- Create the session, then generate and persist its five-question plan before
  starting the voice loop. Saved plans are reused on retry.
- Each recruiter turn returns `askedQuestionIndex` and `isClarifying`; the user's
  response retains the index and clarifier state of the question they answered.
  Turns are saved before voice synthesis, so a TTS failure retains the text.
- Completed transcripts are saved before generation. Gemini failures preserve
  static analysis. Answers with the same explicit index are concatenated;
  no paraphrase or fuzzy matching is used.
- `qa_pair.content` is exactly `Q: <question>\nA: <answer>`. Metadata includes
  provenance, role, focus, clarifier count, scores, session type, targeted weakness,
  and at most 500 characters of the job posting.
- `session_note.content` contains summary, strengths, and weaknesses. Metadata
  carries the session snapshot, including available trait scores.
- Missing plans, fewer than two answered questions, and missing analyses are
  skipped. Stable external IDs are `<sessionId>:<questionIndex>` and
  `<sessionId>:note`. `memory_synced_at` is stamped only after all records finish.
- Planner retrieval fetches up to ten prior Q&A pairs (reserving a weak candidate
  when found) and the latest three notes. It reuses one weak question with verified
  `repeatOf` provenance, avoids exact prior questions, and instructs Gemini to avoid
  semantic repeats of successful answers.
- Analysis searches up to two prior Q&A pairs for each current answer and excludes
  the current session. Generated progress notes are accepted only when their
  question index and prior session match supplied retrieval evidence.
- Reads have a 2.5-second application budget. Sync gets 1.5 seconds before the
  response reports `pending`; the bounded upstream work continues in the process.
  Interrupted syncs can be retried from saved state; no background worker is required.

No camera, biometric, `session_metrics`, resume, profile name/email, full job
posting, or numeric trend series is included in memory payloads. Answer text is
verbatim candidate language; this is not a general-purpose PII redaction system.
Retrieved data is JSON-encoded in a delimited prompt section and explicitly
identified as untrusted evidence in Gemini's system instructions.

## Scoring boundary

This checkout did not have the spec's static analyzer or 22-trait scoring model.
The new static analyzer computes word count, STAR component heuristics, quantified
outcomes, filler count, and vocabulary richness, and labels its method
`text_heuristics`. Grouped answers are scored together (`answerUnit: question`).
The record builder also supports imported turn-ordered signals by answer ordinal.
It carries the specified supported score fields when present and numeric trait
snapshots when supplied; it does not fabricate a composite or 22 trait scores.
Those fields are currently `null` / `{}` until a real scoring source is integrated.
Optional live-turn note injection (Query C) is not enabled; history is used in
planning and post-session analysis without additional Backboard calls per turn.

## HTTP tools

Use `X-Callback-Dev-User: dev-demo` and `X-Callback-Memory-Mode: mock` locally,
or a verified Firebase Bearer token outside development.

| Method / path | Input / result |
| --- | --- |
| `POST /api/services/sessions` | Optional `jobPostingText`, `positionLabel`, `sessionType`, `targetedWeakness`; returns session UUID |
| `POST /api/services/gemini/interview-plan` | `sessionId`, optional base64 `resumePdf`; returns persisted `questions`, source, memory diagnostics |
| `PATCH /api/services/sessions/:id/plan` | `questions`; fills a missing plan only |
| `POST /api/services/gemini/interview-turn` | `sessionId`, `message`, `history`, optional `speak:false`; returns text, indexes, clarifier flags, audio, done |
| `POST /api/services/analysis/transcript` | `sessionId`, `transcript`; returns saved session analysis and sync status |
| `GET /api/backboard/status` | Mode, configuration, persistence, owned assistant, write receipts |
| `GET /api/backboard/sessions` | Current user's saved sessions |
| `GET /api/backboard/sessions/:id/preview` | Exact memory content and metadata; no upstream writes |
| `POST /api/backboard/sessions/:id/sync` | Retry from persisted evidence |
| `POST /api/backboard/memories/search` | `query`, optional `kind`, `limit`, `weakOnly`, `excludeSessionId` |
| `POST /api/backboard/dev/seed` | Three reusable synthetic history sessions |
| `POST /api/backboard/dev/planner-context` | `query`; raw retrieval plus delimited prompt data |

## Backboard API findings and retry limits

Verified against the public [memory concepts](https://docs.backboard.io/concepts/memory),
[add](https://docs.backboard.io/api-reference/memories/add),
[list](https://docs.backboard.io/api-reference/memories/list), and
[update](https://docs.backboard.io/api-reference/memories/update) documentation.

The API scopes memory to an assistant and accepts `{content, metadata}` for direct
writes. Its published search contract is `{query, limit}`. No external-ID upsert
or metadata predicate contract was verified, so this implementation does not invent
one. The live API enforces a maximum search limit of 50. The application
over-fetches up to 50 tenant-owned search candidates and applies kind,
weakness, and current-session filters locally. This can reduce recall when relevant
records fall beyond those candidates. Recent notes are selected by timestamp from
paginated lists (up to 10,000 records), independently of semantic rank.

The application persists a pending receipt **before** POST and a memory ID after
success. A definite HTTP rejection can be retried. A transport timeout, malformed
success response, or ambiguous server error must first be reconciled by listing
memories with the deterministic external ID. If no matching record is visible,
status remains `pending_reconciliation`; it does not silently create another copy.
An unresolved receipt needs upstream investigation before resetting it. This
conservative behavior avoids claiming exactly-once delivery from a POST-only API.
Embedding model/dimensions and account rate quotas are provider-managed and were
not verified; the application does not generate its own vectors.

Local/mock behavior and API contracts are tested. A real Postgres migration and
live Backboard/Gemini behavior still require verification against your configured
accounts. The test scripts provide those entry points without making paid calls
as part of the default suite.
