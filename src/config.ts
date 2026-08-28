import { Type, type Static } from "typebox";

/**
 * ClawVision is model-agnostic. It talks to any OpenAI-compatible
 * /v1/chat/completions endpoint that accepts image_url content parts.
 *
 * Backend-specific request fields go in `extraBody`, which is merged into
 * every request body. For vLLM you almost certainly want:
 *   "extraBody": { "chat_template_kwargs": { "enable_thinking": false } }
 * because reasoning traces add seconds of latency to a yes/no answer.
 */
export const ClawVisionConfigSchema = Type.Object(
  {
    endpoint: Type.String({
      description:
        "OpenAI-compatible base URL, e.g. http://10.0.0.5:8091/v1 (no trailing /chat/completions).",
    }),
    apiKey: Type.Optional(
      Type.String({ description: "Bearer token. Many local servers ignore it." }),
    ),
    model: Type.String({ description: "Model id used for yes/no evaluation." }),
    narratorModel: Type.Optional(
      Type.String({ description: "Model id for narration. Defaults to `model`." }),
    ),
    extraBody: Type.Optional(
      Type.Object({}, { additionalProperties: true, description: "Merged into every request body." }),
    ),
    requestTimeoutMs: Type.Optional(Type.Number()),

    bufferSeconds: Type.Optional(
      Type.Number({ description: "How much recent footage to keep in memory." }),
    ),
    packetSeconds: Type.Optional(
      Type.Number({ description: "Width of the window each evaluation samples from." }),
    ),
    framesPerPacket: Type.Optional(
      Type.Number({ description: "Frames sent per evaluation. More frames, more latency." }),
    ),
    minFrameIntervalMs: Type.Optional(
      Type.Number({ description: "Ingest throttle. Frames arriving faster are dropped." }),
    ),
    maxTicksPerSecond: Type.Optional(
      Type.Number({ description: "Ceiling on evaluations per second." }),
    ),
    cooldownSeconds: Type.Optional(
      Type.Number({ description: "Silence after a YES, so one event fires once." }),
    ),
    narrationIntervalSeconds: Type.Optional(Type.Number()),

    clipBeforeSeconds: Type.Optional(Type.Number()),
    clipAfterSeconds: Type.Optional(Type.Number()),
    clipRetentionMinutes: Type.Optional(
      Type.Number({
        description:
          "Delete clip directories older than this. Default 30. Set 0 to keep " +
          "everything, which will grow without bound.",
      }),
    ),
    clipDir: Type.Optional(
      Type.String({ description: "Where clips are written. Defaults to <stateDir>/clawvision/clips." }),
    ),

    ingestToken: Type.Optional(
      Type.String({ description: "Required as X-ClawVision-Token on the frame ingest route." }),
    ),

    maxConcurrentEvaluations: Type.Optional(
      Type.Number({
        description:
          "Evaluation requests in flight across all streams. Extra ticks wait " +
          "their turn rather than piling onto an overloaded GPU. Default 2.",
      }),
    ),
    maxConcurrentNarrations: Type.Optional(
      Type.Number({ description: "Narration requests in flight across all streams. Default 1." }),
    ),

    contextFrames: Type.Optional(
      Type.Number({
        description:
          "Older frames included alongside the recent packet, one per " +
          "contextFrameSpacingSeconds, oldest first. Gives the watcher awareness " +
          "across ticks rather than only within one. Costs latency per frame. " +
          "Default 2, set 0 to disable.",
      }),
    ),
    contextFrameSpacingSeconds: Type.Optional(
      Type.Number({ description: "Gap between context frames. Default 30." }),
    ),
    compactNarrationEverySeconds: Type.Optional(
      Type.Number({
        description:
          "How often to compact old narration into a summary line. Default 300. " +
          "Set 0 to disable.",
      }),
    ),
    keepNarrationEntries: Type.Optional(
      Type.Number({ description: "Recent entries left uncompacted. Default 12." }),
    ),

    feedIdleSeconds: Type.Optional(
      Type.Number({
        description:
          "Silence after which a stream counts as offline. The next frame then " +
          "triggers a feed-online notification. Default 60.",
      }),
    ),
    notifyOnFeedOnline: Type.Optional(
      Type.Boolean({ description: "Notify the agent when a feed comes online. Default true." }),
    ),

    autoStart: Type.Optional(
      Type.Boolean({
        description:
          "Create a watch session for the default stream at gateway startup, so " +
          "ingest, narration, and evaluation run without any tool call. Default true.",
      }),
    ),
    autoStartStream: Type.Optional(
      Type.String({ description: "Stream id created by autoStart. Defaults to 'default'." }),
    ),
    defaultContext: Type.Optional(
      Type.String({ description: "Context used when the watcher arms itself at startup." }),
    ),
    defaultQuestion: Type.Optional(
      Type.String({
        description:
          "Standing question used at startup. Must be answerable from a few seconds " +
          "of video. Set to an empty string to start unarmed.",
      }),
    ),

    agentId: Type.Optional(
      Type.String({ description: "Agent that receives notifications. Defaults to 'main'." }),
    ),
    openclawBin: Type.Optional(
      Type.String({ description: "Path to the openclaw CLI. Defaults to 'openclaw' on PATH." }),
    ),
    openclawHome: Type.Optional(
      Type.String({ description: "OPENCLAW_HOME for the notification call. Defaults to the current env." }),
    ),
  },
  { additionalProperties: false },
);

