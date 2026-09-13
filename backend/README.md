# Tiger Data storage and retrieval

This backend stores **the complete, unchanged original PDF in Tiger Data** as
PostgreSQL `BYTEA`. `resumes.document_id` and `job_postings.document_id` point to
that row. There is no Backboard integration or external file-storage dependency.
Metadata includes the original filename, MIME type, size, owner, upload time,
and SHA-256. Downloads return those original bytes with `application/pdf` and an
attachment filename. Saving a file does not extract its text, run OCR, or identify
resume fields. Those features can be mapped after the additional TXT inventory arrives.

## Configure and run

Use Node 22.12+ (see the root `.nvmrc`). From the project root:

```sh
npm ci
npm ci --prefix backend
cp .env.example .env.local
cp backend/.env.example backend/.env
```

Fill in frontend Firebase settings in `.env.local`. In `backend/.env`, set:

- `TIGER_DATA_HOST`, `TIGER_DATA_PORT`, `TIGER_DATA_USER`,
  `TIGER_DATA_PASSWORD`, and `TIGER_DATA_DATABASE` from your Tiger Data service.
- `FIREBASE_PROJECT_ID` to the same project as the frontend.
- `GOOGLE_APPLICATION_CREDENTIALS` to the absolute path of your server-only
  Firebase service-account JSON, stored outside this repository. Application
  Default Credentials also work. Never put this JSON or database credentials in
  a `VITE_*` variable or commit them to source control.
- Optional `TIGER_DATA_CA_FILE` for your service's CA certificate. TLS certificate
  verification is enabled by default. If the hosted certificate chain cannot be
  validated locally, set `TIGER_DATA_SSL_REJECT_UNAUTHORIZED=false`; traffic is
  still encrypted. `TIGER_DATA_SSL=false` is for local PostgreSQL only.
- `TIGER_DATA_TIMESCALE=true` for Tiger Data. Use `false` only for a local plain
  PostgreSQL instance; its metrics table will then be an ordinary table.
- Optional `MAX_PDF_SIZE_BYTES` (default 10485760), `PORT` (default 3001), and
  `FRONTEND_ORIGIN` (comma-separated browser origins).

In separate terminals from the project root:

```sh
npm start --prefix backend
```

```sh
npm run dev
```

Open http://127.0.0.1:8444, sign in, and choose **Documents**. Select Resume,
Job posting, or Other PDF, then **Save PDF**. **Download PDF** retrieves the
original file and verifies its hash in the browser. Non-ASCII filenames are
preserved. The API listens on loopback for local development. For hosting, put
it behind an HTTPS reverse proxy and configure the frontend API origin or a
same-origin `/api` proxy. Vite's development proxy is not part of the build.

Startup applies `sql/tigerdata.sql` and `sql/timescale.sql` in a transaction.
TimescaleDB must already be enabled on the Tiger Data service. Startup fails if
hypertable creation fails; it does not silently omit it. `npm run db:init
--prefix backend` initializes the schema without starting HTTP. The migration
is repeatable and preserves the ZIP's existing users and PDFs; back up a live
database before any migration. Existing invalid rows cause validation to fail
without committing partial changes.

## PDF HTTP API

All `/api` routes require `Authorization: Bearer <Firebase ID token>`.
The server verifies the token (including revocation) and derives ownership from
its UID. Caller-provided `x-user-id` and `userId` values cannot grant access.

| Method and path | Input / output |
| --- | --- |
| `POST /api/documents/pdfs` | Raw PDF bytes, `Content-Type: application/pdf`, URL-encoded `X-Filename`; returns metadata and `document_id` |
| `GET /api/documents/pdfs?limit=50&offset=0` | Current user's metadata; max 100 rows per page |
| `GET /api/documents/pdfs/:documentId` | Original PDF attachment, with `X-Content-SHA256` |
| `GET /health` | Database connectivity; HTTP 503 if unavailable |

Upload headers: optional `X-Document-Kind` (`document`, `resume`, `job_posting`).
For job postings, `X-Job-Title` and `X-Company` are optional URL-encoded text.
Use JavaScript `encodeURIComponent(filename)` for `X-Filename`. The request
body is the file itself, not multipart form data or JSON/base64. Files must be
readable, unencrypted PDFs with at least one page. A parser checks structure;
it is not a malware scanner. Files are served as attachments, never executed.
Each upload creates a new record, even if its bytes duplicate a previous file.

