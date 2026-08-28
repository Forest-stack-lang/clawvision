import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";

const base = { endpoint: "http://localhost:8000/v1", model: "test-model" };

describe("resolveConfig", () => {
  it("requires an endpoint and a model", () => {
    expect(() => resolveConfig({ model: "x" })).toThrow(/endpoint/);
    expect(() => resolveConfig({ endpoint: "http://x/v1" })).toThrow(/model/);
  });

  it("strips trailing slashes from the endpoint", () => {
    expect(resolveConfig({ ...base, endpoint: "http://localhost:8000/v1///" }).endpoint).toBe(
      "http://localhost:8000/v1",
    );
  });

  it("falls back to the main model for narration", () => {
    expect(resolveConfig(base).narratorModel).toBe("test-model");
    expect(resolveConfig({ ...base, narratorModel: "small" }).narratorModel).toBe("small");
  });

  it("widens the buffer to cover the oldest context frame", () => {
    // 2 frames at 30s spacing need at least 60s of history, so the 30s default
    // buffer must grow or contextFrames would silently return nothing.
    const cfg = resolveConfig({ ...base, bufferSeconds: 30, contextFrames: 2 });
    expect(cfg.bufferMs).toBeGreaterThanOrEqual(70_000);
  });

  it("leaves the buffer alone when context frames are disabled", () => {
    expect(resolveConfig({ ...base, bufferSeconds: 30, contextFrames: 0 }).bufferMs).toBe(30_000);
  });

  it("allows a sub-second or zero post-roll", () => {
    expect(resolveConfig({ ...base, clipAfterSeconds: 0.5 }).clipAfterMs).toBe(500);
    expect(resolveConfig({ ...base, clipAfterSeconds: 0 }).clipAfterMs).toBe(0);
  });

  it("derives the tick interval from the rate ceiling", () => {
    expect(resolveConfig({ ...base, maxTicksPerSecond: 4 }).minTickIntervalMs).toBe(250);
  });

  it("keeps clips for thirty minutes by default and honours zero as forever", () => {
    expect(resolveConfig(base).clipRetentionMs).toBe(30 * 60_000);
    expect(resolveConfig({ ...base, clipRetentionMinutes: 0 }).clipRetentionMs).toBe(0);
  });

  it("arms itself at startup by default", () => {
    const cfg = resolveConfig(base);
    expect(cfg.autoStart).toBe(true);
    expect(cfg.defaultQuestion.length).toBeGreaterThan(0);
    expect(resolveConfig({ ...base, autoStart: false }).autoStart).toBe(false);
  });
});
