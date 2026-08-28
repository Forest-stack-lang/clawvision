#!/usr/bin/env node
/**
 * ClawVision doctor — verifies your vision endpoint can do what ClawVision needs.
 *
 *   node scripts/doctor.mjs --endpoint http://localhost:8091/v1 --model my-model
 *
 * Options:
 *   --endpoint <url>     OpenAI-compatible base URL (required)
 *   --model <id>         Model id (required)
 *   --api-key <key>      Bearer token (default: dummy)
 *   --frames <n>         Frames per packet in the multi-frame test (default: 4)
 *   --no-thinking        Send chat_template_kwargs.enable_thinking=false (vLLM)
 *   --extra '<json>'     Raw JSON merged into every request body
 *
 * Exit code 0 if ClawVision will work, 1 if something is broken.
 */

import { deflateSync } from "node:zlib";

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const ENDPOINT = (arg("endpoint") ?? "").replace(/\/+$/, "");
const MODEL = arg("model");
const API_KEY = arg("api-key", "dummy");
const FRAMES = Number(arg("frames", "4"));

let EXTRA = {};
if (flag("no-thinking")) EXTRA.chat_template_kwargs = { enable_thinking: false };
const extraRaw = arg("extra");
if (extraRaw) {
  try {
    EXTRA = { ...EXTRA, ...JSON.parse(extraRaw) };
  } catch {
    console.error("--extra must be valid JSON");
    process.exit(1);
  }
}

if (!ENDPOINT || !MODEL) {
  console.error("Usage: node scripts/doctor.mjs --endpoint <url> --model <id> [--no-thinking]");
  process.exit(1);
}

