import { useEffect, useRef, useState } from "react";
import { Camera, ChevronDown, Eye, EyeOff, RefreshCw } from "lucide-react";
import { getPreferredCameraDeviceId, setPreferredCameraDeviceId } from "./cameraDevicePrefs";

type Status = "idle" | "requesting" | "denied" | "error";

function messageForError(err: unknown): { status: "denied" | "error"; message: string } {
  const name = err instanceof DOMException ? err.name : undefined;
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return { status: "denied", message: "Camera access was blocked. Allow it in your browser or system privacy settings, then try again." };
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return { status: "error", message: "That camera couldn't be started — it may be in use by another app." };
  }
  return { status: "error", message: err instanceof Error ? err.message : "Couldn't start that camera." };
}

/**
 * Settings-page counterpart to CameraPermissionStep (which runs this same
 * enumerate/permission/pick flow inline at the start of calibration). This
 * one is for picking a default ahead of time, with a live preview to
 * confirm it's the right one -- the choice is shared with calibration via
 * cameraDevicePrefs (localStorage), so whichever one you set here is
 * already selected next time calibration runs, and vice versa.
 */
export function CameraDeviceSetting() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [permitted, setPermitted] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(() => getPreferredCameraDeviceId() || "");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [previewOn, setPreviewOn] = useState(false);
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [] as MediaDeviceInfo[];
    const list = await navigator.mediaDevices.enumerateDevices();
    const cams = list.filter((d) => d.kind === "videoinput");
    setDevices(cams);
    if (cams.length && cams.some((d) => d.label)) setPermitted(true);
    return cams;
  }

  useEffect(() => {
    refreshDevices().catch(() => {});
  }, []);

  useEffect(() => {
    previewStreamRef.current = previewStream;
  }, [previewStream]);

  // Stop whatever camera is live the moment this settings panel goes away
  // — nothing here should keep the camera light on after you've navigated
  // off the page.
  useEffect(() => {
    return () => {
      previewStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = previewStream;
  }, [previewStream]);

  function stopPreview() {
    previewStreamRef.current?.getTracks().forEach((t) => t.stop());
    setPreviewStream(null);
    setPreviewOn(false);
  }

  async function startPreview(deviceId: string) {
    previewStreamRef.current?.getTracks().forEach((t) => t.stop());
    setPreviewStream(null);
    setStatus("requesting");
    setMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" },
        audio: false,
      });
      setPreviewStream(stream);
      setPreviewOn(true);
      setStatus("idle");
      const actualId = stream.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId;
      if (actualId) {
        setSelectedDeviceId(actualId);
        setPreferredCameraDeviceId(actualId);
      }
      await refreshDevices();
    } catch (err) {
      console.error("Camera preview failed:", err);
      const { status: s, message: m } = messageForError(err);
      setStatus(s);
      setMessage(m);
    }
  }

  function choose(deviceId: string) {
    setSelectedDeviceId(deviceId);
    setPreferredCameraDeviceId(deviceId);
    if (previewOn) void startPreview(deviceId);
  }

  const noCamera = permitted && devices.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-white/50" style={{ fontWeight: 300 }}>
        Choose which camera calibration and sessions use by default. You can still pick a different one from the
        calibration screen any time.
      </p>

      {message && <p className="text-[13px] text-red-300">{message}</p>}

      {!permitted ? (
        <button
          onClick={() => void startPreview(selectedDeviceId)}
          disabled={status === "requesting"}
          className="flex w-fit items-center gap-2 border border-white/20 text-[13px] font-semibold px-4 h-10 rounded-none transition-colors hover:border-white/50 disabled:opacity-40"
        >
          <Camera className="h-4 w-4" strokeWidth={1.8} />
          {status === "requesting" ? "Requesting access…" : "Grant camera access"}
        </button>
      ) : noCamera ? (
        <div className="flex items-center gap-3 text-[13px] text-white/40">
          <Camera className="h-4 w-4" strokeWidth={1.6} />
          No camera was detected on this computer.
          <button
            onClick={() => void refreshDevices()}
            className="flex items-center gap-1.5 text-white/60 transition-colors hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} /> Check again
          </button>
        </div>
      ) : (
        <>
          <label className="flex flex-col gap-2">
            <span className="text-[12px] uppercase tracking-[0.14em] text-white/40">Camera</span>
            <div className="relative max-w-sm">
              <select
                value={selectedDeviceId}
                onChange={(event) => choose(event.target.value)}
                className="h-11 w-full appearance-none border border-white/20 bg-transparent px-3 pr-9 text-[14px] text-white outline-none focus:border-white/60"
              >
                {devices.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId} className="bg-black">
                    {d.label || `Camera ${i + 1}`}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" strokeWidth={1.8} />
            </div>
          </label>

          <button
            onClick={() => (previewOn ? stopPreview() : void startPreview(selectedDeviceId))}
            className="flex w-fit items-center gap-2 border border-white/20 text-[13px] font-semibold px-4 h-10 rounded-none transition-colors hover:border-white/50"
          >
            {previewOn ? <EyeOff className="h-4 w-4" strokeWidth={1.8} /> : <Eye className="h-4 w-4" strokeWidth={1.8} />}
            {previewOn ? "Stop preview" : "Test camera"}
          </button>

          {previewOn && (
            <div className="relative h-40 w-64 overflow-hidden border border-white/12 bg-white/[0.02]">
              <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" style={{ transform: "scaleX(-1)" }} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default CameraDeviceSetting;
