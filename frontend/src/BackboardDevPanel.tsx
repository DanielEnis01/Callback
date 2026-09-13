import { useState, useRef, FC } from "react";
import {
  Terminal, X, Database, FileText, Brain, Play, Activity,
  Upload, Trash2, Search, Plus,
  RefreshCw, AlertCircle, Loader2,
} from "lucide-react";

const API_BASE = (import.meta.env?.VITE_API_BASE_URL || "http://localhost:3001").replace(/\/$/, "");

// ── Shared styles ─────────────────────────────────────────────────────────────
const PANEL_BG = "#09090b";
const HEADER_BG = "#111113";
const INPUT_BG = "#18181b";
const BORDER = "rgba(255,255,255,0.14)";
const BORDER_LIGHT = "rgba(255,255,255,0.1)";
const BORDER_FAINT = "rgba(255,255,255,0.08)";
const LABEL_COLOR = "#52525b";
const TEXT_COLOR = "#e4e4e7";
const TEXT_DIM = "#71717a";
const TEXT_FAINT = "#52525b";
const FONT = "'Sora', 'JetBrains Mono', monospace";

const btnBase: React.CSSProperties = {
  fontFamily: FONT,
  fontSize: "11px",
  fontWeight: 600,
  letterSpacing: "0.06em",
  border: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "5px",
  padding: "7px 12px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: INPUT_BG,
  border: `1px solid ${BORDER_LIGHT}`,
  color: TEXT_COLOR,
  padding: "8px 10px",
  fontSize: "12px",
  outline: "none",
  boxSizing: "border-box",
  fontFamily: FONT,
};

const labelStyle: React.CSSProperties = {
  color: LABEL_COLOR,
  display: "block",
  marginBottom: "6px",
  textTransform: "uppercase" as const,
  letterSpacing: "0.1em",
  fontSize: "10px",
};

