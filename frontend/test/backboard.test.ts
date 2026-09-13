import test from "node:test";
import assert from "node:assert/strict";
import { validateResume, MAX_RESUME_BYTES, getSavedResume, setSessionResume } from "../src/backboard.ts";

test("resume validation accepts actual PDFs and rejects invalid and oversized files before network activity", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Resume validation must not contact Backboard"); };
  try {
    await validateResume(new File(["%PDF-1.4 example"], "resume.pdf", { type: "application/pdf" }));
    await setSessionResume(new File(["%PDF-1.4 example"], "resume.pdf"));
    await setSessionResume(null);
    await assert.rejects(validateResume(new File(["text"], "resume.txt")), /PDF resume/);
    await assert.rejects(validateResume(new File(["text"], "resume.pdf")), /valid PDF/);
    await assert.rejects(validateResume(new File([new Uint8Array(MAX_RESUME_BYTES + 1)], "resume.pdf")), /10 MB/);
  } finally { globalThis.fetch = original; }
});

test("old Backboard document IDs are not treated as locally available resume bytes", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => key === "callback.backboard.v1" ? JSON.stringify({ resume: { documentId: "old-upstream-document" } }) : null } });
  try { assert.equal(getSavedResume(), null); }
  finally { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); }
});

test("resume bytes stay in IndexedDB and the fresh PDF goes only to the Gemini planner", async () => {
  const { IDBFactory } = await import("fake-indexeddb");
  const api = await import("../src/backboard.ts");
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const originalDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
  } });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, options) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: JSON.parse(options!.body as string) });
    if (path === "/api/services/sessions") return new Response(JSON.stringify({ sessionId: "s-1" }));
    if (path === "/api/services/gemini/interview-plan") return new Response(JSON.stringify({ questions: [{ text: "Tell me about your project." }], source: "gemini" }));
    throw new Error(`Unexpected network request: ${path}`);
  };
  try {
    const first = new File(["%PDF-1.4 private resume"], "resume.pdf", { type: "application/pdf" });
    const uploaded = await api.uploadResume(first);
    assert.equal(uploaded.status, "indexed");
    assert.equal(calls.length, 0, "saving a PDF makes no external request");
    assert.doesNotMatch(JSON.stringify([...values.values()]), /private resume/);
    await api.retryResume();
    const override = new File(["%PDF-1.4 current session resume"], "current.pdf");
    await api.setSessionResume(override);
    values.set("callback.session-context.v1", JSON.stringify({ jobPosting: "Current posting", targetWeakness: "Specific outcomes" }));
    await api.prepareInterview();
    assert.deepEqual(calls.map((call) => call.path), ["/api/services/sessions", "/api/services/gemini/interview-plan"]);
    assert.equal(calls[0].body.jobPostingText, "Current posting");
    assert.equal(Buffer.from(calls[1].body.resumePdf as string, "base64").toString(), await override.text());
    await api.setSessionResume(null);
    calls.length = 0;
    await api.prepareInterview();
    assert.equal(Buffer.from(calls[1].body.resumePdf as string, "base64").toString(), await first.text());
    await api.removeResume();
    assert.equal(api.getReadyResume(), null);
    await assert.rejects(api.retryResume(), /Select your PDF again/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else Reflect.deleteProperty(globalThis, "localStorage");
    if (originalDb) Object.defineProperty(globalThis, "indexedDB", originalDb); else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});
