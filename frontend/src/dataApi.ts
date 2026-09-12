import { getFirebaseAuth } from './firebase';

const base = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
export async function apiRequest(path: string, options: RequestInit = {}) {
  const user = getFirebaseAuth().currentUser;
  if (!user) throw new Error('Sign in before saving data.');
  const token = await user.getIdToken();
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${base}/api${path}`, { ...options, headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Storage request failed (${response.status}).`);
  }
  return response;
}
export async function dataRequest<T = Record<string, unknown>>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await apiRequest(`/data${path}`, body === undefined ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return response.json();
}
export async function uploadResume(file: File) {
  return (await apiRequest('/documents/pdfs', {
    method: 'POST', body: file,
    headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name), 'X-Document-Kind': 'resume' },
  })).json();
}
