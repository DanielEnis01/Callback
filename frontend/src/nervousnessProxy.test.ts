import { describe, expect, it } from "vitest";
import { scoreNervousnessFrame } from "./nervousnessProxy";

describe("scoreNervousnessFrame", () => {
  it("stays near zero for settled, camera-facing behavior", () => {
    expect(scoreNervousnessFrame({
      poseMovementRate: 0.12,
      baselineMovementRate: 0.1,
      lookAwayRatio: 0,
      headMovementDegPerSecond: 2,
      postureShiftRecent: false,
    }).score).toBeLessThanOrEqual(2);
  });

  it("rises for combined fidgeting, unstable gaze, and rapid head motion", () => {
    expect(scoreNervousnessFrame({
      poseMovementRate: 1.5,
      baselineMovementRate: 0.1,
      lookAwayRatio: 0.6,
      headMovementDegPerSecond: 34,
      postureShiftRecent: true,
    }).score).toBe(100);
  });

  it("uses the person's calibrated resting movement as its floor", () => {
    const withoutBaseline = scoreNervousnessFrame({
      poseMovementRate: 0.8,
      lookAwayRatio: 0,
      headMovementDegPerSecond: 0,
      postureShiftRecent: false,
    }).score;
    const withBaseline = scoreNervousnessFrame({
      poseMovementRate: 0.8,
      baselineMovementRate: 0.75,
      lookAwayRatio: 0,
      headMovementDegPerSecond: 0,
      postureShiftRecent: false,
    }).score;
    expect(withBaseline).toBeLessThan(withoutBaseline);
  });
});
