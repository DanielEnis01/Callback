import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  uploadResume, retryResume, removeResume, prepareInterview, getReadyResume, MAX_RESUME_BYTES,
} from "../src/backboard.ts";

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const STORAGE_KEY = "callback.backboard.v1";
const calls: { path: string; options: RequestInit }[] = [];
const pdf = (text = "candidate background") => new File([`%PDF-1.4\n${text}`], "resume.pdf", { type: "application/pdf" });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls.length = 0;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  let uploads = 0;
  globalThis.fetch = async (input, options = {}) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, options });
    if (path.endsWith("/assistants")) return json({ assistant_id: "assistant-1" });
    if (path.endsWith("/resumes")) return json({ document_id: `doc-${++uploads}`, status: "pending" }, 202);
    if (path.endsWith("/status")) return json({ status: "indexed" });
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    if (path.endsWith("/sessions/start")) return json({ content: "How did you use React in your last project?", thread_id: "thread-1" });
    throw new Error(`Unexpected request ${path}`);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("PDF bytes reach the backend; assistant and indexed document IDs persist without the PDF", async () => {
  const file = pdf();
  const uploaded = await uploadResume(file);
  assert.equal(uploaded.documentId, "doc-1");
  assert.equal(getReadyResume()?.documentId, "doc-1");
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/backboard/assistants", "/api/backboard/assistants/assistant-1/resumes", "/api/backboard/documents/doc-1/status",
  ]);
  assert.equal(await (calls[1].options.body as File).text(), await file.text());
  assert.equal(new Headers(calls[1].options.headers).get("Content-Type"), "application/pdf");
  assert.equal(new Headers(calls[1].options.headers).get("X-API-Key"), null);
  const saved = localStorage.getItem(STORAGE_KEY)!;
  assert.match(saved, /assistant-1/);
  assert.doesNotMatch(saved, /candidate background/);
  await uploadResume(file);
  assert.equal(calls.length, 3, "selecting the same PDF reuses its existing document");
});

test("preparation sends the current resume and profile before displaying a question", async () => {
  await uploadResume(pdf());
  localStorage.setItem("callback.interview-profile.v1", JSON.stringify({
    name: "Alex", targetRoles: "Frontend engineer", jobPosting: "Build accessible React applications.", rawSignals: { pulse: 85 },
  }));
  const result = await prepareInterview();
  assert.match(result.content, /React/);
  const body = JSON.parse(calls.at(-1)!.options.body as string);
  assert.deepEqual(body, {
    resumeDocumentId: "doc-1", candidateName: "Alex", targetRoles: "Frontend engineer", jobPosting: "Build accessible React applications.",
  });
  assert.equal(calls.filter((call) => call.path.endsWith("/assistants")).length, 1);
});

test("an interrupted status check resumes from the saved ID without another upload", async () => {
  const workingFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => String(input).endsWith("/status")
    ? Promise.reject(new Error("connection interrupted")) : workingFetch(input, options);
  await assert.rejects(uploadResume(pdf()), /Cannot reach/);
  assert.equal(getReadyResume(), null);
  assert.equal(JSON.parse(localStorage.getItem(STORAGE_KEY)!).pendingResume.documentId, "doc-1");
  globalThis.fetch = workingFetch;
  await retryResume();
  assert.equal(getReadyResume()?.documentId, "doc-1");
  assert.equal(calls.filter((call) => call.path.endsWith("/resumes")).length, 1);
});

test("replacement waits for indexing, removes the old document, and retains the same assistant", async () => {
  await uploadResume(pdf("old resume"));
  localStorage.setItem("callback.interview-profile.v1", JSON.stringify({ name: "Alex", targetRoles: "Engineer", resume: { documentId: "doc-1" } }));
  await uploadResume(pdf("new resume"));
  assert.equal(getReadyResume()?.documentId, "doc-2");
  assert.equal(JSON.parse(localStorage.getItem("callback.interview-profile.v1")!).resume.documentId, "doc-2");
  const statusIndex = calls.findIndex((call) => call.path.endsWith("/doc-2/status"));
  const deleteIndex = calls.findIndex((call) => call.options.method === "DELETE");
  assert.ok(deleteIndex > statusIndex);
  assert.equal(calls[deleteIndex].path, "/api/backboard/documents/doc-1");
  assert.equal(calls.filter((call) => call.path.endsWith("/assistants")).length, 1);
  await removeResume();
  assert.equal(getReadyResume(), null);
  assert.equal(JSON.parse(localStorage.getItem("callback.interview-profile.v1")!).resume, null);
  await assert.rejects(prepareInterview(), /Upload your resume/);
});

test("failed replacement cleanup blocks preparation and can be retried", async () => {
  await uploadResume(pdf("old resume"));
  const workingFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => options?.method === "DELETE"
    ? json({ error: "cleanup failed" }, 502) : workingFetch(input, options);
  await assert.rejects(uploadResume(pdf("replacement")), /cleanup failed/);
  assert.equal(getReadyResume(), null);
  await assert.rejects(prepareInterview(), /pending resume/);
  globalThis.fetch = workingFetch;
  await retryResume();
  assert.equal(getReadyResume()?.documentId, "doc-2");
  assert.equal(calls.filter((call) => call.path.endsWith("/resumes")).length, 2);
});

test("invalid and oversized files fail before creating an assistant", async () => {
  await assert.rejects(uploadResume(new File(["text"], "resume.txt")), /PDF resume/);
  await assert.rejects(uploadResume(new File(["not a PDF"], "resume.pdf")), /valid PDF/);
  await assert.rejects(uploadResume(new File([new Uint8Array(MAX_RESUME_BYTES + 1)], "large.pdf")), /10 MB/);
  assert.equal(calls.length, 0);
});

test("cannot start with only the legacy filename metadata", async () => {
  localStorage.setItem("callback.interview-profile.v1", JSON.stringify({ resume: { name: "old.pdf", size: 100 } }));
  await assert.rejects(prepareInterview(), /Upload your resume/);
  assert.equal(calls.length, 0);
});
