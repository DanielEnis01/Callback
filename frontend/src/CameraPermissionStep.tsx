import { useEffect, useRef, useState } from "react";
import { Camera, ChevronDown, Loader2, RefreshCw, X } from "lucide-react";
import { getPreferredCameraDeviceId, setPreferredCameraDeviceId } from "./cameraDevicePrefs";

interface CameraPermissionStepProps {
  /** Called once a camera stream has been acquired and is ready to hand off. */
  onReady: (stream: MediaStream) => void;
  onCancel: () => void;
}

type Status =
  | "checking-devices" // enumerating devices, no prompt shown yet
  | "no-camera" // enumerateDevices() found zero video inputs
  | "idle" // at least one camera found, waiting on the user to click "Allow"
  | "requesting" // getUserMedia() in flight
  | "denied" // NotAllowedError / SecurityError
  | "error" // any other getUserMedia failure (NotReadableError, etc.)
  | "ready"; // stream acquired, handed off via onReady

function messageForError(err: unknown): { status: "denied" | "no-camera" | "error"; message: string } {
  const name = err instanceof DOMException ? err.name : undefined;
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return {
      status: "denied",
      message:
        "Camera access was blocked. Allow camera access for Callback in your browser or system privacy settings, then try again.",
    };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return {
      status: "no-camera",
      message: "No camera could be found. Connect a camera and try again.",
    };
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return {
      status: "error",
      message:
        "The camera couldn't be started — it may already be in use by another app (Zoom, another browser tab, etc.) or blocked by your OS's camera privacy setting. Close other apps using the camera and try again.",
    };
  }
  return {
    status: "error",
    message: err instanceof Error ? err.message : "Something went wrong while starting the camera.",
  };
}

/**
 * Runs before calibration ever touches SmartSpectra: detects whether a
 * camera exists at all, asks for permission via an explicit user gesture
 * (rather than silently calling getUserMedia the instant the calibration
 * screen mounts, which is what used to happen — and which just failed
 * outright with a raw "NotReadableError" on machines with no camera,
 * never explaining why or offering a way to pick a different device),
 * and lets the user choose which camera to use when more than one is
 * available. Hands the acquired MediaStream up to CalibrationSession,
 * which passes it into useCalibrationSession via SmartSpectraSDK's
 * useMediaStream() override so the SDK never does its own camera
 * acquisition.
 */