// ── Shared fetch helper ────────────────────────────────────────────────────────
async function bbApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}/api/backboard${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(90000),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

async function servicesApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}/api/services${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// ── localStorage keys (mirror backboard.ts) ────────────────────────────────────
const STORAGE_KEY = "callback.backboard.v1";

interface BackboardContext {
  userId: string;
  assistantId?: string;
  resume?: { documentId: string; name: string; size: number; fingerprint: string; status: string };
  pendingResume?: { documentId: string; name: string; size: number; fingerprint: string; status: string };
}

function readContext(): BackboardContext | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Log entry type ──────────────────────────────────────────────────────────────
interface LogEntry {
  id: number;
  ts: string;
  type: "info" | "success" | "error" | "data";
  message: string;
}

let logId = 0;

// ── Tab definitions ─────────────────────────────────────────────────────────────
type Tab = "assistant" | "resume" | "memory" | "session" | "status";

const TABS: { id: Tab; label: string; icon: typeof Database }[] = [
  { id: "assistant", label: "Assistant", icon: Database },
  { id: "resume", label: "Resume", icon: FileText },
  { id: "memory", label: "Memory", icon: Brain },
  { id: "session", label: "Session", icon: Play },
  { id: "status", label: "Status", icon: Activity },
];

// ── Component ───────────────────────────────────────────────────────────────────

export const BackboardDevPanel: FC = () => {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("assistant");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  if (!import.meta.env.DEV) return null;

  const log = (type: LogEntry["type"], message: string) => {
    const entry: LogEntry = { id: ++logId, ts: new Date().toLocaleTimeString(), type, message };
    setLogs((prev) => [...prev.slice(-49), entry]);
    setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    log("info", `${label}…`);
    try {
      const result = await fn();
      log("success", `${label} ✓`);
      if (result !== undefined && result !== null) {
        log("data", typeof result === "string" ? result : JSON.stringify(result, null, 2));
      }
    } catch (err) {
      log("error", `${label} ✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: "1rem",
        left: "1rem",
        zIndex: 9999,
        fontFamily: FONT,
        fontSize: "12px",
      }}
    >
      {/* Toggle button */}
      <button
        onClick={() => setOpen((o) => !o)}
        title="Toggle Backboard dev tools"
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          width: "40px",
          height: "40px",
          background: open ? "#18181b" : "#27272a",
          border: `1px solid ${BORDER}`,
          color: "#a1a1aa",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          transition: "background 0.15s, color 0.15s",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#fff"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#a1a1aa"; }}
      >
        <Database size={16} />
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "48px",
            left: 0,
            width: "420px",
            maxHeight: "75vh",
            background: PANEL_BG,
            border: `1px solid ${BORDER}`,
            boxShadow: "0 8px 40px rgba(0,0,0,0.8)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 12px",
              borderBottom: `1px solid ${BORDER_LIGHT}`,
              background: HEADER_BG,
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px", color: TEXT_DIM }}>
              <Terminal size={12} />
              <span style={{ textTransform: "uppercase", letterSpacing: "0.12em", fontSize: "10px" }}>
                Dev Tools — Backboard
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {busy && <Loader2 size={12} style={{ color: "#60a5fa", animation: "spin 1s linear infinite" }} />}
              <button
                onClick={() => setOpen(false)}
                style={{ background: "none", border: "none", color: TEXT_FAINT, cursor: "pointer", padding: "2px", display: "flex" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#fff")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = TEXT_FAINT)}
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div
            style={{
              display: "flex",
              borderBottom: `1px solid ${BORDER_FAINT}`,
              background: HEADER_BG,
              flexShrink: 0,
            }}
          >
            {TABS.map((t) => {
              const active = tab === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{
                    flex: 1,
                    padding: "7px 4px",
                    background: active ? "rgba(255,255,255,0.06)" : "transparent",
                    border: "none",
                    borderBottom: active ? "2px solid #60a5fa" : "2px solid transparent",
                    color: active ? "#e4e4e7" : TEXT_FAINT,
                    cursor: "pointer",
                    fontFamily: FONT,
                    fontSize: "10px",
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase" as const,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "4px",
                    transition: "all 0.15s",
                  }}
                >
                  <Icon size={11} />
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Tab content */}
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
            {tab === "assistant" && <AssistantTab log={log} run={run} busy={busy} />}
            {tab === "resume" && <ResumeTab log={log} run={run} busy={busy} />}
            {tab === "memory" && <MemoryTab log={log} run={run} busy={busy} />}
            {tab === "session" && <SessionTab log={log} run={run} busy={busy} />}
            {tab === "status" && <StatusTab log={log} run={run} busy={busy} />}
          </div>

          {/* Log pane */}
          {logs.length > 0 && (
            <div
              style={{
                borderTop: `1px solid ${BORDER_FAINT}`,
                maxHeight: "140px",
                overflowY: "auto",
                padding: "6px 10px",
                background: "#0a0a0b",
                flexShrink: 0,
              }}
            >
              {logs.map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    fontSize: "10px",
                    lineHeight: 1.5,
                    color: entry.type === "error" ? "#f87171"
                      : entry.type === "success" ? "#4ade80"
                      : entry.type === "data" ? "#a1a1aa"
                      : TEXT_DIM,
                    whiteSpace: entry.type === "data" ? "pre-wrap" : "normal",
                    fontFamily: entry.type === "data" ? "'JetBrains Mono', monospace" : FONT,
                    wordBreak: "break-all",
                  }}
                >
                  <span style={{ color: "#3f3f46", marginRight: "6px" }}>{entry.ts}</span>
                  {entry.message}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      )}

      {/* Keyframe for spinner */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

// ── Tab Components ────────────────────────────────────────────────────────────

interface TabProps {
  log: (type: LogEntry["type"], message: string) => void;
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}

// ── Assistant Tab ──────────────────────────────────────────────────────────────

const AssistantTab: FC<TabProps> = ({ log, run, busy }) => {
  const ctx = readContext();

  return (
    <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
      {/* Current state */}
      <div>
        <span style={labelStyle}>Current State</span>
        <div style={{ background: INPUT_BG, border: `1px solid ${BORDER_FAINT}`, padding: "8px 10px", fontSize: "11px" }}>
          <div style={{ color: TEXT_DIM }}>
            User ID: <span style={{ color: ctx?.userId ? TEXT_COLOR : "#f87171" }}>{ctx?.userId || "none"}</span>
          </div>
          <div style={{ color: TEXT_DIM, marginTop: "3px" }}>
            Assistant ID: <span style={{ color: ctx?.assistantId ? "#4ade80" : "#f87171" }}>{ctx?.assistantId || "none"}</span>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: "6px" }}>
        <button
          disabled={busy || !!ctx?.assistantId}
          onClick={() => void run("Create assistant", async () => {
            const userId = ctx?.userId || crypto.randomUUID();
            const result = await bbApi<{ assistant_id: string }>("/assistants", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId }),
            });
            const newCtx: BackboardContext = { ...ctx, userId, assistantId: result.assistant_id };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(newCtx));
            return result;
          })}
          style={{
            ...btnBase, flex: 1,
            background: !busy && !ctx?.assistantId ? "rgba(96,165,250,0.15)" : "rgba(255,255,255,0.04)",
            color: !busy && !ctx?.assistantId ? "#60a5fa" : TEXT_FAINT,
            border: `1px solid ${!busy && !ctx?.assistantId ? "rgba(96,165,250,0.3)" : BORDER_FAINT}`,
          }}
        >
          <Plus size={11} /> Create
        </button>
        <button
          disabled={busy}
          onClick={() => void run("Reset assistant", async () => {
            const old = readContext();
            if (old?.assistantId) {
              try {
                await bbApi(`/assistants/${encodeURIComponent(old.assistantId)}`, { method: "DELETE" });
              } catch { /* ignore — might already be gone */ }
            }
            localStorage.removeItem(STORAGE_KEY);
            return "Cleared localStorage + deleted remote assistant";
          })}
          style={{
            ...btnBase,
            background: "rgba(239,68,68,0.12)",
            color: "#f87171",
            border: "1px solid rgba(239,68,68,0.25)",
          }}
        >
          <Trash2 size={11} /> Reset
        </button>
      </div>

      <button
        disabled={busy}
        onClick={() => {
          const c = readContext();
          log("data", c ? JSON.stringify(c, null, 2) : "No backboard context in localStorage");
        }}
        style={{
          ...btnBase, width: "100%",
          background: "rgba(255,255,255,0.04)",
          color: TEXT_DIM,
          border: `1px solid ${BORDER_FAINT}`,
        }}
      >
        <Search size={11} /> Dump localStorage
      </button>
    </div>
  );
};

// ── Resume Tab ──────────────────────────────────────────────────────────────────

const ResumeTab: FC<TabProps> = ({ log, run, busy }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [docId, setDocId] = useState("");
  const ctx = readContext();

  const resumeInfo = ctx?.pendingResume || ctx?.resume;

  const pollStatus = async (documentId: string) => {
    const result = await bbApi<{ status: string; status_message?: string }>(`/documents/${encodeURIComponent(documentId)}/status`);
    return result;
  };

  return (
    <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
      {/* Current resume */}
      <div>
        <span style={labelStyle}>Current Resume</span>
        <div style={{ background: INPUT_BG, border: `1px solid ${BORDER_FAINT}`, padding: "8px 10px", fontSize: "11px" }}>
          {resumeInfo ? (
            <>
              <div style={{ color: TEXT_COLOR }}><FileText size={11} style={{ display: "inline", marginRight: "4px" }} />{resumeInfo.name}</div>
              <div style={{ color: TEXT_DIM, marginTop: "2px" }}>
                ID: <span style={{ color: "#a78bfa", fontFamily: "'JetBrains Mono', monospace" }}>{resumeInfo.documentId}</span>
              </div>
              <div style={{ color: TEXT_DIM, marginTop: "2px" }}>
                Status: <span style={{ color: resumeInfo.status === "indexed" ? "#4ade80" : resumeInfo.status === "error" ? "#f87171" : "#fbbf24" }}>{resumeInfo.status}</span>
                {ctx?.pendingResume && <span style={{ color: "#fbbf24", marginLeft: "6px" }}>(pending)</span>}
              </div>
            </>
          ) : (
            <span style={{ color: TEXT_FAINT }}>No resume uploaded</span>
          )}
        </div>
      </div>

      {/* Upload */}
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          e.target.value = "";
          void run(`Upload resume "${file.name}"`, async () => {
            const c = readContext();
            if (!c?.assistantId) throw new Error("Create an assistant first");
            const result = await bbApi<{ document_id: string; status: string }>(
              `/assistants/${encodeURIComponent(c.assistantId)}/resumes?filename=${encodeURIComponent(file.name)}`,
              { method: "POST", headers: { "Content-Type": "application/pdf" }, body: file }
            );
            const updated = { ...c, pendingResume: { documentId: result.document_id, name: file.name, size: file.size, fingerprint: "", status: result.status } };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
            return result;
          });
        }}
      />
      <div style={{ display: "flex", gap: "6px" }}>
        <button
          disabled={busy || !ctx?.assistantId}
          onClick={() => inputRef.current?.click()}
          style={{
            ...btnBase, flex: 1,
            background: !busy && ctx?.assistantId ? "rgba(96,165,250,0.15)" : "rgba(255,255,255,0.04)",
            color: !busy && ctx?.assistantId ? "#60a5fa" : TEXT_FAINT,
            border: `1px solid ${!busy && ctx?.assistantId ? "rgba(96,165,250,0.3)" : BORDER_FAINT}`,
          }}
        >
          <Upload size={11} /> Upload PDF
        </button>
        <button
          disabled={busy || !resumeInfo}
          onClick={() => {
            const id = resumeInfo?.documentId;
            if (!id) return;
            void run("Poll document status", async () => pollStatus(id));
          }}
          style={{
            ...btnBase,
            background: "rgba(255,255,255,0.04)",
            color: resumeInfo ? TEXT_DIM : TEXT_FAINT,
            border: `1px solid ${BORDER_FAINT}`,
          }}
        >
          <RefreshCw size={11} /> Poll
        </button>
        <button
          disabled={busy || !resumeInfo}
          onClick={() => {
            const id = resumeInfo?.documentId;
            if (!id) return;
            void run("Delete document", async () => {
              await bbApi(`/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
              const c = readContext();
              if (c) {
                delete c.pendingResume;
                delete c.resume;
                localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
              }
              return "Deleted";
            });
          }}
          style={{
            ...btnBase,
            background: "rgba(239,68,68,0.12)",
            color: resumeInfo ? "#f87171" : TEXT_FAINT,
            border: `1px solid ${resumeInfo ? "rgba(239,68,68,0.25)" : BORDER_FAINT}`,
          }}
        >
          <Trash2 size={11} />
        </button>
      </div>

      {/* Manual document ID lookup */}
      <div>
        <span style={labelStyle}>Manual Document Status</span>
        <div style={{ display: "flex", gap: "6px" }}>
          <input
            value={docId}
            onChange={(e) => setDocId(e.target.value)}
            placeholder="Document ID…"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            disabled={busy || !docId.trim()}
            onClick={() => void run("Check document", async () => pollStatus(docId.trim()))}
            style={{
              ...btnBase,
              background: docId.trim() ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.04)",
              color: docId.trim() ? TEXT_DIM : TEXT_FAINT,
              border: `1px solid ${BORDER_FAINT}`,
            }}
          >
            <Search size={11} />
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Memory Tab ──────────────────────────────────────────────────────────────────