export type ClawVisionConfig = Static<typeof ClawVisionConfigSchema>;

export type ResolvedConfig = {
  endpoint: string;
  apiKey: string;
  model: string;
  narratorModel: string;
  extraBody: Record<string, unknown>;
  requestTimeoutMs: number;
  bufferMs: number;
  packetMs: number;
  framesPerPacket: number;
  minFrameIntervalMs: number;
  minTickIntervalMs: number;
  cooldownMs: number;
  narrationIntervalMs: number;
  clipBeforeMs: number;
  clipAfterMs: number;
  clipRetentionMs: number;
  clipDir?: string;
  ingestToken?: string;
  agentId: string;
  openclawBin: string;
  openclawHome?: string;
  maxConcurrentEvaluations: number;
  maxConcurrentNarrations: number;
  contextFrames: number;
  contextFrameSpacingMs: number;
  compactNarrationMs: number;
  keepNarrationEntries: number;
  feedIdleMs: number;
  notifyOnFeedOnline: boolean;
  autoStart: boolean;
  autoStartStream: string;
  defaultContext: string;
  defaultQuestion: string;
};

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveConfig(raw: unknown): ResolvedConfig {
  const c = (raw ?? {}) as Partial<ClawVisionConfig>;

  const endpoint = String(c.endpoint ?? "").replace(/\/+$/, "");
  if (!endpoint) throw new Error("clawvision: `endpoint` is required");
  const model = String(c.model ?? "");
  if (!model) throw new Error("clawvision: `model` is required");

  const ticksPerSecond = num(c.maxTicksPerSecond, 4);

  return {
    endpoint,
    apiKey: c.apiKey ?? "dummy",
    model,
    narratorModel: c.narratorModel ?? model,
    extraBody: (c.extraBody as Record<string, unknown>) ?? {},
    requestTimeoutMs: num(c.requestTimeoutMs, 30_000),
    // The buffer has to span far enough back to still hold the oldest context
    // frame, or contextFrames silently returns nothing.
    bufferMs: Math.max(
      num(c.bufferSeconds, 30) * 1000,
      Math.max(0, Math.floor(c.contextFrames ?? 2)) * num(c.contextFrameSpacingSeconds, 30) * 1000 +
        10_000,
    ),
    packetMs: num(c.packetSeconds, 3) * 1000,
    framesPerPacket: Math.max(1, Math.floor(num(c.framesPerPacket, 4))),
    minFrameIntervalMs: num(c.minFrameIntervalMs, 100),
    minTickIntervalMs: Math.floor(1000 / ticksPerSecond),
    cooldownMs: num(c.cooldownSeconds, 15) * 1000,
    narrationIntervalMs: num(c.narrationIntervalSeconds, 10) * 1000,
    clipBeforeMs: num(c.clipBeforeSeconds, 4) * 1000,
    // Post-roll is dead time: the agent hears nothing until it elapses. Keep it
    // short. Pre-roll is free, since those frames are already buffered.
    clipAfterMs: (c.clipAfterSeconds ?? 0.5) * 1000,
    clipRetentionMs: (c.clipRetentionMinutes ?? 30) * 60_000,
    clipDir: c.clipDir,
    ingestToken: c.ingestToken,
    agentId: c.agentId ?? "main",
    openclawBin: c.openclawBin ?? "openclaw",
    openclawHome: c.openclawHome,
    maxConcurrentEvaluations: Math.max(1, Math.floor(num(c.maxConcurrentEvaluations, 2))),
    maxConcurrentNarrations: Math.max(1, Math.floor(num(c.maxConcurrentNarrations, 1))),
    contextFrames: Math.max(0, Math.floor(c.contextFrames ?? 2)),
    contextFrameSpacingMs: num(c.contextFrameSpacingSeconds, 30) * 1000,
    compactNarrationMs: (c.compactNarrationEverySeconds ?? 300) * 1000,
    keepNarrationEntries: Math.max(2, Math.floor(num(c.keepNarrationEntries, 12))),
    feedIdleMs: num(c.feedIdleSeconds, 60) * 1000,
    notifyOnFeedOnline: c.notifyOnFeedOnline !== false,
    autoStart: c.autoStart !== false,
    autoStartStream: c.autoStartStream ?? "default",
    defaultContext:
      c.defaultContext ??
      "Standing watch on a live camera with no specific task assigned yet. " +
        "The operator has not said what to look for, so treat ordinary stillness " +
        "as uninteresting and only flag genuine changes.",
    defaultQuestion:
      c.defaultQuestion ??
      "Is something happening here that an attentive assistant would speak up " +
        "about — someone needing help, a task finishing or going wrong, a change " +
        "that matters to whoever set this camera up? Answer NO for ordinary " +
        "activity, lighting changes, camera noise, and anything already present " +
        "and unremarkable.",
  };
}
