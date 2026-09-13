import { describe, expect, it } from "vitest";
import { liveMonitorKeysForTarget } from "./liveTraitMonitors";

describe("liveMonitorKeysForTarget", () => {
  it.each(["Eye Contact", "Weak eye contact", "poor EYE CONTACT"]) (
    "shows the MediaPipe eye-contact percentage for %s",
    (target) => expect(liveMonitorKeysForTarget(target)).toEqual(["Eye Contact"]),
  );

  it.each(["Posture Stability", "Fidgeting / posture shifts", "Excessive fidgeting"]) (
    "shows the MediaPipe fidgeting/stability state for %s",
    (target) => expect(liveMonitorKeysForTarget(target)).toEqual(["Posture"]),
  );

  it("shows both visual signals for the broader Body Language trait", () => {
    expect(liveMonitorKeysForTarget("Body Language")).toEqual(["Eye Contact", "Posture"]);
  });

  it("does not attach unrelated camera data to a text-only skill", () => {
    expect(liveMonitorKeysForTarget("Answer Structure")).toBeNull();
  });
});
