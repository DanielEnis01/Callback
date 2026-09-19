import { forwardRef } from "react";
import type { Ref } from "react";
import { Camera } from "lucide-react";
import { useCamera } from "./useCamera";

interface CameraFeedProps {
  /** Set false to release the camera without unmounting the panel. */
  active?: boolean;
  /** Mirror the feed, like a normal front-facing camera preview. */
  mirrored?: boolean;
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") ref(node);
      else (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

/**
 * Live webcam feed, meant to fill an absolutely-positioned parent
 * (`relative` + `overflow-hidden`) — see CalibrationSession / SessionMeeting.
 */
export const CameraFeed = forwardRef<HTMLVideoElement, CameraFeedProps>(function CameraFeed(
  { active = true, mirrored = true },
  forwardedRef,
) {
  const { videoRef, ready, error } = useCamera(active);

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 text-white/25 px-6 text-center">
        <Camera className="h-8 w-8" strokeWidth={1.4} />
        <span className="text-[12px] uppercase tracking-[0.16em]">Camera unavailable</span>
        <span className="text-[11px] normal-case text-white/20">{error}</span>
      </div>
    );
  }

  return (
    <>
      <video
        ref={mergeRefs(videoRef, forwardedRef)}
        autoPlay
        playsInline
        muted
        // object-contain (not cover) so the full frame is visible instead of
        // cropped/zoomed to fill — cropping was making it hard to fit both face
        // and chest in frame, especially in the taller calibration panel.
        className="absolute inset-0 h-full w-full object-contain"
        style={mirrored ? { transform: "scaleX(-1)" } : undefined}
      />
      {!ready && (
        <div className="relative flex flex-col items-center gap-2 text-white/25">
          <Camera className="h-8 w-8" strokeWidth={1.4} />
          <span className="text-[12px] uppercase tracking-[0.16em]">Starting camera…</span>
        </div>
      )}
    </>
  );
});

export default CameraFeed;
