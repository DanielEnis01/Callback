export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
export function errorHandler(error, _req, res, _next) {
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'File exceeds the configured upload size limit.' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ error: error.message });
  if (['23503', '23514', '22P02', '22007', '22008', '22003'].includes(error.code)) return res.status(400).json({ error: 'Invalid data or a reference to an unavailable record.' });
  if (error.code === '23505') return res.status(409).json({ error: 'This record already exists or conflicts with an existing record.' });
  if (error.code === '23502') return res.status(400).json({ error: 'A required field is missing.' });
  console.error('API request failed:', error.code || error.name);
  return res.status(500).json({ error: 'Unable to complete the request. Please try again.' });
}
