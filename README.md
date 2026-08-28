# ClawVision

Live video awareness for [OpenClaw](https://openclaw.ai).

ClawVision gives an OpenClaw agent eyes on a camera feed. It keeps a rolling
buffer of recent frames, continuously asks a vision model a yes/no question
about what it sees, narrates the scene in the background, and wakes the agent
with a clip when something worth its attention happens.

The agent is not in the loop for every frame. It sets what to watch for, then
goes back to whatever it was doing. ClawVision only interrupts when the answer
is YES.

## How it works

Three loops share one buffer:

- **Ingest** accepts JPEG frames over HTTP and keeps roughly the last 70
  seconds, dropping duplicates and throttling to a sane rate.
- **The watcher** samples a few recent frames plus a couple of older ones for
  context, sends them to a vision model with the current question, and reads
  back YES or NO. Nothing else.
- **The narrator** describes the scene every few seconds. Those notes become
  the agent's memory of what happened while it was not looking, and they get
  compacted into summaries as they pile up.

On YES, ClawVision writes a clip to the workspace and sends the agent a message
containing the question that fired, the narration it has not seen yet, and the
paths to the clip frames.

## Requirements

- **OpenClaw** 2026.5.17 or newer
- **Node** 22.22.3+, 24.15+, or 25.9+
- **A vision model** behind an OpenAI-compatible `/v1/chat/completions`
  endpoint that accepts `image_url` content parts
- **A frame source** — anything that can HTTP POST a JPEG

`ffmpeg` is not required today. It will be needed in 0.2.0 for video clips and
audio.

## Read this before you install

**Run the vision model locally.** ClawVision calls it continuously — several
times per second for as long as a stream is live, plus a narration call every
few seconds. That is thousands of image requests per hour. Against a hosted API
this gets expensive very fast. This is designed for a model on your own
hardware or LAN.

**It is not free even locally.** A watched stream will keep a GPU near full
utilisation for as long as it runs. That is the cost of continuous perception,
not a flaw in any particular setup — the model is doing inference several times
a second, indefinitely. Budget for it as a sustained load rather than an
occasional one.

For long or undemanding sessions — watching a door for a week, say — a smaller
and faster model is the sensible choice. Lowering `maxTicksPerSecond` and
`framesPerPacket` are the other levers, and the doctor script will tell you what
your hardware can actually sustain.

**Your agent should be able to see images.** ClawVision writes clips and tells
the agent to look at them. An agent without image support still gets the scene
narration and the YES verdict as text, which is enough to be useful, but it is
working from someone else's description instead of the footage. Noticeably
weaker.

## Install

    git clone https://github.com/Forest-stack-lang/clawvision.git
    cd clawvision
    npm install
    npm run build

Check your vision endpoint can do what ClawVision needs before going further:

    node scripts/doctor.mjs \
      --endpoint http://localhost:8000/v1 \
      --model your-model-id \
      --no-thinking

The doctor synthesises its own test images, so it needs no camera and no
network. It checks that the endpoint accepts images, answers YES and NO
correctly, respects a one-word constraint, and handles multi-frame packets,
then measures sustained throughput and prints config values tuned to what it
measured. Pass `--no-thinking` for vLLM-hosted reasoning models; reasoning
traces add seconds to what should be a one-word answer.

Then install and configure:

    openclaw plugins install --link /path/to/clawvision

Add to `openclaw.json`:

    {
      "plugins": {
        "entries": {
          "clawvision": {
            "enabled": true,
            "config": {
              "endpoint": "http://localhost:8000/v1",
              "model": "your-model-id",
              "framesPerPacket": 2,
              "maxTicksPerSecond": 4
            }
          }
        }
      }
    }

Restart the gateway:

    systemctl --user restart openclaw-gateway

You should see `clawvision: ready, ingest at /clawvision/frame` in the log.

### If the tools do not appear

OpenClaw's `tools.profile` setting strips tools that are not part of the named
profile, and that includes plugin tools. If the agent cannot see the
`clawvision_*` tools, grant them explicitly:

    {
      "agents": {
        "list": [
          {
            "id": "main",
            "tools": {
              "alsoAllow": [
                "clawvision_start", "clawvision_brief", "clawvision_status",
                "clawvision_streams", "clawvision_stop"
              ]
            }
          }
        ]
      }
    }

Do not use the top-level `tools.allow` for this. It is an exclusive allowlist,
and setting it will remove every other tool the agent has.

## Sending frames

POST raw JPEG bytes, one frame per request:

    curl -X POST "http://localhost:18789/clawvision/frame?stream=default" \
      -H "Content-Type: image/jpeg" \
      -H "Authorization: Bearer <your gateway token>" \
      --data-binary @frame.jpg

No multipart, no base64, no JSON wrapper. Just the bytes. The `stream` query
parameter names the camera; posting to a new name creates a new stream.

From a browser, the canvas API is the straightforward path:

    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    const video = document.createElement("video");
    video.srcObject = stream;
    await video.play();

    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d");

    setInterval(() => {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) =>
          fetch("http://localhost:18789/clawvision/frame?stream=default", {
            method: "POST",
            headers: {
              "Content-Type": "image/jpeg",
              Authorization: "Bearer <token>",
            },
            body: blob,
          }).catch(() => {}),
        "image/jpeg",
        0.7,
      );
    }, 100);

