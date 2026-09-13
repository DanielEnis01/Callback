import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { useCalibrationSession } from "./useCalibrationSession";

function Check() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const session = useCalibrationSession(true, true, size);
  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.srcObject = session.stream;
    session.stream && videoRef.current.play().catch(() => {});
  }, [session.stream]);
  return <main className="min-h-screen bg-black p-8 text-white">
    <h1 className="text-2xl font-bold">SmartSpectra recovery check</h1>
    <dl className="mt-6 space-y-2 text-sm">
      <div>Status: <output>{session.status}</output></div>
      <div>Error: <output>{session.error ?? "none"}</output></div>
      <div>Pipeline: <output>{session.pipelineHint ?? "none"}</output></div>
      <div>Validation: <output>{session.validationHint ?? "none"}</output></div>
      <div>Camera quality: <output>{session.cameraQualityHint ?? "acceptable"}</output></div>
      <div>Samples: <output>{session.samplesRef.current.length}</output></div>
    </dl>
    <video ref={videoRef} muted playsInline className="mt-6 max-h-96 max-w-xl" onLoadedMetadata={(event) => {
      const video = event.currentTarget;
      setSize({ width: video.videoWidth, height: video.videoHeight });
    }} />
  </main>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Check />);