Example using a short-lived ID token stored in the shell variable `ID_TOKEN`:

```sh
curl --fail-with-body http://127.0.0.1:3001/api/documents/pdfs \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H 'Content-Type: application/pdf' \
  -H 'X-Filename: resume.pdf' \
  -H 'X-Document-Kind: resume' \
  --data-binary '@/absolute/path/to/resume.pdf'

curl --fail-with-body http://127.0.0.1:3001/api/documents/pdfs/DOCUMENT_ID \
  -H "Authorization: Bearer $ID_TOKEN" \
  --output '/absolute/path/to/downloaded.pdf'

cmp '/absolute/path/to/resume.pdf' '/absolute/path/to/downloaded.pdf'
```

`cmp` produces no output when the files match. Retain the returned document ID
or list your files to find it. Missing/inaccessible files return HTTP 404;
invalid input returns 400, unsupported content types 415, and oversized files 413.
Database errors do not expose credentials or SQL to the client.

## Structured data API

| Path under `/api/data` | Operations |
| --- | --- |
| `/profile` | GET: verified user details and calculated `total_session_count` |
| `/resumes` | GET: resume metadata and PDF document IDs (created during PDF upload) |
| `/job-postings` | GET: posting metadata and PDF document IDs (created during PDF upload) |
| `/baselines` | POST JSON / GET: versioned baselines |
| `/sessions` | POST JSON / GET: interview or focus sessions |
| `/sessions/:sessionId` | PATCH JSON `{ "ended_at": "...ISO timestamp..." }`; duration calculated by the database |
| `/session-metrics` | POST JSON / GET: session signal values; GET accepts `sessionId` |

Lists accept `limit` and `offset`. These JSON records can be consumed by another
application using the same Firebase token. POST returns the saved record and
its generated ID. Ownership and timestamps default server-side. Unknown or
read-only fields are rejected. Reference IDs must belong to the current user;
this is also enforced by composite database foreign keys. One metrics row is
allowed per `(session_id, recorded_at)`; duplicates return HTTP 409. Measurements
can be omitted or null when unavailable. No missing measurement is replaced by 0.

Example payloads (set `Content-Type: application/json`):

```json
{"session_type":"interview","started_at":"2026-09-12T15:00:00Z"}
```

```json
{"session_id":"UUID_FROM_SESSION_RESPONSE","recorded_at":"2026-09-12T15:01:00Z","pulse_rate":72,"filler_word_count":3,"overall_session_score":8,"emotion_breakdown":{"happy":0.7,"neutral":0.3}}
```

The schema contains all signals from the supplied inventory. Session count is
computed in `user_summary`; duration is generated from start/end timestamps.
The schema constrains one active job posting per user, but this version does not
include an active-posting editing UI/API. Rolling averages, baseline deltas,
weakness rankings, OCR, and automated signal collection are not implemented;
the TXT inventory and scoring rules will determine the next mapping. Exact
last-5/10-session windows are not equivalent to time-bucket continuous aggregates.

## Verification

```sh
npm test --prefix backend
npm test
npm run build
```

Backend integration tests run the actual SQL and HTTP handlers against on-disk
PGlite (embedded PostgreSQL). They verify migrations, binary round trips,
restart persistence, owner isolation, malformed/oversized rejection, related
record rollback, structured data retrieval, and hash mismatch handling.
Only Firebase token verification is stubbed; SQL is not mocked. PGlite does not
load TimescaleDB. A live Tiger Data/Firebase test is still required to verify
service credentials, TLS, token revocation checks, and hypertable creation.

With your real Tiger Data configuration, this script stores a test PDF under
`local-pdf-test-user` and compares the retrieved bytes:

```sh
npm run test:pdf --prefix backend -- '/absolute/path/to/your.pdf'
```

It writes a persistent test record to the configured database. The direct-DB
script does not test Firebase/HTTP; use the signed-in Documents screen for that.

Implementation references: [Firebase server ID-token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens),
[PDF parser API](https://pdf-lib.js.org/docs/api/classes/pdfdocument), and
[Tiger Data hypertable creation](https://github.com/timescale/Tiger-Data-Docs/blob/main/src/content/docs/learn/hypertables/creating-and-configuring-hypertables.mdx).
