import type { ResolvedConfig } from "./config.js";
import type { Frame, NarrationEntry } from "./state.js";
import { formatClock } from "./state.js";

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

const EVALUATOR_SYSTEM =
  "You are a real-time video evaluator for an AI assistant. Each tick you receive " +
  "frames from a live camera feed, context describing the situation, and a yes/no " +
  "question. Answer ONLY with the single word YES or NO. No punctuation, no " +
  "explanation, no other words.";

const NARRATOR_SYSTEM =
  "You are the narrator for an AI assistant watching a live camera feed. Your " +
  "notes are the assistant's memory of what happened while it was not looking, " +
  "and they are read later to decide whether something needs attention.\n\n" +
  "Describe what is happening in one or two short factual sentences. Describe " +
  "only what is visible; never speculate or address the reader.\n\n" +
  "When you are told what is being watched for, report on that above all else: " +
  "progress, position, and what changed since the previous note. Static " +
  "background that has already been described is not worth repeating.";

const SUMMARIZER_SYSTEM =
  "You summarize a log of camera narration into a concise paragraph suitable for " +
  "long-term memory. Cover what was observed, notable events, and the outcome if " +
  "one is clear. Be factual and brief.";

function toParts(frames: Frame[], text: string): ContentPart[] {
  const parts: ContentPart[] = frames.map((f) => ({
    type: "image_url" as const,
    image_url: { url: `data:${f.mime};base64,${f.data.toString("base64")}` },
  }));
  parts.push({ type: "text", text });
  return parts;
}

async function chat(
  cfg: ResolvedConfig,
  model: string,
  system: string,
  content: string | ContentPart[],
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = AbortSignal.timeout(cfg.requestTimeoutMs);
  const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const res = await fetch(`${cfg.endpoint}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
      max_tokens: maxTokens,
      stream: false,
      ...cfg.extraBody,
    }),
    signal: composite,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`vision endpoint ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

/**
 * Build the per-tick user message. Everything the evaluator knows about the
 * world lives here: the agent's context brief, optional project state, recent
 * narration for temporal awareness, and the current question.
 */
function buildEvaluationText(args: {
  context: string;
  question: string;
  projectState?: string;
  narration: NarrationEntry[];
}): string {
  const lines: string[] = [];
  lines.push("Context:");
  lines.push(args.context || "(none given)");
  if (args.projectState) {
    lines.push("", "Project state:", args.projectState);
  }
  if (args.narration.length > 0) {
    lines.push("", "Recent narration:");
    for (const n of args.narration) lines.push(`[${formatClock(n.t)}] ${n.text}`);
  }
  lines.push("", `Question: ${args.question}`, "", "Answer YES or NO only.");
  return lines.join("\n");
}

export type Verdict = "YES" | "NO";

/**
 * Returns YES/NO, or null when the model said something that is neither.
 * Callers treat null as "no decision this tick" rather than as NO, so a
 * misbehaving model never silently suppresses events.
 */
export async function evaluateFrames(
  cfg: ResolvedConfig,
  frames: Frame[],
  args: {
    context: string;
    question: string;
    projectState?: string;
    narration: NarrationEntry[];
    /** Older frames, oldest first, shown before the recent ones for comparison. */
    contextFrames?: Frame[];
  },
  signal?: AbortSignal,
): Promise<Verdict | null> {
  const older = args.contextFrames ?? [];
  const now = Date.now();
  const text = older.length > 0
    ? `The first ${older.length} image(s) are from earlier ` +
      `(${older.map((f) => `${Math.round((now - f.t) / 1000)}s ago`).join(", ")}), ` +
      `shown so you can see what has changed. The remaining ${frames.length} are ` +
      `the last few seconds.\n\n${buildEvaluationText(args)}`
    : buildEvaluationText(args);
  const raw = await chat(cfg, cfg.model, EVALUATOR_SYSTEM, toParts([...older, ...frames], text), 5, signal);
  const normalized = raw.toUpperCase().replace(/[^A-Z]/g, "");
  if (normalized.startsWith("YES")) return "YES";
  if (normalized.startsWith("NO")) return "NO";
  return null;
}

export async function narrateFrames(
  cfg: ResolvedConfig,
  frames: Frame[],
  previous: NarrationEntry[],
  watching?: { context?: string; question?: string },
  signal?: AbortSignal,
): Promise<string> {
  const parts: string[] = [];

  if (watching?.context || watching?.question) {
    parts.push("What is being watched:");
    if (watching.context) parts.push(watching.context);
    if (watching.question) parts.push(`The assistant is waiting to know: ${watching.question}`);
    parts.push("");
  }

  const tail = previous.slice(-3);
  if (tail.length > 0) {
    parts.push("Your previous notes:");
    for (const n of tail) parts.push(`[${formatClock(n.t)}] ${n.text}`);
    parts.push("");
    parts.push("Describe what is happening now, focusing on what has changed.");
  } else {
    parts.push("Describe what is happening in these frames.");
  }

  return chat(cfg, cfg.narratorModel, NARRATOR_SYSTEM, toParts(frames, parts.join("\n")), 120, signal);
}

export async function summarizeNarration(
  cfg: ResolvedConfig,
  narration: NarrationEntry[],
  signal?: AbortSignal,
): Promise<string> {
  if (narration.length === 0) return "No narration was recorded for this session.";
  const log = narration.map((n) => `[${formatClock(n.t)}] ${n.text}`).join("\n");
  return chat(cfg, cfg.narratorModel, SUMMARIZER_SYSTEM, log, 400, signal);
}