const MemoryTab: FC<TabProps> = ({ log, run, busy }) => {
  const [storeText, setStoreText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const ctx = readContext();

  return (
    <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "12px" }}>
      {!ctx?.assistantId && (
        <div style={{ fontSize: "11px", color: "#fbbf24", background: "rgba(251,191,36,0.1)", padding: "8px 10px", border: "1px solid rgba(251,191,36,0.2)" }}>
          <AlertCircle size={11} style={{ display: "inline", marginRight: "4px" }} /> Create an assistant first
        </div>
      )}

      {/* Store memory */}
      <div>
        <span style={labelStyle}>Store Memory</span>
        <textarea
          value={storeText}
          onChange={(e) => setStoreText(e.target.value)}
          placeholder="Enter a coaching fact to store…"
          rows={3}
          style={{ ...inputStyle, resize: "vertical" as const }}
        />
        <button
          disabled={busy || !storeText.trim() || !ctx?.assistantId}
          onClick={() => void run("Store memory", async () => {
            const result = await bbApi(`/assistants/${encodeURIComponent(ctx!.assistantId!)}/memories`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: storeText.trim(), metadata: { source: "dev-panel" } }),
            });
            setStoreText("");
            return result;
          })}
          style={{
            ...btnBase, width: "100%", marginTop: "6px",
            background: storeText.trim() && ctx?.assistantId ? "#fff" : "rgba(255,255,255,0.06)",
            color: storeText.trim() && ctx?.assistantId ? "#000" : TEXT_FAINT,
          }}
        >
          <Plus size={11} /> Store
        </button>
      </div>

      {/* Search memories */}
      <div>
        <span style={labelStyle}>Search Memories</span>
        <div style={{ display: "flex", gap: "6px" }}>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Semantic search query…"
            style={{ ...inputStyle, flex: 1 }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searchQuery.trim() && ctx?.assistantId) {
                void run("Search memories", async () => {
                  return bbApi(`/assistants/${encodeURIComponent(ctx!.assistantId!)}/memories/search`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ query: searchQuery.trim(), limit: 5 }),
                  });
                });
              }
            }}
          />
          <button
            disabled={busy || !searchQuery.trim() || !ctx?.assistantId}
            onClick={() => void run("Search memories", async () => {
              return bbApi(`/assistants/${encodeURIComponent(ctx!.assistantId!)}/memories/search`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: searchQuery.trim(), limit: 5 }),
              });
            })}
            style={{
              ...btnBase,
              background: searchQuery.trim() ? "rgba(96,165,250,0.15)" : "rgba(255,255,255,0.04)",
              color: searchQuery.trim() ? "#60a5fa" : TEXT_FAINT,
              border: `1px solid ${searchQuery.trim() ? "rgba(96,165,250,0.3)" : BORDER_FAINT}`,
            }}
          >
            <Search size={11} />
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Session Tab ─────────────────────────────────────────────────────────────────

