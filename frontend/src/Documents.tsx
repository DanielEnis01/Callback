import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from './AuthContext';

type StoredDocument = {
  document_id: string; filename: string; file_size_bytes: number;
  uploaded_at: string; sha256: string; kind: 'document' | 'resume' | 'job_posting';
};
// The browser dev server proxies relative requests. A packaged Electron app
// has no dev server, so it uses the local API unless deployment overrides it.
const apiBase = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.PROD ? 'http://127.0.0.1:3001' : '')).replace(/\/$/, '');
const pageSize = 50;
export default function Documents() {
  const { user } = useAuth();
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [kind, setKind] = useState<StoredDocument['kind']>('resume');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  async function request(path: string, options: RequestInit = {}) {
    if (!user) throw new Error('Please sign in.');
    const token = await user.getIdToken();
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`${apiBase}/api/documents${path}`, { ...options, headers });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || `Request failed (${response.status}). Check that the Tiger Data backend is running.`);
    }
    return response;
  }
  useEffect(() => {
    let current = true;
    setLoading(true); setError(''); setDocuments([]);
    request(`/pdfs?limit=${pageSize}&offset=${offset}`)
      .then(res => res.json()).then(data => { if (current) setDocuments(data.documents); })
      .catch(err => { if (current) setError(err.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [user, offset]);
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || busy) return;
    setBusy(true); setError(''); setMessage('');
    let saved = false;
    try {
      await request('/pdfs', {
        method: 'POST', body: file,
        headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name), 'X-Document-Kind': kind,
          ...(kind === 'job_posting' ? { 'X-Job-Title': encodeURIComponent(title), 'X-Company': encodeURIComponent(company) } : {}) },
      });
      saved = true;
      setMessage(`${file.name} is saved in Tiger Data. You can download the original PDF below.`);
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      if (offset !== 0) setOffset(0);
      else {
        const response = await request(`/pdfs?limit=${pageSize}&offset=0`);
        setDocuments((await response.json()).documents);
      }
    } catch (err) { setError(`${saved ? 'The PDF was saved, but the list could not refresh. ' : ''}${err instanceof Error ? err.message : 'Upload failed.'}`); }
    finally { setBusy(false); }
  }
  async function download(document: StoredDocument) {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await request(`/pdfs/${document.document_id}`);
      const buffer = await response.arrayBuffer();
      // Wrap the buffer in this realm's typed array. It avoids a cross-realm
      // ArrayBuffer issue in desktop/test WebCrypto while preserving bytes.
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(buffer))), b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== document.sha256 || buffer.byteLength !== document.file_size_bytes) throw new Error('File integrity check failed. Please download again.');
      const url = URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
      const anchor = window.document.createElement('a');
      anchor.href = url; anchor.download = document.filename;
      window.document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`Downloaded ${document.filename}. The file matches the original upload.`);
    } catch (err) { setError(err instanceof Error ? err.message : 'Download failed.'); }
    finally { setBusy(false); }
  }
  const fieldClass = 'mt-2 w-full border border-white/25 bg-black px-3 py-3 text-white';
  return (
    <main className="w-full px-6 py-12 sm:px-12">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-4xl font-extrabold tracking-tight">Your documents</h1>
        <p className="mt-3 text-white/60">Store PDFs in Tiger Data and download the original files whenever you need them.</p>
        <form onSubmit={upload} className="mt-8 space-y-5 border border-white/20 p-6">
          <div className="grid gap-5 sm:grid-cols-2">
            <label>Document type<select value={kind} onChange={e => setKind(e.target.value as StoredDocument['kind'])} disabled={busy} className={fieldClass}><option value="resume">Resume</option><option value="job_posting">Job posting</option><option value="document">Other PDF</option></select></label>
            <label>PDF file<input ref={inputRef} type="file" accept=".pdf,application/pdf" required disabled={busy} onChange={e => setFile(e.target.files?.[0] || null)} className={fieldClass} /></label>
          </div>
          {kind === 'job_posting' && <div className="grid gap-5 sm:grid-cols-2"><label>Job title<input value={title} maxLength={500} onChange={e => setTitle(e.target.value)} disabled={busy} className={fieldClass} /></label><label>Company<input value={company} maxLength={500} onChange={e => setCompany(e.target.value)} disabled={busy} className={fieldClass} /></label></div>}
          <p className="text-sm text-white/50">Upload a readable, unencrypted PDF. Default server limit: 10 MiB.</p>
          <button type="submit" disabled={!file || busy || loading} className="bg-white px-6 py-3 font-semibold text-black disabled:opacity-40">{busy ? 'Working…' : 'Save PDF'}</button>
        </form>
        {error && <p role="alert" className="mt-5 text-red-300">{error}</p>}
        {message && <p role="status" className="mt-5 text-green-300">{message}</p>}
        <section aria-labelledby="saved-documents" className="mt-10">
          <h2 id="saved-documents" className="text-xl font-semibold">Saved PDFs</h2>
          {loading ? <p role="status" className="mt-4 text-white/60">Loading saved files…</p> : documents.length === 0 && !error ? <p className="mt-4 text-white/60">{offset ? 'No more PDFs on this page.' : 'No PDFs saved yet. Upload your first file above.'}</p> : null}
          <ul className="mt-4 divide-y divide-white/15">{documents.map(document => <li key={document.document_id} className="flex flex-wrap items-center justify-between gap-4 py-5"><div className="min-w-0"><p className="break-all font-medium">{document.filename}</p><p className="mt-1 text-sm text-white/50">{document.kind.replace('_', ' ')} · {(document.file_size_bytes / 1024).toFixed(1)} KB · {new Date(document.uploaded_at).toLocaleString()}</p></div><button type="button" disabled={busy} onClick={() => download(document)} className="border border-white/30 px-4 py-2 disabled:opacity-40" aria-label={`Download ${document.filename}`}>Download PDF</button></li>)}</ul>
          <div className="mt-5 flex gap-4"><button disabled={!offset || loading || busy} onClick={() => setOffset(Math.max(0, offset - pageSize))} className="disabled:opacity-30">Previous</button><button disabled={documents.length < pageSize || loading || busy} onClick={() => setOffset(offset + pageSize)} className="disabled:opacity-30">Next</button></div>
        </section>
      </div>
    </main>
  );
}
