# Backboard integration

Backboard is implemented as an ES module service in `src/services/backboard.js`,
backed by the supplied HTTP client in `src/integrations/backboard/backboardClient.js`.
It is mounted at `/api/backboard`. No SQL client, Tiger bridge, metric processing,
or other sponsor integration is included in this change.

## Setup

From `backend/`:

```sh
npm install
cp .env.example .env
# Set BACKBOARD_API_KEY in .env
npm start
```

Node 18+ is required for native fetch, FormData, and Blob. Backboard needs no new
npm dependencies. `GET /api/services` reports Backboard as `configured` when its
key is present; this is a configuration check, not an upstream health check.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BACKBOARD_API_KEY` | Required | Server-side Backboard authentication |
| `BACKBOARD_LLM_PROVIDER` | `google` | Model provider used through Backboard |
| `BACKBOARD_MODEL_NAME` | `gemini-2.5-flash` | Model used for preparation and completed-session feedback |
| `BACKBOARD_MIN_INTERVAL_MS` | `250` | Minimum interval between requests, including concurrent calls |
| `BACKBOARD_REQUEST_TIMEOUT_MS` | `60000` | Timeout for an upstream request |

Gemini is invoked through Backboard; this integration does not call the separate
Gemini service or read `GEMINI_API_KEY`. Select a model available in your Backboard
account. The provider/model fields follow the [Backboard message API](https://docs.backboard.io/api-reference/threads/send-message).

## Session lifecycle

1. **User setup:** call `createUserAssistant(userId)` once. The caller stores the
   returned `assistant_id` on its user record and reuses it for all future sessions.
   Creating an assistant is not an idempotent user lookup.
2. **Job setup:** call `setupJobPosting({ assistantId, pdfBuffer, filename })` once
   per job posting. It uploads the PDF and waits for indexing before returning.
   Keep the returned `document_id`; do not reupload it at each session boundary.
   The frontend's resume uploader separately calls `uploadResume`, saves the
   returned document ID, and polls until it is indexed. Resume content remains
   attached to that same assistant for future preparation and feedback.
3. **Before an interview:** call `startSession({ assistantId, trendSentence,
   practiceFocus })`. Another component supplies an optional plain-text trend
   sentence. Backboard combines it with retrieved memories, the indexed resume,
   and job context to generate an opening question. Optional `resumeDocumentId`,
   `candidateName`, `targetRoles`, and `jobPosting` fields carry the frontend's
   selected context. When supplied, the resume must be indexed before generation.
   A first session can omit the trend.
4. **While interviewing:** raw ASR, gaze/posture, and Presage signals stay with the
   live session's owner. This integration provides no live message or scoring
   endpoint and makes no background calls.
5. **After the interview:** the caller finishes processing the capture, then calls
   `afterSessionEnds({ assistantId, sessionId, transcriptText, summaryText })`.
   Backboard receives only the completed transcript and natural-language summary,
   with `memory: "Auto"`. The numeric write to Tiger Data is handled elsewhere and
   is independent of this call. No Tiger history is read or included here.

Next-session preparation uses `memory: "Readonly"`: past facts can inform the
opening question without extracting new facts from the trend sentence. Each
preparation/completion call starts a separate thread under the same assistant.
Backboard's [memory modes](https://docs.backboard.io/concepts/memory) control
extraction separately from retrieval; auto extraction may complete asynchronously.

The service returns Backboard's response, including `content`, `thread_id`, and
any `memory_operation_id`/retrieval information. Prompt instructions ask for
realistic questions without scores or coaching feedback before the interview ends.

## HTTP contract

All paths below are relative to `/api/backboard`. Send JSON except for the PDF.

| Method / path | Request | Result |
| --- | --- | --- |
| `POST /assistants` | `{ "userId": "user-1" }` | `201`, assistant including `assistant_id` |
| `POST /assistants/:assistantId/job-posting` | PDF bytes, `Content-Type: application/pdf` | `201`, indexed document |
| `POST /assistants/:assistantId/resumes?filename=resume.pdf` | PDF bytes, `Content-Type: application/pdf` | `202`, document ID and initial status |
| `GET /documents/:documentId/status` | No body | Document indexing status |
| `DELETE /documents/:documentId` | No body | `204`, removes an uploaded document; already deleted is also success |
| `POST /assistants/:assistantId/sessions/start` | Optional `trendSentence`, `practiceFocus`, `resumeDocumentId`, `candidateName`, `targetRoles`, `jobPosting` | Opening question and new thread |
| `POST /assistants/:assistantId/sessions/complete` | Required `sessionId`, `transcriptText`, `summaryText` | Completed-session feedback and memory extraction operation |
| `POST /assistants/:assistantId/memories/search` | Required `query`; optional `limit` (1–100, default 5) | Ranked memories; no generation |

```sh
curl -X POST http://localhost:3001/api/backboard/assistants/ASSISTANT_ID/sessions/complete \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"session-1","transcriptText":"Interviewer: Tell me about a conflict. Candidate: ...","summaryText":"Rambled on the conflict question and wants to practice structured answers."}'