const SessionTab: FC<TabProps> = ({ log, run, busy }) => {
  const [mockTranscript, setMockTranscript] = useState(
    "Q: Tell me about yourself.\nA: I have five years of experience in full-stack development, specializing in React and Node.js."
  );
  const [practiceFocus, setPracticeFocus] = useState("");
  const ctx = readContext();
  const resumeInfo = ctx?.resume || ctx?.pendingResume;

  return (
    <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
      {!ctx?.assistantId && (
        <div style={{ fontSize: "11px", color: "#fbbf24", background: "rgba(251,191,36,0.1)", padding: "8px 10px", border: "1px solid rgba(251,191,36,0.2)" }}>
          <AlertCircle size={11} style={{ display: "inline", marginRight: "4px" }} /> Create an assistant first
        </div>
      )}

      {/* Start session */}
      <div>
        <span style={labelStyle}>Start Session (Prep)</span>
        <div style={{ fontSize: "10px", color: TEXT_DIM, marginBottom: "6px" }}>
          Calls Backboard's startSession — retrieves resume + memories via RAG and generates an opening question.
        </div>
        <input
          value={practiceFocus}
          onChange={(e) => setPracticeFocus(e.target.value)}
          placeholder="Practice focus (optional)…"
          style={{ ...inputStyle, marginBottom: "6px" }}
        />
        <button
          disabled={busy || !ctx?.assistantId}
          onClick={() => void run("Start session", async () => {
            const body: Record<string, string> = {};
            if (resumeInfo?.documentId) body.resumeDocumentId = resumeInfo.documentId;
            if (practiceFocus.trim()) body.practiceFocus = practiceFocus.trim();
            return bbApi(`/assistants/${encodeURIComponent(ctx!.assistantId!)}/sessions/start`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
          })}
          style={{
            ...btnBase, width: "100%",
            background: ctx?.assistantId ? "rgba(34,197,94,0.15)" : "rgba(255,255,255,0.04)",
            color: ctx?.assistantId ? "#4ade80" : TEXT_FAINT,
            border: `1px solid ${ctx?.assistantId ? "rgba(34,197,94,0.3)" : BORDER_FAINT}`,
          }}
        >
          <Play size={11} /> Start Session
        </button>
      </div>

      {/* End session */}
      <div>
        <span style={labelStyle}>End Session (After)</span>
        <div style={{ fontSize: "10px", color: TEXT_DIM, marginBottom: "6px" }}>
          Sends a transcript to Backboard for memory extraction and retrospective feedback.
        </div>
        <textarea
          value={mockTranscript}
          onChange={(e) => setMockTranscript(e.target.value)}
          rows={4}
          style={{ ...inputStyle, resize: "vertical" as const }}
        />
        <button
          disabled={busy || !ctx?.assistantId || !mockTranscript.trim()}
          onClick={() => void run("End session", async () => {
            return bbApi(`/assistants/${encodeURIComponent(ctx!.assistantId!)}/sessions/complete`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                sessionId: `dev-${Date.now()}`,
                transcriptText: mockTranscript.trim(),
                summaryText: "Dev panel test session — mock transcript submitted for memory extraction.",
              }),
            });
          })}
          style={{
            ...btnBase, width: "100%", marginTop: "6px",
            background: ctx?.assistantId && mockTranscript.trim() ? "rgba(239,68,68,0.12)" : "rgba(255,255,255,0.04)",
            color: ctx?.assistantId && mockTranscript.trim() ? "#f87171" : TEXT_FAINT,
            border: `1px solid ${ctx?.assistantId && mockTranscript.trim() ? "rgba(239,68,68,0.25)" : BORDER_FAINT}`,
          }}
        >
          <AlertCircle size={11} /> End Session + Extract
        </button>
      </div>
    </div>
  );
};

