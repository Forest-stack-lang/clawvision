import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { definePluginEntry, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";

import { resolveConfig, type ResolvedConfig } from "./config.js";
import {
  FrameBuffer,
  Semaphore,
  WatchSession,
  formatClock,
  type NarrationEntry,
  type Origin,
} from "./state.js";
import { evaluateFrames, narrateFrames, summarizeNarration } from "./vision.js";

const INGEST_PATH = "/clawvision/frame";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_CLIP_FRAMES = 12;

type Stream = {
  id: string;
  buffer: FrameBuffer;
  session?: WatchSession;
  abort?: AbortController;
};

type Runtime = {
  stateDir: string;
  workspaceDir?: string;
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
};

/**
 * Module-level so the HTTP route, the tools, and the service all see the same
 * streams. A stream is created on first frame or first tool call, whichever
 * happens first, so ingest can start before the agent asks to watch.
 */
const streams = new Map<string, Stream>();
let runtime: Runtime | undefined;
let cfg: ResolvedConfig | undefined;

/**
 * OpenClaw calls register(api) several times in different registration modes.
 * Only the `full` registration is "active" in the registry; workflow side
 * effects such as scheduleSessionTurn and sendSessionAttachment are refused
 * on any other record. Tool closures capture whichever api created them, so
 * we keep the live one here and route all notifications through it.
 */
let liveApi: any;

/** Shared across every stream, so N cameras do not mean N times the GPU load. */
let evalGate: Semaphore | undefined;
let narrateGate: Semaphore | undefined;

/**
 * Read the calling conversation off the tool context.
 *
 * messageChannel and requesterSenderId are runtime-supplied, so they reflect
 * where the agent was actually spoken to rather than anything the model chose.
 */
function captureOrigin(ctx: any): Origin | undefined {
  if (!ctx?.sessionKey) return undefined;
  return {
    sessionKey: ctx.sessionKey,
    channel: ctx.messageChannel,
    senderId: ctx.requesterSenderId,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const execFileAsync = promisify(execFile);

function getStream(id: string): Stream {
  let stream = streams.get(id);
  if (!stream) {
    const c = cfg!;
    stream = { id, buffer: new FrameBuffer(c.bufferMs, c.minFrameIntervalMs) };
    streams.set(id, stream);
  }
  return stream;
}

function clipRoot(): string {
  if (cfg?.clipDir) return cfg.clipDir;
  // Prefer the workspace. The agent's media tools refuse to read files outside
  // it, so a clip written anywhere else is invisible to the model that needs
  // to look at it.
  const base = runtime?.workspaceDir ?? runtime?.stateDir ?? "/tmp";
  return join(base, "clawvision", "clips");
}

async function readProjectState(path?: string): Promise<string | undefined> {
  if (!path || path === "null") return undefined;
  try {
    const text = await readFile(path, "utf8");
    // Keep the tail. Project files grow, and the recent end is what matters.
    return text.length > 6000 ? `...\n${text.slice(-6000)}` : text;
  } catch {
    return undefined;
  }
}

/**
 * Delete clip directories past their retention window.
 *
 * Directory names end in the trigger timestamp, so ages come from the name
 * rather than a stat call per directory.
 */
async function pruneOldClips(): Promise<void> {
  const c = cfg!;
  if (c.clipRetentionMs <= 0) return;
  const root = clipRoot();
  const cutoff = Date.now() - c.clipRetentionMs;
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const stamp = Number(entry.name.slice(entry.name.lastIndexOf("-") + 1));
      if (!Number.isFinite(stamp) || stamp >= cutoff) continue;
      await rm(join(root, entry.name), { recursive: true, force: true });
    }
  } catch {
    // The directory may not exist yet. Nothing to prune.
  }
}

/**
 * Writes the frames around a trigger to disk as individual JPEGs.
 * Next-turn injections are text-only, so the agent gets a directory path and
 * decides for itself whether to spend tokens looking at the images.
 */
async function writeClip(stream: Stream, triggerAt: number): Promise<{ dir: string; files: string[] }> {
  const c = cfg!;
  const frames = stream.buffer.range(triggerAt - c.clipBeforeMs, triggerAt + c.clipAfterMs);
  const dir = join(clipRoot(), `${stream.id}-${triggerAt}`);
  await mkdir(dir, { recursive: true });

  let picked = frames;
  if (frames.length > MAX_CLIP_FRAMES) {
    const step = (frames.length - 1) / (MAX_CLIP_FRAMES - 1);
    picked = Array.from({ length: MAX_CLIP_FRAMES }, (_, i) => frames[Math.round(i * step)]!);
  }

  const files: string[] = [];
  for (const [i, frame] of picked.entries()) {
    const offset = frame.t - triggerAt;
    const sign = offset < 0 ? "-" : "+";
    const name = `${String(i).padStart(2, "0")}_${sign}${Math.abs(offset)}ms.jpg`;
    await writeFile(join(dir, name), frame.data);
    files.push(name);
  }
  // Fire and forget: a failed prune must never block a notification.
  void pruneOldClips();
  return { dir, files };
}

function buildYesText(args: {
  session: WatchSession;
  question: string;
  clipDir: string;
  clipFiles: string[];
  fresh: NarrationEntry[];
  triggerAt: number;
}): string {
  const lines: string[] = [];
  lines.push(
    `[CLAWVISION] Live camera event on stream "${args.session.label}". ` +
      `This is an automated notification, not a message from the user.`,
  );
  lines.push("");
  lines.push(`Question answered YES at ${formatClock(args.triggerAt)}:`);
  lines.push(`  "${args.question}"`);

  if (args.fresh.length > 0) {
    lines.push("", "Narration since your last update:");
    for (const n of args.fresh) lines.push(`  [${formatClock(n.t)}] ${n.text}`);
  } else {
    lines.push("", "No new narration since your last update.");
  }

  if (args.clipFiles.length > 0) {
    // List the exact paths. Given a directory and a naming scheme, models will
    // construct filenames from memory and get them wrong.
    lines.push("", `Your first action is to read these ${args.clipFiles.length} images, in order:`);
    for (const f of args.clipFiles) lines.push(`  ${join(args.clipDir, f)}`);
    lines.push(
      "Copy these paths exactly. Do not guess or construct filenames. " +
        "The offsets in the names are milliseconds from the moment the event fired. " +
        "The frames are the evidence; the question text alone tells you nothing " +
        "about what actually happened.",
    );
  }

  lines.push(
    "",
    "Then tell the user what you saw. The watcher continues on its own with the " +
      "current question and needs nothing further from you.",
  );
  return lines.join("\n");
}

/**
 * Deliver the notification by running an agent turn through the OpenClaw CLI.
 *
 * The plugin-side scheduling APIs (scheduleSessionTurn) run turns in isolated
 * cron sessions that cannot post into an existing conversation, and next-turn
 * injections only decorate a turn the user was going to trigger anyway. The
 * CLI is the one path that injects a message into the live agent session and
 * makes it respond immediately, which is what a camera event needs.
 *
 * Yes, this shells out to the same binary hosting the plugin. It is the
 * documented, stable interface; the in-process alternatives are not.
 */
async function notifyAgent(_api: unknown, origin: Origin | undefined, text: string): Promise<void> {
  const c = cfg!;
  const args = ["agent", "--message", text, "--agent", c.agentId];

  // Deliver back to wherever the watcher was set up from. webchat needs no
  // flags — the message lands in the main session, which is what it reads.
  if (origin?.channel && origin.channel !== "webchat" && origin.senderId) {
    args.push("--channel", origin.channel, "--to", origin.senderId, "--deliver");
  }
  const env = { ...process.env, ...(c.openclawHome ? { OPENCLAW_HOME: c.openclawHome } : {}) };

  await execFileAsync(c.openclawBin, args, {
    env,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

/** Best-effort image delivery. Never blocks or fails the notification. */
async function sendClipImages(
  api: any,
  sessionKey: string,
  files: string[],
  caption: string,
): Promise<void> {
  const send = api?.session?.workflow?.sendSessionAttachment;
  if (typeof send !== "function" || files.length === 0) return;
  try {
    const result = await send({
      sessionKey,
      files: files.slice(0, 4).map((path) => ({ path })),
      text: caption,
    });
    if (result?.ok === false) {
      runtime?.logger.warn(`clawvision: attachment not delivered: ${result.error}`);
    }
  } catch (err) {
    runtime?.logger.warn(`clawvision: attachment failed: ${String(err)}`);
  }
}

async function handleYes(api: any, stream: Stream, session: WatchSession, question: string): Promise<void> {
  const c = cfg!;
  const triggerAt = Date.now();
  session.yesCount++;
  // Set the cooldown before the post-roll wait, so one event cannot fire twice.
  session.cooldownUntil = triggerAt + c.clipAfterMs + c.cooldownMs;

  await sleep(c.clipAfterMs);

  let clip = { dir: "", files: [] as string[] };
  try {
    clip = await writeClip(stream, triggerAt);
  } catch (err) {
    runtime?.logger.warn(`clawvision: clip write failed: ${String(err)}`);
  }

  const text = buildYesText({
    session,
    question,
    clipDir: clip.dir,
    clipFiles: clip.files,
    fresh: session.drainNarration(),
    triggerAt,
  });

  try {
    await notifyAgent(liveApi ?? api, session.origin, text);
    runtime?.logger.info(`clawvision: YES on "${session.label}" -> ${session.sessionKey}`);
  } catch (err) {
    runtime?.logger.error(`clawvision: notify failed: ${String(err)}`);
  }

  if (clip.files.length > 0) {
    void sendClipImages(
      liveApi ?? api,
      session.sessionKey,
      clip.files.map((f) => join(clip.dir, f)),
      `[CLAWVISION] frames from ${formatClock(triggerAt)}`,
    );
  }
}

/**
 * Announce that a camera feed just came online.
 *
 * Narrates the scene first so the agent gets a description rather than a bare
 * "a feed connected". The agent has memory files, so it can decide for itself
 * whether this continues something it was already working on — which is a
 * judgement the frame evaluator cannot make, since it sees only a few seconds
 * of video and has no record of previous sessions.
 */
async function handleFeedOnline(stream: Stream, session: WatchSession): Promise<void> {
  const c = cfg!;
  session.lastFeedNoticeAt = Date.now();

  let description = "";
  try {
    const frames = stream.buffer.sample(c.packetMs, Math.min(4, c.framesPerPacket));
    if (frames.length > 0) {
      description = await narrateFrames(
        c,
        frames,
        session.narration,
        { context: session.brief?.context, question: session.brief?.question },
        stream.abort?.signal,
      );
      if (description) session.addNarration(description);
    }
  } catch (err) {
    runtime?.logger.warn(`clawvision: feed-online narration failed: ${String(err)}`);
  }

  const lines = [
    `[CLAWVISION] A camera feed just came online on stream "${session.label}". ` +
      "This is an automated notification, not a message from the user.",
    "",
    description ? `What the camera sees now:\n  ${description}` : "No usable frames yet.",
    "",
    `Currently watching for: "${session.brief?.question ?? "(nothing — not armed)"}"`,
    "",
    "Check whether this continues something you were already doing. Look at your " +
      "memory and recent notes for an unfinished task this camera relates to. If it " +
      "does, call clawvision_brief to set context and a question that fit where that " +
      "work left off. If it does not, either leave the standing question in place or " +
      "ask the user what to watch for.",
  ];

  try {
    await notifyAgent(liveApi, session.origin, lines.join("\n"));
    runtime?.logger.info(`clawvision: feed online on "${session.label}"`);
  } catch (err) {
    runtime?.logger.error(`clawvision: feed-online notify failed: ${String(err)}`);
  }
}

async function runWatcher(api: any, stream: Stream, session: WatchSession): Promise<void> {
  const c = cfg!;
  const signal = stream.abort?.signal;

  while (!session.stopping) {
    const tickStart = Date.now();
    try {
      // Feed liveness: newest frame within feedIdleMs means the camera is live.
      const newest = stream.buffer.newestAt;
      const live = newest !== undefined && tickStart - newest < c.feedIdleMs;
      if (live !== session.feedLive) {
        session.feedLive = live;
        if (live) {
          const firstEver = !session.feedEverSeen;
          session.feedEverSeen = true;
          if (cfg!.notifyOnFeedOnline && !firstEver) {
            void handleFeedOnline(stream, session);
          } else if (firstEver) {
            session.lastFeedNoticeAt = Date.now();
            runtime?.logger.info(`clawvision: feed first seen on "${session.label}"`);
          }
        } else {
          runtime?.logger.info(`clawvision: feed went idle on "${session.label}"`);
        }
      }

      if (!session.armed) {
        await sleep(400);
        continue;
      }
      if (Date.now() < session.cooldownUntil) {
        await sleep(200);
        continue;
      }

      const frames = stream.buffer.sample(c.packetMs, c.framesPerPacket);
      if (frames.length === 0) {
        await sleep(300);
        continue;
      }

      const brief = session.brief!;
      const releaseEval = await evalGate!.acquire();
      let verdict: "YES" | "NO" | null;
      try {
        verdict = await evaluateFrames(
          c,
          frames,
          {
            context: brief.context,
            question: brief.question,
            projectState: await readProjectState(brief.projectFile),
            narration: session.recentNarration(3),
            contextFrames: stream.buffer.contextFrames(
              c.contextFrames,
              c.contextFrameSpacingMs,
              c.packetMs,
            ),
          },
          signal,
        );
      } finally {
        releaseEval();
      }

      session.ticks++;
      session.lastError = undefined;

      if (verdict) {
        session.lastAnswer = verdict;
        session.lastAnswerAt = Date.now();
      }
      if (verdict === "YES") {
        await handleYes(api, stream, session, brief.question);
      }
    } catch (err) {
      if (session.stopping) break;
      session.lastError = String(err);
      runtime?.logger.warn(`clawvision: tick failed: ${String(err)}`);
      await sleep(1500);
    }

    const elapsed = Date.now() - tickStart;
    if (elapsed < c.minTickIntervalMs) await sleep(c.minTickIntervalMs - elapsed);
  }
}

async function runNarrator(stream: Stream, session: WatchSession): Promise<void> {
  const c = cfg!;
  const signal = stream.abort?.signal;

  while (!session.stopping) {
    await sleep(c.narrationIntervalMs);
    if (session.stopping) break;
    try {
      const frames = stream.buffer.sample(c.narrationIntervalMs, Math.min(4, c.framesPerPacket));
      if (frames.length === 0) continue;
      const releaseNarrate = await narrateGate!.acquire();
      let text: string;
      try {
        text = await narrateFrames(
          c,
          frames,
          session.narration,
          { context: session.brief?.context, question: session.brief?.question },
          signal,
        );
      } finally {
        releaseNarrate();
      }
      if (text) session.addNarration(text);

      // Compact old narration so a long session does not grow unbounded.
      if (
        c.compactNarrationMs > 0 &&
        Date.now() - session.lastCompactionAt > c.compactNarrationMs &&
        session.narration.length > c.keepNarrationEntries
      ) {
        try {
          const older = session.narration.slice(0, session.narration.length - c.keepNarrationEntries);
          const summary = await summarizeNarration(c, older, signal);
          const collapsed = session.compactNarration(summary, c.keepNarrationEntries);
          if (collapsed > 0) {
            runtime?.logger.info(`clawvision: compacted ${collapsed} narration entries`);
          }
        } catch (err) {
          runtime?.logger.warn(`clawvision: narration compaction failed: ${String(err)}`);
          session.lastCompactionAt = Date.now();
        }
      }
    } catch (err) {
      if (!session.stopping) {
        runtime?.logger.warn(`clawvision: narration failed: ${String(err)}`);
      }
    }
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error("frame too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/**
 * POST /clawvision/frame?stream=default
 * Body: raw JPEG bytes. Content-Type sets the mime, defaulting to image/jpeg.
 *
 * Deliberately dumb: one frame per request, no multipart, no decoding. Any
 * camera source that can POST bytes works, and the plugin never needs a
 * native image dependency.
 */
async function handleIngest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!cfg) {
    json(res, 503, { error: "clawvision not configured" });
    return true;
  }
  if (req.method !== "POST") {
    json(res, 405, { error: "POST only" });
    return true;
  }
  if (cfg.ingestToken && req.headers["x-clawvision-token"] !== cfg.ingestToken) {
    json(res, 401, { error: "bad or missing X-ClawVision-Token" });
    return true;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const streamId = url.searchParams.get("stream") ?? "default";

  try {
    const body = await readBody(req);
    if (body.length === 0) {
      json(res, 400, { error: "empty body" });
      return true;
    }
    const mime = String(req.headers["content-type"] ?? "image/jpeg").split(";")[0]!;
    const stream = getStream(streamId);
    const accepted = stream.buffer.push(body, mime);
    json(res, 200, {
      accepted,
      stream: streamId,
      buffered: stream.buffer.length,
      spanMs: stream.buffer.spanMs,
      watching: Boolean(stream.session && !stream.session.stopping),
      armed: Boolean(stream.session?.armed),
    });
  } catch (err) {
    json(res, 400, { error: String(err) });
  }
  return true;
}

async function stopSession(stream: Stream): Promise<string> {
  const session = stream.session;
  if (!session) return "No active watch session.";

  session.stopping = true;
  stream.abort?.abort();

  let summary = "";
  try {
    summary = await summarizeNarration(cfg!, session.narration);
  } catch (err) {
    summary = `(summary failed: ${String(err)})`;
  }

  stream.session = undefined;
  stream.abort = undefined;
  stream.buffer.clear();
  return summary;
}

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "clawvision",
  name: "ClawVision",
  description: "Live video awareness for OpenClaw.",

  register(api) {
    try {
      cfg = resolveConfig(api.pluginConfig);
    } catch (err) {
      api.logger.error(`clawvision: ${String(err)} — plugin will not start`);
      return;
    }

    api.logger.info(`clawvision: register mode=${api.registrationMode}`);
    if (api.registrationMode === "full" || !liveApi) liveApi = api;

    api.registerHttpRoute({
      path: INGEST_PATH,
      match: "exact",
      auth: "plugin",
      handler: handleIngest,
    });

    api.registerService({
      id: "clawvision",
      start: (ctx) => {
        evalGate = new Semaphore(cfg!.maxConcurrentEvaluations);
        narrateGate = new Semaphore(cfg!.maxConcurrentNarrations);
        runtime = {
          stateDir: ctx.stateDir,
          workspaceDir: ctx.workspaceDir,
          logger: ctx.logger,
        };
        ctx.logger.info(`clawvision: ready, ingest at ${INGEST_PATH}, model ${cfg!.model}`);

        // Stand up a watch session without waiting for a tool call, so a camera
        // that starts streaming is observed immediately. Notifications go to the
        // configured agent, so no conversation needs to have happened first.
        if (cfg!.autoStart) {
          const streamId = cfg!.autoStartStream;
          const stream = getStream(streamId);
          if (!stream.session) {
            const session = new WatchSession(randomUUID(), `agent:${cfg!.agentId}:main`, streamId);
            if (cfg!.defaultQuestion.trim()) {
              session.brief = {
                context: cfg!.defaultContext,
                question: cfg!.defaultQuestion,
                updatedAt: Date.now(),
              };
              session.armedAt = Date.now();
            }
            stream.session = session;
            stream.abort = new AbortController();
            void runWatcher(liveApi, stream, session);
            void runNarrator(stream, session);
            ctx.logger.info(
              `clawvision: auto-started "${streamId}" (${session.brief ? "armed" : "unarmed"})`,
            );
          }
        }
      },
      stop: async () => {
        for (const stream of streams.values()) {
          if (stream.session) {
            stream.session.stopping = true;
            stream.abort?.abort();
          }
        }
        streams.clear();
      },
    });

    api.registerTool(
      (toolCtx) => {
        const streamParam = Type.Optional(
          Type.String({ description: "Stream name. Defaults to 'default'." }),
        );

        return [
          {
            name: "clawvision_start",
            label: "Start Watching",
            description:
              "Start watching a live camera stream. Narration begins immediately, but " +
              "evaluation stays paused until you call clawvision_brief with context and " +
              "a question. Call this first, look at what the camera sees, then write the brief.",
            parameters: Type.Object({
              stream: streamParam,
              label: Type.Optional(
                Type.String({ description: "Human-readable name for this watch session." }),
              ),
            }),
            async execute(_id: string, params: { stream?: string; label?: string }) {
              const streamId = params.stream ?? "default";
              const sessionKey = toolCtx.sessionKey;
              if (!sessionKey) {
                return {
                  content: [
                    { type: "text" as const, text: "No session key available; cannot start watching." },
                  ],
                  details: { started: false },
                };
              }

              const stream = getStream(streamId);
              const existing = stream.session;
              if (existing && !existing.stopping) {
                // Adopt the running session instead of refusing. Re-point it at
                // the caller's conversation so notifications land in the right
                // place after a restart or a handoff between sessions.
                const rebound = existing.sessionKey !== sessionKey;
                if (rebound) existing.sessionKey = sessionKey;
                existing.origin = captureOrigin(toolCtx) ?? existing.origin;
                const q = existing.brief?.question;
                return {
                  content: [
                    {
                      type: "text" as const,
                      text:
                        `Resumed the watcher already running on "${streamId}".` +
                        (rebound ? " Notifications now go to this conversation." : "") +
                        (q
                          ? `\nCurrent question: "${q}"\nCall clawvision_brief to change it.`
                          : "\nNo question set yet. Call clawvision_brief to arm it."),
                    },
                  ],
                  details: {
                    started: false,
                    resumed: true,
                    armed: Boolean(existing.brief),
                    question: q ?? null,
                  },
                };
              }

              const session = new WatchSession(randomUUID(), sessionKey, params.label ?? streamId);
              session.origin = captureOrigin(toolCtx);
              stream.session = session;
              stream.abort = new AbortController();

              void runWatcher(api, stream, session);
              void runNarrator(stream, session);

              const buffered = stream.buffer.length;
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `Watching "${streamId}". ${buffered} frames buffered.\n` +
                      "Narration is running. Evaluation is PAUSED until you call " +
                      "clawvision_brief with context and a yes/no question.",
                  },
                ],
                details: { started: true, stream: streamId, buffered },
              };
            },
          },

          {
            name: "clawvision_brief",
            label: "Set Watch Brief",
            description:
              "Set or update what the watcher is looking for. Update it freely and often " +
              "as the situation develops — a stale question wastes the watcher.\n\n" +
              "The watcher is a full vision-language model, not a motion detector. Ask " +
              "questions that need judgement, not questions a tripwire could answer.\n\n" +
              "Weak questions, do not use these:\n" +
              "  'Is a person visible?'  'Is the screen dark?'  'Has anything changed?'\n" +
              "They fire constantly or never, and tell you nothing you could act on.\n\n" +
              "Strong questions look like:\n" +
              "  'Has the user finished the step they were working on, or hit a problem?'\n" +
              "  'Is there something here I could help with or automate for them?'\n" +
              "  'Did whatever was blocking the camera get moved, and can I see what it was?'\n" +
              "  'Has the user done something that contradicts what they told me earlier?'\n" +
              "  'Is anyone showing signs of needing help — struggling, searching, stuck?'\n\n" +
              "Ask what a thoughtful assistant watching over someone's shoulder would " +
              "notice. YES should mean 'this is worth interrupting them about'.",
            parameters: Type.Object({
              context: Type.String({
                description:
                  "What is happening and what matters. Written for a model that sees " +
                  "only a few seconds of video and this text.",
              }),
              question: Type.String({
                description:
                  "A question requiring judgement, answered YES when the situation " +
                  "genuinely warrants your attention. Prefer 'has the user hit a " +
                  "problem or finished this step?' over 'is a person visible?'. " +
                  "Questions that could be answered by a motion sensor are wasted here.",
              }),
              projectFile: Type.Optional(
                Type.String({
                  description:
                    "Absolute path to a file whose contents give further context, or omit.",
                }),
              ),
              stream: streamParam,
            }),
            async execute(
              _id: string,
              params: { context: string; question: string; projectFile?: string; stream?: string },
            ) {
              const streamId = params.stream ?? "default";
              let session = streams.get(streamId)?.session;
              let autoStarted = false;

              // Arming a stream that is not running is a reasonable thing to
              // ask for, so start it rather than sending the agent back a step.
              if (!session || session.stopping) {
                const sessionKey = toolCtx.sessionKey;
                if (!sessionKey) {
                  return {
                    content: [
                      { type: "text" as const, text: "No session key available; cannot start watching." },
                    ],
                    details: { updated: false },
                  };
                }
                const stream = getStream(streamId);
                session = new WatchSession(randomUUID(), sessionKey, streamId);
                session.origin = captureOrigin(toolCtx);
                stream.session = session;
                stream.abort = new AbortController();
                void runWatcher(api, stream, session);
                void runNarrator(stream, session);
                autoStarted = true;
              }

              const first = !session.brief;
              session.brief = {
                context: params.context,
                question: params.question,
                projectFile: params.projectFile,
                updatedAt: Date.now(),
              };
              session.cooldownUntil = 0;
              // A verdict answered a different question; it is meaningless now.
              session.lastAnswer = undefined;
              session.lastAnswerAt = 0;
              session.armedAt = Date.now();

              const prefix = autoStarted
                ? `Started and armed the watcher on "${streamId}".`
                : first
                  ? `Watcher armed on "${streamId}".`
                  : `Question updated on "${streamId}".`;

              return {
                content: [
                  {
                    type: "text" as const,
                    text: `${prefix} Now evaluating: "${params.question}"`,
                  },
                ],
                details: {
                  updated: true,
                  armed: true,
                  autoStarted,
                  question: params.question,
                },
              };
            },
          },

          {
            name: "clawvision_status",
            label: "Watch Status",
            description: "Check watcher health, tick rate, current question, and recent narration.",
            parameters: Type.Object({ stream: streamParam }),
            async execute(_id: string, params: { stream?: string }) {
              const streamId = params.stream ?? "default";
              const stream = streams.get(streamId);
              if (!stream) {
                return {
                  content: [{ type: "text" as const, text: `No stream "${streamId}".` }],
                  details: { exists: false },
                };
              }

              const s = stream.session;
              const b = stream.buffer;
              const lines = [
                `Stream: ${streamId}`,
                `Buffered: ${b.length} frames over ${(b.spanMs / 1000).toFixed(1)}s`,
                `Ingest: ${b.accepted} accepted, ${b.droppedTooFast} throttled, ${b.droppedDuplicate} duplicate`,
              ];

              if (!s || s.stopping) {
                lines.push("Watching: no");
              } else {
                const uptime = (Date.now() - s.startedAt) / 1000;
                lines.push(
                  `Watching: yes (${s.label})`,
                  `Feed: ${s.feedLive ? "live" : s.feedEverSeen ? "idle (no recent frames)" : "never seen"}`,
                  `Narration entries: ${s.narration.length}` +
                    (s.unchangedCycles > 0 ? ` (scene unchanged for ${s.unchangedCycles} cycles)` : ""),
                  `Armed: ${s.armed ? "yes" : "no — needs clawvision_brief"}`,
                  `Question: ${s.brief?.question ?? "(none)"}`,
                  `Ticks: ${s.ticks} in ${uptime.toFixed(0)}s (${(s.ticks / Math.max(uptime, 1)).toFixed(1)}/s)`,
                  s.lastAnswer
                    ? `Last answer: ${s.lastAnswer} (${Math.round((Date.now() - s.lastAnswerAt) / 1000)}s ago)`
                    : "Last answer: none since the question was set",
                  `YES events: ${s.yesCount}`,
                );
                if (b.length === 0) {
                  lines.push(
                    "NOTE: no frames buffered — nothing is being evaluated. Check the frame source.",
                  );
                }
                if (s.lastError) lines.push(`Last error: ${s.lastError}`);
                const recent = s.recentNarration(5);
                if (recent.length > 0) {
                  lines.push("", "Recent narration:");
                  for (const n of recent) lines.push(`  [${formatClock(n.t)}] ${n.text}`);
                }
              }

              return {
                content: [{ type: "text" as const, text: lines.join("\n") }],
                details: {
                  exists: true,
                  watching: Boolean(s && !s.stopping),
                  armed: Boolean(s?.armed),
                  ticks: s?.ticks ?? 0,
                  yesCount: s?.yesCount ?? 0,
                  buffered: b.length,
                },
              };
            },
          },

          {
            name: "clawvision_streams",
            label: "List Streams",
            description:
              "List every camera stream, whether each is live, and what it is watching for. " +
              "Use this when you do not know which streams exist or which name to pass.",
            parameters: Type.Object({}),
            async execute() {
              if (streams.size === 0) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text:
                        "No streams. A stream appears once something posts a frame to " +
                        "/clawvision/frame?stream=<name>, or when you call clawvision_start.",
                    },
                  ],
                  details: { streams: [] },
                };
              }

              const rows: string[] = [];
              const detail: unknown[] = [];
              for (const [id, stream] of streams) {
                const s = stream.session;
                const live = s?.feedLive ? "live" : stream.buffer.length > 0 ? "idle" : "no frames";
                rows.push(
                  `${id}: ${live}, ${stream.buffer.length} frames` +
                    (s && !s.stopping
                      ? `, watching${s.brief ? `: "${s.brief.question}"` : " (not armed)"}`
                      : ", not watching"),
                );
                detail.push({
                  stream: id,
                  live: Boolean(s?.feedLive),
                  buffered: stream.buffer.length,
                  watching: Boolean(s && !s.stopping),
                  armed: Boolean(s?.brief),
                  question: s?.brief?.question ?? null,
                });
              }

              const load = `\nIn flight: ${evalGate?.inFlight ?? 0} evaluations` +
                ` (${evalGate?.queued ?? 0} queued), ${narrateGate?.inFlight ?? 0} narrations`;

              return {
                content: [{ type: "text" as const, text: rows.join("\n") + load }],
                details: { streams: detail },
              };
            },
          },

          {
            name: "clawvision_stop",
            label: "Stop Watching",
            description:
              "Stop watching and get a summary of everything observed during the session.",
            parameters: Type.Object({ stream: streamParam }),
            async execute(_id: string, params: { stream?: string }) {
              const streamId = params.stream ?? "default";
              const stream = streams.get(streamId);
              if (!stream?.session) {
                return {
                  content: [{ type: "text" as const, text: `Not watching "${streamId}".` }],
                  details: { stopped: false },
                };
              }
              const summary = await stopSession(stream);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Stopped watching "${streamId}".\n\nSession summary:\n${summary}`,
                  },
                ],
                details: { stopped: true, summary },
              };
            },
          },
        ];
      },
      {
        names: [
          "clawvision_start",
          "clawvision_brief",
          "clawvision_status",
          "clawvision_streams",
          "clawvision_stop",
        ],
      },
    );
  },
});

export default plugin;
