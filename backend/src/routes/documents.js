import express from 'express';
import crypto from 'node:crypto';
import { createDocumentStore } from '../services/tigerdata.js';
import { maxPdfBytes } from '../config.js';
import { asyncRoute, HttpError } from '../errors.js';

export function pagination(query) {
  const parse = (value, fallback, max) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new HttpError(400, 'Invalid pagination.');
    return Number(value);
  };
  const limit = parse(query.limit, 50, 100);
  if (limit < 1) throw new HttpError(400, 'Limit must be between 1 and 100.');
  return { limit, offset: parse(query.offset, 0, Number.MAX_SAFE_INTEGER) };
}
export function requireUuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(400, 'Invalid record ID.');
  return value;
}
function decodeHeader(req, name) {
  const value = req.get(name);
  if (value === undefined) return undefined;
  try { return decodeURIComponent(value); }
  catch { throw new HttpError(400, `Invalid encoding in ${name}.`); }
}
export function createDocumentsRouter(db) {
  const router = express.Router();
  const store = createDocumentStore(db);
  router.post('/pdfs', express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: maxPdfBytes }), asyncRoute(async (req, res) => {
    if (!req.is(['application/pdf', 'application/octet-stream'])) throw new HttpError(415, 'Send PDF bytes with Content-Type: application/pdf.');
    const document = await store.storePdfDocument({
      ...req.user,
      filename: decodeHeader(req, 'x-filename'),
      pdfBuffer: req.body,
      kind: req.get('x-document-kind') || 'document',
      title: decodeHeader(req, 'x-job-title') ?? null,
      company: decodeHeader(req, 'x-company') ?? null,
    });
    res.location(`/api/documents/pdfs/${document.document_id}`).status(201).json(document);
  }));
  router.get('/pdfs', asyncRoute(async (req, res) => {
    const page = pagination(req.query);
    res.json({ documents: await store.listPdfDocuments({ userId: req.user.userId, ...page }), ...page });
  }));
  router.delete('/pdfs/:documentId', asyncRoute(async (req, res) => {
    const deleted = await store.deletePdfDocument({ documentId: requireUuid(req.params.documentId), userId: req.user.userId });
    if (!deleted) throw new HttpError(404, 'PDF not found.');
    res.status(204).end();
  }));
  router.get('/pdfs/:documentId', asyncRoute(async (req, res) => {
    const document = await store.getPdfDocument({ documentId: requireUuid(req.params.documentId), userId: req.user.userId });
    if (!document) throw new HttpError(404, 'PDF not found.');
    if (document.pdf_data.length !== document.file_size_bytes || crypto.createHash('sha256').update(document.pdf_data).digest('hex') !== document.sha256) throw new Error('Stored PDF integrity check failed');
    // ASCII fallback plus RFC 5987 preserves Unicode names across HTTP clients.
    const fallbackName = document.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const encodedName = encodeURIComponent(document.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.set('Content-Disposition', `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Length': String(document.file_size_bytes), 'X-Content-SHA256': document.sha256, 'X-Content-Type-Options': 'nosniff' });
    res.send(document.pdf_data);
  }));
  return router;
}
