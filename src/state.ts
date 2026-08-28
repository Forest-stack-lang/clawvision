import { createHash } from "node:crypto";

export type Frame = {
  /** epoch ms when the frame was accepted */
  t: number;
  data: Buffer;
  mime: string;
};

/**
 * Fixed-duration ring buffer of recent frames.
 *
 * Two cheap filters run at ingest so a firehose source doesn't blow up memory:
 * a minimum interval between accepted frames, and an exact-duplicate check
 * against the previous frame. Resizing and re-encoding are deliberately NOT
 * done here — that would drag in a native image dependency. Send appropriately
 * sized JPEGs from the source instead; 512px on the long edge is plenty.
 */
export class FrameBuffer {
  private frames: Frame[] = [];
  private lastHash = "";
  private lastAcceptedAt = 0;

  droppedTooFast = 0;
  droppedDuplicate = 0;
  accepted = 0;

  constructor(
    private bufferMs: number,
    private minIntervalMs: number,
  ) {}

  push(data: Buffer, mime = "image/jpeg", now = Date.now()): boolean {
    if (now - this.lastAcceptedAt < this.minIntervalMs) {
      this.droppedTooFast++;
      return false;
    }
    const hash = createHash("sha1").update(data).digest("hex");
    if (hash === this.lastHash) {
      this.droppedDuplicate++;
      return false;
    }
    this.lastHash = hash;
    this.lastAcceptedAt = now;
    this.accepted++;
    this.frames.push({ t: now, data, mime });
    this.evict(now);
    return true;
  }

  private evict(now: number): void {
    const cutoff = now - this.bufferMs;
    let i = 0;
    while (i < this.frames.length && this.frames[i]!.t < cutoff) i++;
    if (i > 0) this.frames.splice(0, i);
  }

  /** Frames with timestamps in [from, to]. */
  range(from: number, to: number): Frame[] {
    return this.frames.filter((f) => f.t >= from && f.t <= to);
  }

  /**
   * Evenly spaced sample of at most `count` frames from the last `windowMs`.
   * Always includes the newest frame, since that is what "right now" means.
   */
  sample(windowMs: number, count: number, now = Date.now()): Frame[] {
    const window = this.range(now - windowMs, now);
    if (window.length <= count) return window;
    const picked: Frame[] = [];
    const step = (window.length - 1) / (count - 1);
    for (let i = 0; i < count; i++) {
      picked.push(window[Math.round(i * step)]!);
    }
    return picked;
  }

  /**
   * One frame per `spacingMs` going backwards, oldest first, excluding the
   * recent window the evaluation packet already covers.
   *
   * Two frames from 30 and 60 seconds ago give the model a sense of how the
   * scene has drifted without paying for a long packet on every tick.
   */
  contextFrames(count: number, spacingMs: number, excludeRecentMs: number, now = Date.now()): Frame[] {
    if (count <= 0) return [];
    const picked: Frame[] = [];
    for (let i = count; i >= 1; i--) {
      const target = now - excludeRecentMs - i * spacingMs;
      // Nearest frame to the target time, within half a spacing interval.
      let best: Frame | undefined;
      let bestGap = Infinity;
      for (const f of this.frames) {
        const gap = Math.abs(f.t - target);
        if (gap < bestGap) {
          bestGap = gap;
          best = f;
        }
      }
      if (best && bestGap <= spacingMs / 2 && !picked.includes(best)) picked.push(best);
    }
    return picked;
  }

  get length(): number {
    return this.frames.length;
  }

  get newestAt(): number | undefined {
    return this.frames.at(-1)?.t;
  }

  get spanMs(): number {
    if (this.frames.length < 2) return 0;
    return this.frames.at(-1)!.t - this.frames[0]!.t;
  }

  clear(): void {
    this.frames = [];
    this.lastHash = "";
    this.lastAcceptedAt = 0;
  }
}

/**
 * Caps in-flight requests so extra streams queue instead of overwhelming the
 * inference server. Each loop already awaits its own request, so this only
 * matters once several streams are running at once — but at that point an
 * unbounded fan-out is exactly what makes a GPU fall over.
 */
export class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }

  get inFlight(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiting.length;
  }
}

/**
 * Where a watch session was set up from, so notifications go back to the same
 * place. Talk to the agent from WhatsApp and events arrive on WhatsApp.
 */
export type Origin = {
  sessionKey: string;
  channel?: string;
  senderId?: string;
};

/** Written by the agent via clawvision_brief. Read fresh on every tick. */
export type Brief = {
  context: string;
  question: string;
  projectFile?: string;
  updatedAt: number;
};

export type NarrationEntry = { t: number; text: string };

