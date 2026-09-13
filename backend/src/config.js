import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
export const maxPdfBytes = Number(process.env.MAX_PDF_SIZE_BYTES || 10 * 1024 * 1024);
if (!Number.isSafeInteger(maxPdfBytes) || maxPdfBytes <= 0) throw new Error('MAX_PDF_SIZE_BYTES must be a positive integer.');