curl -X POST http://localhost:3001/api/backboard/assistants/ASSISTANT_ID/sessions/start \
  -H 'Content-Type: application/json' \
  -d '{"trendSentence":"Filler-word count fell 20% over the previous five sessions.","practiceFocus":"behavioral questions"}'

curl -X POST http://localhost:3001/api/backboard/assistants/ASSISTANT_ID/job-posting \
  -H 'Content-Type: application/pdf' --data-binary @job-posting.pdf
```

JSON is limited to 2 MB and PDFs to 10 MB. Validation errors return `400`, missing
configuration returns `503`, upstream errors return `502`, and timeouts return
`504`. Writes are not automatically retried. A timed-out upload may already exist;
retain document IDs and use the client's `getDocumentStatus`/`waitForIndexed`
helpers when available instead of blindly uploading again.

The repository has no authentication/user persistence layer yet. Its owner must
persist user-to-assistant mappings and authorize assistant access when adding that
layer; the development routes currently accept the caller's assistant ID.

## Frontend resume flow

Calibration and Settings share `frontend/src/ResumeUpload.tsx`. The PDF bytes go
through the backend to Backboard as a document; the browser stores only IDs,
filename/size, a content fingerprint, and processing status. Its first upload
creates an anonymous assistant that is reused on that browser/device. Existing
profiles that contain only a filename need to select the PDF once to upload it.

Interrupted indexing can be retried from the saved document ID. Selecting the
same file again reuses its upload. Replacing a resume indexes the new PDF before
deleting the previous one, and preparation is blocked while replacement is
unfinished. Remove deletes the resume documents from Backboard and clears their
local references. These actions do not delete the assistant or its coaching memories.

The frontend sends the ready resume ID and saved profile to `sessions/start`
before mounting the live interview. The returned opening question appears in
the recruiter panel. No camera, ASR, or Presage data is included in this request.
The existing speech/voice and end-of-interview capture integrations are separate.

Run the backend with `npm start` from `backend/` alongside the frontend. Set
`VITE_API_BASE_URL` in `frontend/.env` if the backend is not at
`http://localhost:3001`; this works in browser and Electron builds. Never place
`BACKBOARD_API_KEY` in a `VITE_` variable.

## Verification and examples

```sh
npm test                       # Mocked API tests; no Backboard credits
npm run backboard:smoke         # Paid API lifecycle check with cleanup
npm run backboard:example       # Paid end-of-session / next-session example
# Optional one-time PDF setup in the example:
npm run backboard:example -- /path/to/job-posting.pdf
```

The smoke test verifies completed-session extraction, searchable memories, and
preparation of a new session. The example accepts a PDF to exercise document
indexing as well. Both create disposable assistants and delete only those
assistants afterward. They use fixed sample trend text, without a database.

Both paid scripts share `.backboard-real-api-lock.json` and a 30-minute cooldown.
`BACKBOARD_API_COOLDOWN_MS` changes the window; `BACKBOARD_API_FORCE=1` bypasses it.

The lower-level client also retains the supplied transcript upload, direct memory
write, and assistant cleanup helpers. They are opt-in utilities; the session
lifecycle relies on Backboard's automatic extraction rather than manual embeddings
or memory-selection logic.
