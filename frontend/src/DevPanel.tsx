import { useState, FC } from "react";
import { Terminal, X, Mic, MicOff, ChevronDown, ChevronUp } from "lucide-react";
import { TTSControls } from "./useTTS";

interface DevPanelProps {
  tts: TTSControls;
}

const QUICK_PHRASES = [
  "Welcome to your mock interview. Let's get started — tell me about yourself.",
  "That's a great answer. Now, what would you say is your greatest weakness?",
  "Interesting perspective. Where do you see yourself in five years?",
  "Can you walk me through a time you faced a difficult challenge at work?",
  "Why are you interested in this role specifically?",
  "Do you have any questions for me about the position or the company?",
];

/**
 * DevPanel — floating developer tools for testing TTS during a session.
 * Only rendered in Vite dev mode (import.meta.env.DEV).
 */
export const DevPanel: FC<DevPanelProps> = ({ tts }) => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(true);

  if (!import.meta.env.DEV) return null;

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
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = "#fff";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = "#a1a1aa";
        }}
      >
        <Terminal size={16} />
      </button>

      {/* Panel */}
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
                Dev Tools — TTS
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              {/* Status badge */}
              <span
                style={{
                  fontSize: "10px",
                  padding: "2px 7px",
                  borderRadius: "2px",
                  background: tts.error
                    ? "rgba(239,68,68,0.15)"
                    : tts.speaking
                    ? "rgba(34,197,94,0.15)"
                    : "rgba(255,255,255,0.06)",
                  color: tts.error ? "#f87171" : tts.speaking ? "#4ade80" : "#52525b",
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
              >
                {tts.error ? "Error" : tts.speaking ? "Speaking…" : "Idle"}
              </span>
              <button
                onClick={() => setOpen(false)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#52525b",
                  cursor: "pointer",
                  padding: "2px",
                  display: "flex",
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#fff")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "#52525b")}
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {/* Error display */}
          {tts.error && (
            <div
              style={{
                padding: "8px 12px",
                background: "rgba(239,68,68,0.08)",
                color: "#f87171",
                fontSize: "11px",
                borderBottom: "1px solid rgba(239,68,68,0.15)",
              }}
            >
              {tts.error}
            </div>
          )}

          {/* Mock transcript input */}
          <div style={{ padding: "12px" }}>
            <label style={{ color: "#52525b", display: "block", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.1em", fontSize: "10px" }}>
              Mock Transcript
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type transcript text to synthesize…"
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

            {/* Actions */}
            <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
              <button
                id="dev-tts-speak-btn"
                disabled={!text.trim() || tts.speaking}
                onClick={() => tts.speak(text)}
                style={{
                  flex: 1,
                  padding: "7px 0",
                  background: text.trim() && !tts.speaking ? "#fff" : "rgba(255,255,255,0.06)",
                  color: text.trim() && !tts.speaking ? "#000" : "#52525b",
                  border: "none",
                  cursor: text.trim() && !tts.speaking ? "pointer" : "not-allowed",
                  fontFamily: "inherit",
                  fontSize: "11px",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "5px",
                  transition: "background 0.15s, color 0.15s",
                }}
              >
                <Mic size={12} /> Speak
              </button>
              <button
                id="dev-tts-cancel-btn"
                disabled={!tts.speaking}
                onClick={tts.cancel}
                style={{
                  flex: 1,
                  padding: "7px 0",
                  background: tts.speaking ? "rgba(239,68,68,0.15)" : "rgba(255,255,255,0.04)",
                  color: tts.speaking ? "#f87171" : "#52525b",
                  border: `1px solid ${tts.speaking ? "rgba(239,68,68,0.3)" : "rgba(255,255,255,0.08)"}`,
                  cursor: tts.speaking ? "pointer" : "not-allowed",
                  fontFamily: "inherit",
                  fontSize: "11px",
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "5px",
                  transition: "background 0.15s, color 0.15s",
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
              Quick phrases
              {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>

            {expanded && (
              <div
                style={{
                  maxHeight: "180px",
                  overflowY: "auto",
                  padding: "0 8px 8px",
                }}
              >
                {QUICK_PHRASES.map((phrase, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setText(phrase);
                      tts.speak(phrase);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: "none",
                      border: "1px solid transparent",
                      borderRadius: "2px",
                      padding: "6px 8px",
                      color: "#71717a",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: "11px",
                      lineHeight: 1.4,
                      marginBottom: "2px",
                      transition: "background 0.1s, color 0.1s, border-color 0.1s",
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