Send frames and forget them. Never block your capture loop on the response, and
do not retry failures — another frame is along in 100ms.

**Size the frames at the source.** ClawVision does not resize or re-encode, so
whatever you send is what the model sees, and image size drives latency more
than anything else. 640x480 at quality 0.7 is a good default. ClawVision
throttles to one frame per 100ms and rejects byte-identical consecutive frames,
so sending faster is harmless — the excess is discarded.

## Using it

Ask the agent to start watching:

> Start clawvision on the default stream. I'm soldering a board — watch for
> when I finish a joint or something goes wrong.

The agent calls `clawvision_start`, then `clawvision_brief` with the context
and a yes/no question. From then on it is hands-off until something fires.

Notifications return to whichever channel the watcher was set up from. Start it
over WhatsApp and events arrive on WhatsApp; start it in the web UI and they
arrive there.

### Writing good questions

The watcher is a vision-language model, not a motion detector. What you get out
depends almost entirely on the question.

Weak, and will either fire constantly or never:

- *Is a person visible?*
- *Has anything changed?*
- *Is the screen dark?*

Strong, and worth the model you are paying for:

- *Has the user finished the step they were working on, or hit a problem?*
- *Is there something here I could help with or automate for them?*
- *Is anyone showing signs of needing help — struggling, searching, stuck?*

YES should mean "this is worth interrupting someone about."

### Tools

| Tool | What it does |
|---|---|
| `clawvision_start` | Begin watching a stream. Resumes an existing session if one is running. |
| `clawvision_brief` | Set the context and question. This is what arms the watcher. Starts the stream if it is not running. |
| `clawvision_status` | Buffer state, feed liveness, tick rate, current question, recent narration. |
| `clawvision_streams` | Every known stream and what it is watching for. |
| `clawvision_stop` | Stop watching and get a summary of the session. |

## Configuration

Only `endpoint` and `model` are required.

### Model

| Key | Default | |
|---|---|---|
| `endpoint` | — | OpenAI-compatible base URL, no trailing `/chat/completions` |
| `model` | — | Model id for yes/no evaluation |
| `apiKey` | `dummy` | Bearer token; most local servers ignore it |
| `narratorModel` | same as `model` | Lets narration use a cheaper model |
| `extraBody` | `{}` | Merged into every request body |
| `requestTimeoutMs` | `30000` | |

`extraBody` is how backend-specific options get through. For vLLM reasoning
models you almost certainly want:

    "extraBody": { "chat_template_kwargs": { "enable_thinking": false } }

### Frames and pacing

| Key | Default | |
|---|---|---|
| `framesPerPacket` | `4` | Recent frames per evaluation. The main latency knob. |
| `packetSeconds` | `3` | Window those frames are sampled from |
| `contextFrames` | `2` | Older frames added for cross-tick awareness |
| `contextFrameSpacingSeconds` | `30` | Gap between context frames |
| `maxTicksPerSecond` | `4` | Ceiling on evaluation rate |
| `minFrameIntervalMs` | `100` | Ingest throttle |
| `bufferSeconds` | `30` | Widened automatically to cover `contextFrames` |
| `cooldownSeconds` | `15` | Quiet period after a YES |

Frame count dominates latency. Going from 6 images per tick to 4 more than
doubled throughput in testing. Two recent plus two context frames is a good
balance — two recent frames still show motion, and a context frame carries more
information than a third and fourth frame a fraction of a second apart.

### Narration

| Key | Default | |
|---|---|---|
| `narrationIntervalSeconds` | `10` | |
| `compactNarrationEverySeconds` | `300` | `0` disables compaction |
| `keepNarrationEntries` | `12` | Recent entries left uncompacted |

