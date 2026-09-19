import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { initTigerData, createDocumentStore } from '../src/services/tigerdata.js';
import { maxPdfBytes } from '../src/config.js';
let engine, folder, app, original, saved;
const db = {
  async query(sql, values) {
    if (values) return engine.query(sql, values);
    const results = await engine.exec(sql);
    return results.at(-1) || { rows: [] };
  },
  async connect() { return { query: (...args) => db.query(...args), release() {} }; },
};
const auth = (call, who = 'alice') => call.set('Authorization', `Bearer ${who}`);
const upload = (bytes = original, filename = 'résumé.pdf', kind = 'resume') => auth(request(app).post('/api/documents/pdfs'))
  .set('Content-Type', 'application/pdf').set('X-Filename', encodeURIComponent(filename)).set('X-Document-Kind', kind).send(bytes);
const binary = (res, callback) => {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};
before(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'tigerdata-test-'));
  engine = new PGlite(folder);
  // Start from the schema shipped in the ZIP to exercise the upgrade path.
  await db.query(`CREATE TABLE users(user_id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    INSERT INTO users(user_id, created_at) VALUES ('legacy-user', '2024-01-01T00:00:00Z');
    CREATE TABLE pdf_documents(document_id UUID PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      filename TEXT NOT NULL CHECK(lower(filename) LIKE '%.pdf'), mime_type TEXT NOT NULL DEFAULT 'application/pdf' CHECK(mime_type = 'application/pdf'),
      file_size_bytes INTEGER NOT NULL CHECK(file_size_bytes > 0), sha256 CHAR(64) NOT NULL, pdf_data BYTEA NOT NULL, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await initTigerData(db, { timescale: false });
  await initTigerData(db, { timescale: false });
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Tiger Data original PDF round-trip verification');
  original = Buffer.from(await pdf.save());
  app = createApp({ db, verifyToken: async token => {
    if (!['alice', 'bob'].includes(token)) throw new Error('Invalid token');
    return { uid: token, email: `${token}@example.com`, name: token };
  } });
});
after(async () => { if (engine) await engine.close(); if (folder) await fs.rm(folder, { recursive: true, force: true }); });

test('migration preserves legacy account date and can be reapplied', async () => {
  const result = await db.query('SELECT account_created_at FROM users WHERE user_id = $1', ['legacy-user']);
  assert.equal(new Date(result.rows[0].account_created_at).toISOString(), '2024-01-01T00:00:00.000Z');
});
test('rejects missing/invalid sign-in and caller-supplied identity', async () => {
  await request(app).get('/api/documents/pdfs').set('x-user-id', 'alice').expect(401);
  await auth(request(app).get('/api/documents/pdfs'), 'invalid').expect(401);
});
test('uploads original PDF and creates an owner-linked resume atomically', async () => {
  const response = await upload().expect(201);
  saved = response.body;
  assert.equal(saved.filename, 'résumé.pdf');
  assert.equal(saved.sha256, crypto.createHash('sha256').update(original).digest('hex'));
  assert.equal(saved.file_size_bytes, original.length);
  assert.equal(saved.user_id, 'alice');
  assert.equal(saved.kind, 'resume');
  assert.equal(saved.pdf_data, undefined);
  const resumes = await auth(request(app).get('/api/data/resumes')).expect(200);
  assert.equal(resumes.body.records[0].document_id, saved.document_id);
});
test('lists metadata without exposing binary bytes and validates pagination', async () => {
  const response = await auth(request(app).get('/api/documents/pdfs')).expect(200);
  assert.equal(response.body.documents[0].document_id, saved.document_id);
  assert.equal(response.body.documents[0].kind, 'resume');
  assert.equal(response.body.documents[0].pdf_data, undefined);
  for (const query of ['limit=101', 'limit=0', 'offset=-1', 'limit[]=2']) await auth(request(app).get(`/api/documents/pdfs?${query}`)).expect(400);
});
test('downloads an identical PDF with PDF MIME type, original filename and integrity hash', async () => {
  const response = await auth(request(app).get(`/api/documents/pdfs/${saved.document_id}`)).buffer(true).parse(binary).expect(200);
  assert.deepEqual(response.body, original);
  assert.match(response.headers['content-type'], /^application\/pdf/);
  assert.match(response.headers['content-disposition'], /attachment/);
  assert.match(response.headers['content-disposition'], /filename\*=UTF-8''r%C3%A9sum%C3%A9.pdf/);
  assert.equal(response.headers['x-content-sha256'], saved.sha256);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal((await PDFDocument.load(response.body)).getPageCount(), 1);
});
test('isolates files even if a different owner is supplied in headers or queries', async () => {
  const response = await auth(request(app).get('/api/documents/pdfs?userId=alice').set('x-user-id', 'alice'), 'bob').expect(200);
  assert.deepEqual(response.body.documents, []);
  await auth(request(app).get(`/api/documents/pdfs/${saved.document_id}?userId=alice`).set('x-user-id', 'alice'), 'bob').expect(404);
  await auth(request(app).get('/api/documents/pdfs/not-a-uuid')).expect(400);
  await auth(request(app).get(`/api/documents/pdfs/${crypto.randomUUID()}`)).expect(404);
});
test('rejects non-PDF, malformed, empty, oversized, unsafe-name and unsupported uploads', async () => {
  await upload(Buffer.from('not a pdf')).expect(400);
  await upload(Buffer.from('%PDF-1.7\n%%EOF')).expect(400);
  await upload(Buffer.alloc(0)).expect(400);
  await upload(original, '../resume.pdf').expect(400);
  await upload(original, 'resume.txt').expect(400);
  await upload(original, 'resume.pdf', 'unknown').expect(400);
  await upload(Buffer.alloc(maxPdfBytes + 1)).expect(413);
  await auth(request(app).post('/api/documents/pdfs')).set('Content-Type', 'text/plain').send('x').expect(415);
  await auth(request(app).post('/api/documents/pdfs')).set('Content-Type', 'application/pdf').set('X-Filename', '%broken').send(original).expect(400);
  const response = await auth(request(app).get('/api/documents/pdfs')).expect(200);
  assert.equal(response.body.documents.length, 1);
});
test('job postings link to retrievable PDFs and retain structured fields', async () => {
  const response = await upload(original, 'job.pdf', 'job_posting').set('x-job-title', 'Engineer').set('x-company', 'Example').expect(201);
  const jobs = await auth(request(app).get('/api/data/job-postings')).expect(200);
  assert.equal(jobs.body.records[0].document_id, response.body.document_id);
  assert.equal(jobs.body.records[0].title, 'Engineer');
  assert.equal(jobs.body.records[0].company, 'Example');
  await assert.rejects(db.query('INSERT INTO resumes(user_id, document_id, filename) VALUES ($1, $2, $3)', ['legacy-user', response.body.document_id, 'stolen.pdf']), { code: '23503' });
});
test('deletes a PDF, cascading to its resume row, and enforces ownership', async () => {
  const response = await upload(original, 'to-delete.pdf').expect(201);
  const documentId = response.body.document_id;
  await auth(request(app).delete(`/api/documents/pdfs/${documentId}`), 'bob').expect(404);
  await auth(request(app).delete(`/api/documents/pdfs/${documentId}`)).expect(204);
  await auth(request(app).get(`/api/documents/pdfs/${documentId}`)).expect(404);
  const resumes = await auth(request(app).get('/api/data/resumes')).expect(200);
  assert.ok(!resumes.body.records.some(r => r.document_id === documentId));
  await auth(request(app).delete(`/api/documents/pdfs/${documentId}`)).expect(404);
  await auth(request(app).delete('/api/documents/pdfs/not-a-uuid')).expect(400);
});
test('persists and retrieves baselines, sessions, JSON metrics and computed session counts', async () => {
  const baseline = await auth(request(app).post('/api/data/baselines')).send({ baseline_pulse: 65, baseline_stress_index: 20 }).expect(201);
  assert.equal(baseline.body.baseline_pulse, 65);
  const baselineList = await auth(request(app).get('/api/data/baselines')).expect(200);
  assert.equal(baselineList.body.records[0].baseline_id, baseline.body.baseline_id);
  const session = await auth(request(app).post('/api/data/sessions')).send({ session_type: 'focus', started_at: '2026-09-12T12:00:00Z' }).expect(201);
  const id = session.body.session_id;
  const metric = { session_id: id, pulse_rate: 72, nervousness_score: 42, filler_word_count: 3, overall_session_score: 8, emotion_breakdown: { happy: 0.7, neutral: 0.3 } };
  await auth(request(app).post('/api/data/session-metrics')).send(metric).expect(201);
  const read = await auth(request(app).get(`/api/data/session-metrics?sessionId=${id}`)).expect(200);
  assert.equal(read.body.records[0].pulse_rate, 72);
  assert.equal(read.body.records[0].nervousness_score, 42);
  assert.deepEqual(read.body.records[0].emotion_breakdown, metric.emotion_breakdown);
  const ended = await auth(request(app).patch(`/api/data/sessions/${id}`)).send({ ended_at: '2026-09-12T12:05:00Z' }).expect(200);
  assert.equal(ended.body.duration_seconds, 300);
  const profile = await auth(request(app).get('/api/data/profile')).expect(200);
  assert.equal(Number(profile.body.total_session_count), 1);
  await auth(request(app).post('/api/data/session-metrics'), 'bob').send(metric).expect(400);
  await auth(request(app).patch(`/api/data/sessions/${id}`), 'bob').send({ ended_at: '2026-09-12T12:06:00Z' }).expect(404);
  const other = await auth(request(app).get('/api/data/session-metrics'), 'bob').expect(200);
  assert.deepEqual(other.body.records, []);
  await auth(request(app).post('/api/data/baselines')).send({ user_id: 'bob', baseline_pulse: 55 }).expect(400);
  await auth(request(app).post('/api/data/baselines')).send({ baseline_pulse: '65' }).expect(400);
  await auth(request(app).post('/api/data/session-metrics')).send({ ...metric, overall_session_score: 11 }).expect(400);
  await auth(request(app).post('/api/data/session-metrics')).send({ ...metric, nervousness_score: 101 }).expect(400);
});
test('saves and reads back an interview profile, including the calibration flow that omits jobPosting entirely', async () => {
  // CalibrationSession.tsx never sends a jobPosting key at all (it's set
  // per-session, not at calibration time) -- that omission must be treated
  // like null, not rejected as invalid.
  const saved = await auth(request(app).patch('/api/data/profile')).send({
    name: 'Daniel Enis', targetRoles: 'Software Engineer', resume: { name: 'resume.pdf', size: 1200 },
  }).expect(200);
  assert.equal(saved.body.name, 'Daniel Enis');
  const fetched = await auth(request(app).get('/api/data/interview-profile')).expect(200);
  assert.deepEqual(fetched.body, saved.body);
  await auth(request(app).patch('/api/data/profile')).send({
    name: 'Daniel Enis', targetRoles: 'Software Engineer', jobPosting: null, resume: { name: 'resume.pdf', size: 1200 },
  }).expect(200);
  await auth(request(app).patch('/api/data/profile')).send({ name: 'Daniel Enis' }).expect(400);
  await auth(request(app).patch('/api/data/profile')).send({
    name: 'Daniel Enis', targetRoles: 'Software Engineer', jobPosting: 5, resume: { name: 'resume.pdf', size: 1200 },
  }).expect(400);
});
test('analyzes a session against baseline and recent-session trend, stores the result, and lists it', async () => {
  await auth(request(app).post('/api/data/baselines')).send({ baseline_pulse: 60, baseline_stress_index: 20 }).expect(201);
  const first = await auth(request(app).post('/api/data/sessions')).send({ session_type: 'focus', started_at: '2026-09-12T13:00:00Z' }).expect(201);
  await auth(request(app).post('/api/data/session-metrics')).send({ session_id: first.body.session_id, recorded_at: '2026-09-12T13:00:10Z', pulse_rate: 90, stress_index_baevsky: 40, nervousness_score: 70 }).expect(201);
  const firstAnalysis = await auth(request(app).post(`/api/data/sessions/${first.body.session_id}/analyze`)).expect(200);
  assert.equal(firstAnalysis.body.signal_averages.pulse_rate, 90);
  assert.equal(firstAnalysis.body.signal_averages.nervousness_score, 70);
  assert.equal(firstAnalysis.body.baseline_deltas.pulse_rate.direction, 'worse');
  assert.ok(firstAnalysis.body.weaknesses.some(w => w.signal === 'pulse_rate'));
  assert.equal(firstAnalysis.body.overall_score, 0);

  const second = await auth(request(app).post('/api/data/sessions')).send({ session_type: 'focus', started_at: '2026-09-12T14:00:00Z' }).expect(201);
  await auth(request(app).post('/api/data/session-metrics')).send({ session_id: second.body.session_id, recorded_at: '2026-09-12T14:00:10Z', pulse_rate: 50, stress_index_baevsky: 18, nervousness_score: 25 }).expect(201);
  const secondAnalysis = await auth(request(app).post(`/api/data/sessions/${second.body.session_id}/analyze`)).expect(200);
  assert.equal(secondAnalysis.body.baseline_deltas.pulse_rate.direction, 'better');
  assert.equal(secondAnalysis.body.trend.pulse_rate.direction, 'better'); // improved vs the first session's average of 90
  assert.equal(secondAnalysis.body.trend.nervousness_score.direction, 'better');
  assert.equal(secondAnalysis.body.overall_score, 100);

  // Recomputing replaces the row instead of duplicating it.
  await auth(request(app).post(`/api/data/sessions/${second.body.session_id}/analyze`)).expect(200);
  const list = await auth(request(app).get('/api/data/session-results')).expect(200);
  assert.equal(list.body.records.length, 2);
  assert.equal(list.body.records[0].session_id, second.body.session_id);

  await auth(request(app).post(`/api/data/sessions/${crypto.randomUUID()}/analyze`)).expect(404);
  await auth(request(app).get('/api/data/session-results'), 'bob').expect(200).expect(res => assert.deepEqual(res.body.records, []));
});
test('rolls back PDF insertion if related resume insertion fails', async () => {
  await db.query("ALTER TABLE resumes ADD CONSTRAINT test_reject_filename CHECK(filename <> 'rollback.pdf')");
  await upload(original, 'rollback.pdf').expect(400);
  const result = await db.query("SELECT count(*) AS count FROM pdf_documents WHERE filename = 'rollback.pdf'");
  assert.equal(Number(result.rows[0].count), 0);
  await db.query('ALTER TABLE resumes DROP CONSTRAINT test_reject_filename');
});
test('survives closing and reopening the on-disk PostgreSQL database', async () => {
  await engine.close();
  engine = new PGlite(folder);
  const downloaded = await createDocumentStore(db).getPdfDocument({ documentId: saved.document_id, userId: 'alice' });
  assert.deepEqual(downloaded.pdf_data, original);
  await auth(request(app).get(`/api/documents/pdfs/${saved.document_id}`)).buffer(true).parse(binary).expect(200).expect(res => assert.deepEqual(res.body, original));
});
test('refuses to serve a stored PDF whose hash no longer matches', async () => {
  await db.query('UPDATE pdf_documents SET sha256 = $1 WHERE document_id = $2', ['0'.repeat(64), saved.document_id]);
  const response = await auth(request(app).get(`/api/documents/pdfs/${saved.document_id}`)).expect(500);
  assert.equal(response.body.error, 'Unable to complete the request. Please try again.');
  await db.query('UPDATE pdf_documents SET sha256 = $1 WHERE document_id = $2', [saved.sha256, saved.document_id]);
});
