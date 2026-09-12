import { useEffect, useRef, useState } from "react";

/**
 * Requests the user's webcam and attaches the resulting stream to a
 * <video> element via videoRef. Stops the stream on unmount / when
 * `active` goes false, so the camera light actually turns off between
 * sessions instead of staying pinned on.
 */
export function useCamera(active: boolean = true) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setReady(false);
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
        }
        setReady(true);
      })
      .catch((err) => {
        console.error("Camera access failed:", err);
        setError(err instanceof Error ? err.message : "Camera access failed");
      });

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [active]);

  return { videoRef, ready, error };
}