Near-identical consecutive notes are dropped, so a static scene does not fill
the log with restatements.

### Clips

| Key | Default | |
|---|---|---|
| `clipBeforeSeconds` | `4` | Pre-roll. Free — already buffered. |
| `clipAfterSeconds` | `0.5` | Post-roll. Pure latency; the agent hears nothing until it elapses. |
| `clipRetentionMinutes` | `30` | Older clips are deleted. `0` keeps everything. |
| `clipDir` | `<workspace>/clawvision/clips` | Must be inside the workspace or the agent cannot read it |

### Behaviour

| Key | Default | |
|---|---|---|
| `autoStart` | `true` | Create a session at gateway startup, no tool call needed |
| `autoStartStream` | `default` | |
| `defaultQuestion` | a general "anything worth speaking up about" question | `""` starts unarmed |
| `defaultContext` | a matching general context | |
| `notifyOnFeedOnline` | `true` | Announce when a camera comes online after being idle |
| `feedIdleSeconds` | `60` | Silence after which a stream counts as offline |

### Notification delivery

| Key | Default | |
|---|---|---|
| `agentId` | `main` | Agent that receives notifications |
| `openclawBin` | `openclaw` | Path to the CLI, if not on PATH |
| `openclawHome` | inherited | `OPENCLAW_HOME` for the notification call |

### Load

| Key | Default | |
|---|---|---|
| `maxConcurrentEvaluations` | `2` | In-flight evaluations across all streams |
| `maxConcurrentNarrations` | `1` | In-flight narrations across all streams |

These matter once several cameras run at once. Without them, N streams means N
times the concurrent load on the inference server; with them, adding cameras
degrades tick rate smoothly instead of thrashing. `clawvision_streams` reports
in-flight and queued depth.

### Security

| Key | Default | |
|---|---|---|
| `ingestToken` | none | Required as `X-ClawVision-Token` on the ingest route |

The ingest route already sits behind OpenClaw's plugin auth. `ingestToken` adds
a second check if your frame source cannot hold a gateway token.

## Suggested setup

A configuration that works well on a single machine with a local model:

    {
      "endpoint": "http://localhost:8000/v1",
      "model": "your-model-id",
      "extraBody": { "chat_template_kwargs": { "enable_thinking": false } },
      "framesPerPacket": 2,
      "contextFrames": 2,
      "maxTicksPerSecond": 4,
      "packetSeconds": 3,
      "narrationIntervalSeconds": 10,
      "cooldownSeconds": 15,
      "clipBeforeSeconds": 4,
      "clipAfterSeconds": 0.5
    }

Capture at 640x480, quality 0.7, ten frames per second. Run the doctor first and
use the numbers it prints — a slower model wants fewer ticks per second and a
wider packet window.

## How notifications reach the agent

ClawVision shells out to `openclaw agent --message`, the same interface any
external process would use.

This is deliberate, and worth explaining because it looks odd for code running
inside the gateway. The in-process alternatives do not do the job: next-turn
injections only decorate a turn the user was going to trigger anyway, and
scheduled session turns run in isolated cron sessions that cannot post into an
existing conversation. Neither wakes an idle agent, which is the entire point.
The CLI does, and it is a stable documented interface.

## Limitations

- **Clips are JPEG frames, not video.** OpenClaw agents have an image tool but
  no video tool, so a single mp4 would be unreadable to them today. Video is
  planned for 0.2.0.
- **No audio.** Planned for 0.2.0.
- **No resizing.** Frames go to the model as sent. Size them at the source.
- **The default question is generic.** It exists so a fresh install does
  something sensible. Replace it with a real one.

## Planned for 0.2.0

- **Video clips via ffmpeg** — one file instead of a directory of frames, and
  nothing for the agent to get wrong when naming files.
- **Audio**, muxed into the clip and sent alongside frames on models that
  support it. Nemotron Nano Omni takes video with an embedded audio track
  directly, and audio carries what vision misses: someone saying they are
  finished, a tool changing pitch, something falling out of frame.

## Portability

`src/config.ts`, `src/state.ts`, and `src/vision.ts` have no OpenClaw imports.
They are a standalone live-video evaluation loop that talks to any
OpenAI-compatible endpoint. Only `src/index.ts` is OpenClaw-specific. If you are
building for a different agent framework, those three files plus a thin adapter
are most of the work.

## License

MIT
