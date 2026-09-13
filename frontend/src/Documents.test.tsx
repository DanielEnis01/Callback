import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { webcrypto } from 'node:crypto';
import Documents from './Documents';
const { token, fetchMock } = vi.hoisted(() => ({ token: vi.fn(), fetchMock: vi.fn() }));
vi.mock('./AuthContext', () => { const user = { uid: 'alice', getIdToken: token }; return { useAuth: () => ({ user }) }; });
const stored = { document_id: '123', filename: 'resume.pdf', file_size_bytes: 3, uploaded_at: '2026-09-12T12:00:00Z', sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81', kind: 'resume' };
const jsonResponse = (value: unknown) => ({ ok: true, json: async () => value });
beforeEach(() => {
  vi.resetAllMocks();
  token.mockResolvedValue('verified-token');
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('Documents', () => {
  it('uploads original file bytes using the signed-in token and refreshes saved files', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ documents: [] }))
      .mockResolvedValueOnce(jsonResponse(stored)).mockResolvedValueOnce(jsonResponse({ documents: [stored] }));
    render(<Documents />);
    await screen.findByText('No PDFs saved yet. Upload your first file above.');
    const file = new File(['%PDF-1.7'], 'resume.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('PDF file'), file);
    // jsdom does not implement native file-input constraint validation after upload.
    fireEvent.submit(screen.getByRole('button', { name: 'Save PDF' }).closest('form')!);
    await screen.findByRole('button', { name: 'Download resume.pdf' });
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/documents/pdfs');
    expect(options.body).toBe(file);
    expect(options.headers.get('Authorization')).toBe('Bearer verified-token');
    expect(options.headers.get('X-Document-Kind')).toBe('resume');
    expect(screen.getByRole('status').textContent).toContain('saved in Tiger Data');
  });
  it('shows backend errors when a file is rejected', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ documents: [] })).mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'The PDF is unreadable.' }) });
    render(<Documents />);
    await screen.findByText('No PDFs saved yet. Upload your first file above.');
    await userEvent.upload(screen.getByLabelText('PDF file'), new File(['bad'], 'bad.pdf', { type: 'application/pdf' }));
    // jsdom does not implement native file-input constraint validation after upload.
    fireEvent.submit(screen.getByRole('button', { name: 'Save PDF' }).closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toBe('The PDF is unreadable.');
  });
  it('downloads the original filename only after verifying the returned bytes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ documents: [stored] })).mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    const create = vi.fn().mockReturnValue('blob:pdf');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    let downloaded = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloaded = this.download; });
    render(<Documents />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download resume.pdf' }));
    await waitFor(() => expect(downloaded).toBe('resume.pdf'));
    expect(create.mock.calls[0][0].type).toBe('application/pdf');
    expect(screen.getByRole('status').textContent).toContain('matches the original upload');
  });
  it('does not download corrupted bytes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ documents: [stored] })).mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<Documents />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download resume.pdf' }));
    expect((await screen.findByRole('alert')).textContent).toContain('integrity check failed');
    expect(click).not.toHaveBeenCalled();
  });
});
