import '../config.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { PDFDocument } from 'pdf-lib';
import { maxPdfBytes } from '../config.js';
import { HttpError } from '../errors.js';

export const tigerDb = new pg.Pool({
  host: process.env.TIGER_DATA_HOST,
  port: Number(process.env.TIGER_DATA_PORT || 5432),
  user: process.env.TIGER_DATA_USER,
  password: process.env.TIGER_DATA_PASSWORD,
  database: process.env.TIGER_DATA_DATABASE || 'tsdb',
  ssl: process.env.TIGER_DATA_SSL === 'false' ? false : {
    rejectUnauthorized: process.env.TIGER_DATA_SSL_REJECT_UNAUTHORIZED !== 'false',
    ...(process.env.TIGER_DATA_CA_FILE ? { ca: fs.readFileSync(process.env.TIGER_DATA_CA_FILE, 'utf8') } : {}),
  },
  max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
});
tigerDb.on('error', error => console.error('Idle database connection failed:', error.code));
export function isTigerDataConfigured() {
  return Boolean(process.env.TIGER_DATA_HOST && process.env.TIGER_DATA_USER && process.env.TIGER_DATA_PASSWORD);
}
export async function initTigerData(db = tigerDb, { timescale = process.env.TIGER_DATA_TIMESCALE !== 'false' } = {}) {
  if (db === tigerDb && !isTigerDataConfigured()) throw new Error('Configure Tiger Data credentials in backend/.env.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(fs.readFileSync(new URL('../../sql/tigerdata.sql', import.meta.url), 'utf8'));
    if (timescale) await client.query(fs.readFileSync(new URL('../../sql/timescale.sql', import.meta.url), 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function validatePdf(filename, bytes) {
  if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.pdf') || filename.length > 255 || /[\x00-\x1f\x7f/\\]/.test(filename)) {
    throw new HttpError(400, 'Provide a PDF filename of at most 255 characters without path separators or control characters.');
  }
  if (!Buffer.isBuffer(bytes) || bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new HttpError(400, 'Upload a valid PDF file.');
  if (bytes.length > maxPdfBytes) throw new HttpError(413, `PDF exceeds ${maxPdfBytes} bytes.`);
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    if (pdf.getPageCount() < 1) throw new Error('No pages');
  } catch { throw new HttpError(400, 'The PDF is unreadable, empty, or encrypted. Upload a readable, unencrypted PDF.'); }
}

export async function ensureUser(db, { userId, email = null, name = null }) {
  await db.query(`INSERT INTO users(user_id, email, name) VALUES ($1, $2, $3)
    ON CONFLICT (user_id) DO UPDATE SET email = COALESCE(EXCLUDED.email, users.email), name = COALESCE(EXCLUDED.name, users.name)`, [userId, email, name]);
}
const metadataColumns = 'document_id, user_id, filename, mime_type, file_size_bytes, sha256, uploaded_at';
export function createDocumentStore(db = tigerDb) {
  return {
    async storePdfDocument({ documentId = crypto.randomUUID(), userId, email, name, filename, pdfBuffer, kind = 'document', title = null, company = null }) {
      if (!userId) throw new HttpError(400, 'userId is required.');
      if (!['document', 'resume', 'job_posting'].includes(kind)) throw new HttpError(400, 'Unknown document kind.');
      for (const value of [title, company]) if (value !== null && (typeof value !== 'string' || value.length > 500)) throw new HttpError(400, 'Title and company must be text of at most 500 characters.');
      await validatePdf(filename, pdfBuffer);
      const sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await ensureUser(client, { userId, email, name });
        const result = await client.query(`INSERT INTO pdf_documents(document_id, user_id, filename, file_size_bytes, sha256, pdf_data)
          VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${metadataColumns}`, [documentId, userId, filename, pdfBuffer.length, sha256, pdfBuffer]);
        if (kind === 'resume') await client.query('INSERT INTO resumes(resume_id, user_id, document_id, filename) VALUES ($1, $2, $3, $4)', [crypto.randomUUID(), userId, documentId, filename]);
        if (kind === 'job_posting') await client.query('INSERT INTO job_postings(job_posting_id, user_id, document_id, title, company) VALUES ($1, $2, $3, $4, $5)', [crypto.randomUUID(), userId, documentId, title, company]);
        await client.query('COMMIT');
        return { ...result.rows[0], kind };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    async listPdfDocuments({ userId, limit = 50, offset = 0 }) {
      const result = await db.query(`SELECT ${metadataColumns.split(', ').map(c => `d.${c}`).join(', ')},
        CASE WHEN r.resume_id IS NOT NULL THEN 'resume' WHEN j.job_posting_id IS NOT NULL THEN 'job_posting' ELSE 'document' END AS kind,
        j.title, j.company
        FROM pdf_documents d LEFT JOIN resumes r ON r.document_id = d.document_id LEFT JOIN job_postings j ON j.document_id = d.document_id
        WHERE d.user_id = $1 ORDER BY d.uploaded_at DESC, d.document_id LIMIT $2 OFFSET $3`, [userId, limit, offset]);
      return result.rows;
    },
    async getPdfDocument({ documentId, userId }) {
      const result = await db.query(`SELECT ${metadataColumns}, pdf_data FROM pdf_documents WHERE document_id = $1 AND user_id = $2`, [documentId, userId]);
      if (!result.rows[0]) return null;
      const row = result.rows[0];
      return { ...row, pdf_data: Buffer.from(row.pdf_data) };
    },
  };
}
export const { storePdfDocument, listPdfDocuments, getPdfDocument } = createDocumentStore();
