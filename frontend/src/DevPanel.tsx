import { useState, FC } from "react";
import { Terminal, X, Mic, MicOff, ChevronDown, ChevronUp, Square } from "lucide-react";
import { ConversationControls } from "./useConversation";

interface DevPanelProps {
  conversation: ConversationControls;
}

const QUICK_PHRASES = [
  "Hi, I'm ready to start the interview.",
  "I have five years of experience in software engineering.",
  "My greatest strength is being a fast learner and adapting quickly.",
  "I'd say my weakness is sometimes taking on too much at once.",
  "I'm really excited about this role because of the team culture.",
  "Do you have any questions for me about the position?",
];

/**
 * DevPanel — floating developer tools for testing the voice conversation loop.
 * Only rendered in Vite dev mode (import.meta.env.DEV).
 */
export const DevPanel: FC<DevPanelProps> = ({ conversation }) => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(true);

  if (!import.meta.env.DEV) return null;

  const { listening, aiSpeaking, error, startListening, stopListening, sendMessage, cancelAudio } = conversation;

  const status = error ? "Error" : aiSpeaking ? "Speaking…" : listening ? "Listening…" : "Idle";
  const statusColor = error ? "#f87171" : aiSpeaking ? "#4ade80" : listening ? "#60a5fa" : "#52525b";
  const statusBg = error
    ? "rgba(239,68,68,0.15)"
    : aiSpeaking
    ? "rgba(34,197,94,0.15)"
    : listening
    ? "rgba(96,165,250,0.15)"
    : "rgba(255,255,255,0.06)";

  return (
    <div
      style={{
        position: "fixed",
        bottom: "1rem",
        right: "1rem",
        zIndex: 9999,
        fontFamily: "'Sora', 'JetBrains Mono', monospace",
        fontSize: "12px",
      }}
    >
      {/* Toggle button */}
      <button
        onClick={() => setOpen((o) => !o)}
        title="Toggle dev tools"
        style={{
          position: "absolute",
          bottom: 0,
          right: 0,
          width: "40px",
          height: "40px",
          background: open ? "#18181b" : "#27272a",
          border: "1px solid rgba(255,255,255,0.18)",
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
        <Terminal size={16} />
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "48px",
            right: 0,
            width: "340px",
            background: "#09090b",
            border: "1px solid rgba(255,255,255,0.14)",
            boxShadow: "0 8px 40px rgba(0,0,0,0.8)",
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
              borderBottom: "1px solid rgba(255,255,255,0.1)",
              background: "#111113",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "#71717a" }}>
              <Terminal size={12} />
              <span style={{ textTransform: "uppercase", letterSpacing: "0.12em", fontSize: "10px" }}>
                Dev Tools — Conversation
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span
                style={{
                  fontSize: "10px",
                  padding: "2px 7px",
                  background: statusBg,
                  color: statusColor,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
              >
                {status}
              </span>
              <button
                onClick={() => setOpen(false)}
                style={{ background: "none", border: "none", color: "#52525b", cursor: "pointer", padding: "2px", display: "flex" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#fff")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#52525b")}
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {/* Error display */}
          {error && (
            <div style={{ padding: "8px 12px", background: "rgba(239,68,68,0.08)", color: "#f87171", fontSize: "11px", borderBottom: "1px solid rgba(239,68,68,0.15)" }}>
              {error}
            </div>
          )}



          {/* Mic controls */}
          <div style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", gap: "6px" }}>
            <button
              id="dev-mic-start-btn"
              disabled={listening || aiSpeaking}
              onClick={() => void startListening()}
              style={{
                flex: 1,
                padding: "7px 0",
                background: !listening && !aiSpeaking ? "rgba(96,165,250,0.15)" : "rgba(255,255,255,0.04)",
                color: !listening && !aiSpeaking ? "#60a5fa" : "#52525b",
                border: `1px solid ${!listening && !aiSpeaking ? "rgba(96,165,250,0.3)" : "rgba(255,255,255,0.08)"}`,
                cursor: !listening && !aiSpeaking ? "pointer" : "not-allowed",
                fontFamily: "inherit",
                fontSize: "11px",
                fontWeight: 600,
                letterSpacing: "0.06em",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "5px",
              }}
            >
              <Mic size={12} /> {listening ? "Listening…" : "Start Mic"}
            </button>
            <button
              id="dev-mic-stop-btn"
              disabled={!listening && !aiSpeaking}
              onClick={() => { stopListening(); cancelAudio(); }}
              style={{
                flex: 1,
                padding: "7px 0",
                background: (listening || aiSpeaking) ? "rgba(239,68,68,0.12)" : "rgba(255,255,255,0.04)",
                color: (listening || aiSpeaking) ? "#f87171" : "#52525b",
                border: `1px solid ${(listening || aiSpeaking) ? "rgba(239,68,68,0.25)" : "rgba(255,255,255,0.08)"}`,
                cursor: (listening || aiSpeaking) ? "pointer" : "not-allowed",
                fontFamily: "inherit",
                fontSize: "11px",
                fontWeight: 600,
                letterSpacing: "0.06em",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "5px",
              }}
            >
              <Square size={11} /> Stop
            </button>
          </div>

          {/* Manual text input */}
          <div style={{ padding: "12px" }}>
            <label style={{ color: "#52525b", display: "block", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.1em", fontSize: "10px" }}>
              Inject Mock Transcript
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type to send directly through Gemini → TTS…"
              rows={3}
              style={{
                width: "100%",
                background: "#18181b",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#e4e4e7",
                padding: "8px 10px",
                fontSize: "12px",
                resize: "vertical",
                outline: "none",
                boxSizing: "border-box",
                fontFamily: "inherit",
              }}
              onFocus={(e) => ((e.currentTarget as HTMLTextAreaElement).style.borderColor = "rgba(255,255,255,0.3)")}
              onBlur={(e) => ((e.currentTarget as HTMLTextAreaElement).style.borderColor = "rgba(255,255,255,0.1)")}
            />
            <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
              <button
                id="dev-send-btn"
                disabled={!text.trim() || aiSpeaking}
                onClick={() => { sendMessage(text); setText(""); }}
                style={{
                  flex: 1,
                  padding: "7px 0",
                  background: text.trim() && !aiSpeaking ? "#fff" : "rgba(255,255,255,0.06)",
                  color: text.trim() && !aiSpeaking ? "#000" : "#52525b",
                  border: "none",
                  cursor: text.trim() && !aiSpeaking ? "pointer" : "not-allowed",
                  fontFamily: "inherit",
                  fontSize: "11px",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "5px",
                }}
              >
                <Mic size={12} /> Send via Gemini
              </button>
              <button
                id="dev-cancel-btn"
                disabled={!aiSpeaking}
                onClick={cancelAudio}
                style={{
                  padding: "7px 12px",
                  background: aiSpeaking ? "rgba(239,68,68,0.12)" : "rgba(255,255,255,0.04)",
                  color: aiSpeaking ? "#f87171" : "#52525b",
                  border: `1px solid ${aiSpeaking ? "rgba(239,68,68,0.25)" : "rgba(255,255,255,0.08)"}`,
                  cursor: aiSpeaking ? "pointer" : "not-allowed",
                  fontFamily: "inherit",
                  fontSize: "11px",
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: "5px",
                }}
              >
                <MicOff size={12} /> Cancel
              </button>
            </div>
          </div>

          {/* Quick phrases */}
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
            <button
              onClick={() => setExpanded((e) => !e)}
              style={{
                width: "100%",
                background: "none",
                border: "none",
                padding: "8px 12px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                color: "#52525b",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: "10px",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#a1a1aa")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#52525b")}
            >
              Quick phrases {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>

            {expanded && (
              <div style={{ maxHeight: "180px", overflowY: "auto", padding: "0 8px 8px" }}>
                {QUICK_PHRASES.map((phrase, i) => (
                  <button
                    key={i}
                    onClick={() => sendMessage(phrase)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: "none",
                      border: "1px solid transparent",
                      padding: "6px 8px",
                      color: "#71717a",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: "11px",
                      lineHeight: 1.4,
                      marginBottom: "2px",
                    }}
                    onMouseEnter={(e) => {
                      const el = e.currentTarget as HTMLButtonElement;
                      el.style.background = "rgba(255,255,255,0.05)";
                      el.style.color = "#e4e4e7";
                      el.style.borderColor = "rgba(255,255,255,0.1)";
                    }}
                    onMouseLeave={(e) => {
                      const el = e.currentTarget as HTMLButtonElement;
                      el.style.background = "none";
                      el.style.color = "#71717a";
                      el.style.borderColor = "transparent";
                    }}
                  >
                    "{phrase}"
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default DevPanel;