/**
 * One watch session, bound to the agent conversation that started it.
 * `sessionKey` is what next-turn injections are addressed to.
 */
export class WatchSession {
  readonly startedAt = Date.now();
  brief?: Brief;
  narration: NarrationEntry[] = [];
  /** How much narration the agent has already been told about. */
  narrationCursor = 0;
  lastAnswer?: "YES" | "NO";
  lastAnswerAt = 0;
  /** Cleared whenever the question changes, so a stale verdict never reads as current. */
  armedAt = 0;
  lastError?: string;
  ticks = 0;
  yesCount = 0;
  cooldownUntil = 0;
  stopping = false;
  /** False until frames start arriving; flips back after feedIdleMs of silence. */
  feedLive = false;
  /** Suppresses the first feed-online notification, so a restart is not an "event". */
  feedEverSeen = false;
  lastFeedNoticeAt = 0;
  lastCompactionAt = Date.now();
  /** Set from tool context; notifications route back here. */
  origin?: Origin;
  /** Consecutive narration cycles that described the same scene. */
  unchangedCycles = 0;

  constructor(
    readonly id: string,
    /** Reassignable: a later clawvision_start re-points notifications at the calling conversation. */
    public sessionKey: string,
    readonly label: string,
  ) {}

  get armed(): boolean {
    return Boolean(this.brief) && !this.stopping;
  }

  /** Returns false when the entry was dropped as a near-duplicate. */
  addNarration(text: string, now = Date.now()): boolean {
    const previous = this.narration.at(-1);
    if (previous && narrationSimilarity(previous.text, text) >= 0.8) {
      this.unchangedCycles++;
      return false;
    }
    this.unchangedCycles = 0;
    this.narration.push({ t: now, text });
    return true;
  }

  /**
   * Narration the agent has not seen yet; advances the cursor.
   *
   * Capped, because an agent that has been quiet for hours does not need every
   * entry since then — it needs the recent ones. The cursor still advances past
   * everything, so nothing is delivered twice.
   */
  drainNarration(max = 8): NarrationEntry[] {
    const fresh = this.narration.slice(this.narrationCursor);
    this.narrationCursor = this.narration.length;
    return fresh.length > max ? fresh.slice(-max) : fresh;
  }

  /**
   * Replace everything before the last `keep` entries with one summary line.
   *
   * Narration grows without bound on a long session. Compacting keeps the
   * recent detail the evaluator needs while preserving the shape of what came
   * before. The agent cursor is rebased so nothing already delivered reappears.
   */
  compactNarration(summary: string, keep: number, now = Date.now()): number {
    if (this.narration.length <= keep) return 0;
    const cutIndex = this.narration.length - keep;
    const removed = this.narration.slice(0, cutIndex);
    const first = removed[0]!;
    this.narration = [
      { t: first.t, text: `[summary of ${removed.length} earlier observations] ${summary}` },
      ...this.narration.slice(cutIndex),
    ];
    // Everything before the cut collapsed into one entry, so the cursor moves
    // with it; entries the agent had not yet seen stay unseen.
    this.narrationCursor = Math.max(0, Math.min(this.narrationCursor - cutIndex + 1, this.narration.length));
    this.lastCompactionAt = now;
    return removed.length;
  }

  /** Recent narration for model context, without touching the agent cursor. */
  recentNarration(count: number): NarrationEntry[] {
    return this.narration.slice(-count);
  }
}

/**
 * Words too common to signal that two descriptions differ. Without this,
 * an incidental "the" in one restatement and not the other is enough to push
 * a pair of near-identical sentences below the dedup threshold.
 */
const STOPWORDS = new Set([
  "the", "and", "but", "for", "from", "into", "onto", "over", "under", "near",
  "with", "that", "this", "these", "those", "are", "was", "were", "has", "have",
  "had", "its", "his", "her", "their", "there", "here", "not", "also", "still",
  "now", "then", "than", "some", "any", "all", "can", "will", "would", "been",
  "being", "remains", "remain", "appears", "appear", "seen", "visible", "shows",
  "show", "showing",
]);

/**
 * Rough word-overlap similarity, 0 to 1.
 *
 * A static scene produces narration that is near-identical every cycle
 * ("the painting remains on the desk"), which is worthless to the agent and
 * crowds out the entries that matter. Comparing word sets catches those
 * without needing an embedding model or any dependency.
 */
export function narrationSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    );
  const setA = words(a);
  const setB = words(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared++;
  return shared / Math.max(setA.size, setB.size);
}

export function formatClock(t: number): string {
  return new Date(t).toISOString().slice(11, 19);
}