// ── minimal PNG encoder, so the doctor needs no image files or deps ─────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgbAt(x, y) -> [r, g, b] */
function makePng(width, height, rgbAt) {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbAt(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const SIZE = 256;
const BG = [40, 44, 52];

/** Dark frame, nothing in it. */
const emptyFrame = () => makePng(SIZE, SIZE, () => BG);

/** Dark frame with a large bright red circle, centre offset by `shift` px. */
const circleFrame = (shift = 0) =>
  makePng(SIZE, SIZE, (x, y) => {
    const cx = SIZE / 2 + shift;
    const cy = SIZE / 2;
    const d2 = (x - cx) ** 2 + (y - cy) ** 2;
    return d2 < 60 ** 2 ? [220, 50, 47] : BG;
  });

// ── request helper ──────────────────────────────────────────────────────────
const SYSTEM =
  "You are a real-time video evaluator for an AI assistant. Each tick you receive " +
  "frames from a live camera feed, context describing the situation, and a yes/no " +
  "question. Answer ONLY with the single word YES or NO. No punctuation, no " +
  "explanation, no other words.";

async function ask(images, text, { system = SYSTEM, maxTokens = 5 } = {}) {
  const content = images.map((buf) => ({
    type: "image_url",
    image_url: { url: `data:image/png;base64,${buf.toString("base64")}` },
  }));
  content.push({ type: "text", text });

  const started = Date.now();
  const res = await fetch(`${ENDPOINT}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content },
      ],
      max_tokens: maxTokens,
      stream: false,
      ...EXTRA,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const ms = Date.now() - started;

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  return { text: (data.choices?.[0]?.message?.content ?? "").trim(), ms };
}

const verdict = (raw) => {
  const n = raw.toUpperCase().replace(/[^A-Z]/g, "");
  return n.startsWith("YES") ? "YES" : n.startsWith("NO") ? "NO" : null;
};

// ── reporting ───────────────────────────────────────────────────────────────
const results = [];
const pass = (name, detail) => {
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  results.push(true);
};
const fail = (name, detail) => {
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  results.push(false);
};
const warn = (name, detail) => console.log(`  WARN  ${name}${detail ? ` — ${detail}` : ""}`);
const section = (t) => console.log(`\n${t}\n${"-".repeat(t.length)}`);

// ── tests ───────────────────────────────────────────────────────────────────
console.log(`\nClawVision doctor`);
console.log(`  endpoint  ${ENDPOINT}`);
console.log(`  model     ${MODEL}`);
console.log(`  extraBody ${Object.keys(EXTRA).length ? JSON.stringify(EXTRA) : "(none)"}`);

section("1. Node version");
{
  const [maj, min] = process.versions.node.split(".").map(Number);
  const ok = (maj === 22 && min >= 22) || (maj === 24 && min >= 15) || maj >= 25;
  ok
    ? pass("node", `v${process.versions.node}`)
    : fail("node", `v${process.versions.node}; OpenClaw needs 22.22.3+, 24.15+, or 25.9+`);
}

section("2. Endpoint reachable");
{
  try {
    const res = await fetch(`${ENDPOINT}/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      warn("GET /models", `HTTP ${res.status} — not fatal, some servers omit this route`);
    } else {
      const data = await res.json();
      const ids = (data.data ?? []).map((m) => m.id);
      ids.includes(MODEL)
        ? pass("model is served", MODEL)
        : warn("model not in /models", `served: ${ids.join(", ") || "(none listed)"}`);
    }
  } catch (err) {
    fail("endpoint unreachable", String(err));
    console.log("\nCannot continue without a reachable endpoint.\n");
    process.exit(1);
  }
}

section("3. Vision input accepted");
let visionOk = false;
{
  try {
    const r = await ask([circleFrame()], "Is there a red circle in this image? YES or NO only.");
    visionOk = true;
    pass("image accepted", `${r.ms}ms, replied ${JSON.stringify(r.text)}`);
  } catch (err) {
    fail("image rejected", String(err));
    console.log("\nThis model cannot take image input. ClawVision needs a vision model.\n");
    process.exit(1);
  }
}

section("4. Answers YES and NO correctly");
{
  try {
    const yes = await ask([circleFrame()], "Is there a red circle in this image? YES or NO only.");
    verdict(yes.text) === "YES"
      ? pass("positive case", `${yes.ms}ms`)
      : fail("positive case", `expected YES, got ${JSON.stringify(yes.text)}`);

    const no = await ask([emptyFrame()], "Is there a red circle in this image? YES or NO only.");
    verdict(no.text) === "NO"
      ? pass("negative case", `${no.ms}ms`)
      : fail("negative case", `expected NO, got ${JSON.stringify(no.text)}`);
  } catch (err) {
    fail("yes/no test", String(err));
  }
}

section("5. Obeys the one-word constraint");
{
  try {
    const r = await ask([circleFrame()], "Is there a red circle? YES or NO only.", { maxTokens: 60 });
    const words = r.text.split(/\s+/).filter(Boolean).length;
    if (words <= 2) pass("single-word answer", JSON.stringify(r.text));
    else if (verdict(r.text)) {
      warn("verbose but parseable", `${words} words — ClawVision will still read it`);
      results.push(true);
    } else {
      fail("unparseable", JSON.stringify(r.text.slice(0, 120)));
    }
  } catch (err) {
    fail("constraint test", String(err));
  }
}

section(`6. Multi-frame packet (${FRAMES} frames)`);
{
  try {
    const seq = Array.from({ length: FRAMES }, (_, i) =>
      i === 0 ? emptyFrame() : circleFrame((i - Math.floor(FRAMES / 2)) * 30),
    );
    const r = await ask(
      seq,
      "These frames are in chronological order. Does a red circle appear during them? YES or NO only.",
    );
    verdict(r.text) === "YES"
      ? pass("temporal reasoning", `${r.ms}ms for ${FRAMES} frames`)
      : fail("temporal reasoning", `expected YES, got ${JSON.stringify(r.text)}`);
    if (r.ms > 3000) {
      warn("slow", `${r.ms}ms per tick means roughly ${(1000 / r.ms).toFixed(1)} evaluations/sec`);
    }
  } catch (err) {
    fail("multi-frame", String(err));
  }
}

section("7. Sustained throughput (10 ticks)");
{
  try {
    const seq = Array.from({ length: FRAMES }, () => circleFrame());
    const times = [];
    for (let i = 0; i < 10; i++) {
      const r = await ask(seq, "Is a red circle visible? YES or NO only.");
      times.push(r.ms);
      process.stdout.write(`  tick ${String(i + 1).padStart(2)}  ${String(r.ms).padStart(5)}ms\r`);
    }
    // Ignore the first request; it pays cold-start and cache-warm costs.
    const warmed = times.slice(1);
    const avg = warmed.reduce((a, b) => a + b, 0) / warmed.length;
    const rate = 1000 / avg;
    console.log(" ".repeat(40));
    pass("throughput", `${avg.toFixed(0)}ms avg (first tick ${times[0]}ms), ~${rate.toFixed(1)} evaluations/sec`);

    if (rate < 0.33) {
      warn("very slow", "under 1 evaluation per 3s; raise packetSeconds and lower framesPerPacket");
    } else if (rate < 1) {
      warn("slow", "set maxTicksPerSecond to 1 and consider fewer framesPerPacket");
    }
    console.log(`\n  Suggested config for this setup:`);
    console.log(`    "framesPerPacket": ${FRAMES},`);
    console.log(`    "maxTicksPerSecond": ${Math.max(1, Math.min(4, Math.floor(rate)))},`);
    console.log(`    "packetSeconds": ${rate < 1 ? 5 : 3}`);
  } catch (err) {
    fail("throughput", String(err));
  }
}

section("8. Narration");
{
  try {
    const r = await ask(
      [circleFrame()],
      "Describe what is happening in these frames.",
      {
        system:
          "You are narrating a live camera feed. Describe what is happening in the frames " +
          "in one or two short factual sentences. Describe only what is visible.",
        maxTokens: 120,
      },
    );
    r.text.length > 10
      ? pass("narration", `${r.ms}ms: ${JSON.stringify(r.text.slice(0, 90))}`)
      : fail("narration", `empty or too short: ${JSON.stringify(r.text)}`);
  } catch (err) {
    fail("narration", String(err));
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r).length;
console.log(`\n${"=".repeat(56)}`);
if (failed === 0) {
  console.log(`All ${results.length} checks passed. ClawVision will work with this setup.`);
  console.log(`${"=".repeat(56)}\n`);
  process.exit(0);
} else {
  console.log(`${failed} of ${results.length} checks failed. See above.`);
  if (!visionOk) console.log(`\nThe model must accept image_url content parts.`);
  console.log(`${"=".repeat(56)}\n`);
  process.exit(1);
}