// ── Status Tab ──────────────────────────────────────────────────────────────────

const StatusTab: FC<TabProps> = ({ log, run, busy }) => {
  const [services, setServices] = useState<{ name: string; status: string }[] | null>(null);

  return (
    <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
      <button
        disabled={busy}
        onClick={() => void run("Check services", async () => {
          const result = await servicesApi<{ services: { name: string; status: string }[] }>("/");
          setServices(result.services);
          return result;
        })}
        style={{
          ...btnBase, width: "100%",
          background: "rgba(96,165,250,0.15)",
          color: "#60a5fa",
          border: "1px solid rgba(96,165,250,0.3)",
        }}
      >
        <RefreshCw size={11} /> Check All Services
      </button>

      {services && (
        <div style={{ background: INPUT_BG, border: `1px solid ${BORDER_FAINT}`, overflow: "hidden" }}>
          {services.map((s, i) => (
            <div
              key={s.name}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 10px",
                borderBottom: i < services.length - 1 ? `1px solid ${BORDER_FAINT}` : "none",
                fontSize: "11px",
              }}
            >
              <span style={{ color: TEXT_COLOR, textTransform: "capitalize" as const }}>{s.name}</span>
              <span
                style={{
                  fontSize: "10px",
                  padding: "2px 7px",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase" as const,
                  background: s.status === "configured" ? "rgba(34,197,94,0.15)" : "rgba(251,191,36,0.1)",
                  color: s.status === "configured" ? "#4ade80" : "#fbbf24",
                }}
              >
                {s.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Health check */}
      <button
        disabled={busy}
        onClick={() => void run("Health check", async () => {
          const res = await fetch(`${API_BASE}/health`);
          return res.json();
        })}
        style={{
          ...btnBase, width: "100%",
          background: "rgba(255,255,255,0.04)",
          color: TEXT_DIM,
          border: `1px solid ${BORDER_FAINT}`,
        }}
      >
        <Activity size={11} /> Health Check
      </button>

      {/* Env info */}
      <div>
        <span style={labelStyle}>Environment</span>
        <div style={{ background: INPUT_BG, border: `1px solid ${BORDER_FAINT}`, padding: "8px 10px", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", color: TEXT_DIM }}>
          <div>API_BASE: {API_BASE}</div>
          <div>MODE: {import.meta.env.MODE}</div>
          <div>DEV: {String(import.meta.env.DEV)}</div>
        </div>
      </div>
    </div>
  );
};

export default BackboardDevPanel;