export function CameraPermissionStep({ onReady, onCancel }: CameraPermissionStepProps) {
  const [status, setStatus] = useState<Status>("checking-devices");
  const [message, setMessage] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(() => getPreferredCameraDeviceId() || "");
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // On mount, just look at what's plugged in — this does not prompt for
  // permission (enumerateDevices() alone never does), so a machine with no
  // camera at all can skip straight to a clear "no camera" message instead
  // of showing an "Allow camera access" button that's guaranteed to fail.
  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setStatus("error");
      setMessage("This app can't access the camera in this environment.");
      return;
    }
    navigator.mediaDevices
      .enumerateDevices()
      .then((list) => {
        if (cancelledRef.current) return;
        const cams = list.filter((d) => d.kind === "videoinput");
        if (cams.length === 0) {
          setStatus("no-camera");
          setMessage("No camera was detected on this computer. Connect a camera and try again.");
        } else {
          setDevices(cams);
          setStatus("idle");
        }
      })
      .catch(() => {
        if (cancelledRef.current) return;
        // Some platforms refuse to enumerate at all pre-permission; fall
        // back to letting the user try the permission prompt directly
        // rather than dead-ending here.
        setStatus("idle");
      });
  }, []);

  async function requestCamera(deviceId?: string) {
    setStatus("requesting");
    setMessage(null);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" },
        audio: false,
      });
      if (cancelledRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      // Labels are blank until permission is granted — re-enumerate now
      // that it has been, so the picker shows real camera names instead of
      // "Camera 1" / "Camera 2".
      const list = await navigator.mediaDevices.enumerateDevices();
      const cams = list.filter((d) => d.kind === "videoinput");
      if (cams.length) setDevices(cams);
      const actualId = stream.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId ?? "";
      if (actualId) {
        setSelectedDeviceId(actualId);
        setPreferredCameraDeviceId(actualId);
      }

      setStatus("ready");
      onReady(stream);
    } catch (err) {
      if (cancelledRef.current) return;
      console.error("Camera permission/start failed:", err);
      const { status: s, message: m } = messageForError(err);
      setStatus(s);
      setMessage(m);
    }
  }

  function switchDevice(deviceId: string) {
    setSelectedDeviceId(deviceId);
    void requestCamera(deviceId);
  }

  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-8">
      <div className="w-full max-w-md flex flex-col items-center gap-6 text-center">
        <span className="flex h-14 w-14 items-center justify-center border border-white/25 text-white/70">
          {status === "checking-devices" || status === "requesting" ? (
            <Loader2 className="h-6 w-6 animate-spin" strokeWidth={1.6} />
          ) : (
            <Camera className="h-6 w-6" strokeWidth={1.6} />
          )}
        </span>

        <div className="flex flex-col gap-2">
          <h1 className="text-[24px] font-800 tracking-tight" style={{ fontWeight: 800 }}>
            {status === "ready" ? "Camera ready" : "Turn on your camera"}
          </h1>
          <p className="text-[14px] leading-relaxed text-white/55" style={{ fontWeight: 300 }}>
            {status === "checking-devices" && "Looking for a camera…"}
            {status === "idle" && "Calibration needs your camera to measure pulse and breathing from your video."}
            {status === "requesting" && "Waiting for camera permission…"}
            {status === "ready" && "Starting calibration…"}
            {(status === "no-camera" || status === "denied" || status === "error") && message}
          </p>
        </div>

        {status === "idle" && devices.length > 0 && (
          <button
            onClick={() => void requestCamera(selectedDeviceId || getPreferredCameraDeviceId() || undefined)}
            className="flex items-center gap-2 bg-white text-black text-[13px] font-semibold px-5 h-11 rounded-none transition-opacity active:opacity-70"
          >
            Allow camera access
          </button>
        )}

        {(status === "denied" || status === "error") && (
          <button
            onClick={() => void requestCamera(selectedDeviceId || undefined)}
            className="flex items-center gap-2 border border-white/20 text-white text-[13px] font-semibold px-5 h-11 rounded-none transition-colors hover:border-white/50"
          >
            <RefreshCw className="h-4 w-4" strokeWidth={1.8} /> Try again
          </button>
        )}

        {status === "no-camera" && (
          <button
            onClick={() => {
              setStatus("checking-devices");
              navigator.mediaDevices
                ?.enumerateDevices()
                .then((list) => {
                  const cams = list.filter((d) => d.kind === "videoinput");
                  if (cams.length === 0) {
                    setStatus("no-camera");
                    setMessage("Still no camera detected. Connect a camera and try again.");
                  } else {
                    setDevices(cams);
                    setStatus("idle");
                  }
                })
                .catch(() => setStatus("no-camera"));
            }}
            className="flex items-center gap-2 border border-white/20 text-white text-[13px] font-semibold px-5 h-11 rounded-none transition-colors hover:border-white/50"
          >
            <RefreshCw className="h-4 w-4" strokeWidth={1.8} /> Check again
          </button>
        )}

        {devices.length > 1 && (status === "idle" || status === "ready") && (
          <label className="flex w-full flex-col gap-2 text-left">
            <span className="text-[12px] uppercase tracking-[0.14em] text-white/40">Camera</span>
            <div className="relative">
              <select
                value={selectedDeviceId}
                onChange={(event) => switchDevice(event.target.value)}
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
        )}

        <button
          onClick={onCancel}
          className="flex items-center gap-2 border border-white/20 text-white text-[13px] font-semibold px-4 h-11 rounded-none transition-colors hover:border-white/50"
        >
          <X className="h-4 w-4" strokeWidth={1.8} /> Cancel
        </button>
      </div>
    </div>
  );
}

export default CameraPermissionStep;
