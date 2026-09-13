import { useEffect, useRef } from "react";

export function CalibrationDelayAlert({ open, missing, onDismiss, onCancel }: {
  open: boolean;
  missing: { label: string; reason: string }[];
  onDismiss: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={dialogRef} aria-labelledby="calibration-delay-title"
      onCancel={(event) => { event.preventDefault(); onDismiss(); }}
      className="m-auto w-[calc(100%_-_3rem)] max-w-lg max-h-[85vh] overflow-y-auto border border-amber-300/40 bg-black p-6 text-white shadow-2xl backdrop:bg-black/80">
      <h2 id="calibration-delay-title" className="text-2xl font-bold">
        Calibrations are taking longer than usual.
      </h2>
      <p className="mt-4 text-sm leading-relaxed text-white/70">
        This session has reached 90 seconds, and not all baseline calibrations are complete.
        We will keep waiting for the missing readings. An incomplete baseline will not be saved.
      </p>
      <ul className="mt-4 space-y-3">
        {missing.map(({ label, reason }) => (
          <li key={label}>
            <p className="text-sm font-semibold">{label}</p>
            <p className="text-xs leading-relaxed text-white/60">{reason}</p>
          </li>
        ))}
      </ul>
      <div className="mt-6 flex flex-wrap gap-4">
        <button autoFocus onClick={onDismiss} className="h-11 bg-white px-5 text-sm font-semibold text-black">Keep waiting</button>
        <button onClick={onCancel} className="text-sm text-white/70">Cancel calibration</button>
      </div>
    </dialog>
  );
}
