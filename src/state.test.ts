import { describe, expect, it } from "vitest";
import { FrameBuffer, Semaphore, WatchSession, narrationSimilarity } from "./state.js";

const jpeg = (marker: string) => Buffer.from(`fake-jpeg-${marker}`);

describe("FrameBuffer", () => {
  it("throttles frames arriving faster than the minimum interval", () => {
    const buf = new FrameBuffer(30_000, 100);
    expect(buf.push(jpeg("a"), "image/jpeg", 1000)).toBe(true);
    expect(buf.push(jpeg("b"), "image/jpeg", 1050)).toBe(false);
    expect(buf.push(jpeg("c"), "image/jpeg", 1200)).toBe(true);
    expect(buf.droppedTooFast).toBe(1);
    expect(buf.accepted).toBe(2);
  });

  it("rejects byte-identical consecutive frames", () => {
    const buf = new FrameBuffer(30_000, 0);
    expect(buf.push(jpeg("same"), "image/jpeg", 1000)).toBe(true);
    expect(buf.push(jpeg("same"), "image/jpeg", 2000)).toBe(false);
    expect(buf.push(jpeg("other"), "image/jpeg", 3000)).toBe(true);
    expect(buf.droppedDuplicate).toBe(1);
  });

  it("evicts frames older than the buffer window", () => {
    const buf = new FrameBuffer(5000, 0);
    buf.push(jpeg("1"), "image/jpeg", 1000);
    buf.push(jpeg("2"), "image/jpeg", 2000);
    buf.push(jpeg("3"), "image/jpeg", 9000);
    expect(buf.length).toBe(1);
    expect(buf.newestAt).toBe(9000);
  });

  it("samples at most `count` frames and always includes the newest", () => {
    const buf = new FrameBuffer(30_000, 0);
    for (let i = 0; i < 10; i++) buf.push(jpeg(String(i)), "image/jpeg", 1000 + i * 100);
    const sampled = buf.sample(3000, 4, 1900);
    expect(sampled).toHaveLength(4);
    expect(sampled.at(-1)!.t).toBe(1900);
  });

  it("returns every frame when fewer than requested are available", () => {
    const buf = new FrameBuffer(30_000, 0);
    buf.push(jpeg("1"), "image/jpeg", 1000);
    buf.push(jpeg("2"), "image/jpeg", 1500);
    expect(buf.sample(3000, 4, 2000)).toHaveLength(2);
  });

  it("picks context frames near each target time, oldest first", () => {
    const buf = new FrameBuffer(120_000, 0);
    const now = 100_000;
    for (let t = 0; t <= now; t += 1000) buf.push(jpeg(String(t)), "image/jpeg", t);
    const context = buf.contextFrames(2, 30_000, 3000, now);
    expect(context).toHaveLength(2);
    expect(context[0]!.t).toBeLessThan(context[1]!.t);
    // Targets are now - 3000 - 60000 and now - 3000 - 30000.
    expect(Math.abs(context[0]!.t - 37_000)).toBeLessThanOrEqual(1000);
    expect(Math.abs(context[1]!.t - 67_000)).toBeLessThanOrEqual(1000);
  });

  it("returns no context frames when none are requested", () => {
    const buf = new FrameBuffer(120_000, 0);
    buf.push(jpeg("1"), "image/jpeg", 1000);
    expect(buf.contextFrames(0, 30_000, 3000, 5000)).toEqual([]);
  });
});

describe("narrationSimilarity", () => {
  it("scores restatements of the same scene highly", () => {
    const a = "A watercolor painting rests on a wooden desk beside art supplies.";
    const b = "The watercolor painting remains on the wooden desk beside art supplies.";
    expect(narrationSimilarity(a, b)).toBeGreaterThan(0.8);
  });

  it("scores genuinely different scenes low", () => {
    const a = "A watercolor painting rests on a wooden desk.";
    const b = "A person walks through a doorway carrying a cardboard box.";
    expect(narrationSimilarity(a, b)).toBeLessThan(0.2);
  });

  it("handles empty input without dividing by zero", () => {
    expect(narrationSimilarity("", "anything at all")).toBe(0);
  });
});

describe("WatchSession narration", () => {
  const session = () => new WatchSession("id", "agent:main:main", "test");

  // Words shorter than three characters are filtered out of the similarity
  // comparison, so numbered entries would all look identical. These do not.
  const NATO = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
    "india", "juliett", "kilo", "lima", "mike", "november", "oscar", "papa",
    "quebec", "romeo", "sierra", "tango",
  ];
  const distinct = (i: number) => `${NATO[i]} observed`;

  it("drops near-duplicate entries and counts unchanged cycles", () => {
    const s = session();
    expect(s.addNarration("A red circle sits on a dark background.", 1000)).toBe(true);
    expect(s.addNarration("A red circle remains on a dark background.", 2000)).toBe(false);
    expect(s.narration).toHaveLength(1);
    expect(s.unchangedCycles).toBe(1);
    expect(s.addNarration("A person enters carrying a toolbox.", 3000)).toBe(true);
    expect(s.unchangedCycles).toBe(0);
  });

  it("drains only unseen entries and advances the cursor", () => {
    const s = session();
    s.addNarration("alpha observed", 1000);
    s.addNarration("bravo observed", 2000);
    expect(s.drainNarration()).toHaveLength(2);
    expect(s.drainNarration()).toHaveLength(0);
    s.addNarration("charlie observed", 3000);
    expect(s.drainNarration()).toHaveLength(1);
  });

  it("caps a drain so a long silence does not dump everything at once", () => {
    const s = session();
    for (let i = 0; i < 20; i++) s.addNarration(distinct(i), i * 1000);
    const drained = s.drainNarration(8);
    expect(drained).toHaveLength(8);
    // The cap keeps the most recent entries, not the oldest.
    expect(drained.at(-1)!.text).toContain("tango");
    expect(s.drainNarration()).toHaveLength(0);
  });

  it("collapses old entries into a summary and keeps the recent ones", () => {
    const s = session();
    for (let i = 0; i < 20; i++) s.addNarration(distinct(i), i * 1000);
    const removed = s.compactNarration("Twenty things happened.", 5);
    expect(removed).toBe(15);
    expect(s.narration).toHaveLength(6);
    expect(s.narration[0]!.text).toContain("Twenty things happened.");
    expect(s.narration.at(-1)!.text).toContain("tango");
  });

  it("does not compact when there is nothing to collapse", () => {
    const s = session();
    s.addNarration("only one observation so far", 1000);
    expect(s.compactNarration("summary", 5)).toBe(0);
    expect(s.narration).toHaveLength(1);
  });
});

describe("Semaphore", () => {
  it("caps concurrent holders and releases waiters in order", async () => {
    const gate = new Semaphore(2);
    const a = await gate.acquire();
    const b = await gate.acquire();
    expect(gate.inFlight).toBe(2);

    let third = false;
    const pending = gate.acquire().then((release) => {
      third = true;
      return release;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(gate.queued).toBe(1);

    a();
    const c = await pending;
    expect(third).toBe(true);

    b();
    c();
    expect(gate.inFlight).toBe(0);
  });

  it("ignores a double release", async () => {
    const gate = new Semaphore(1);
    const release = await gate.acquire();
    release();
    release();
    expect(gate.inFlight).toBe(0);
  });
});
