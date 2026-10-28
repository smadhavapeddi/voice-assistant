# Voice Assistant Demo — "Talk to it"

A colorful, single-page "talk to it" widget demoing the full voice round
trip: speech-to-text → chat completion → text-to-speech. Tap the mic (or
type), and Nova — a friendly demo assistant — answers out loud.

This is the one demo in this series that exercises DigitalOcean's
`/v1/audio/speech` endpoint, which the others don't touch.

Zero external dependencies — Node.js 18+ standard library (`http`, built-in
`fetch`) only. One file, `server.js`, is the whole backend; the UI is inline
HTML/CSS/vanilla JS with hand-drawn SVG icons (no icon library, no CDN).

## Important: how speech-to-text actually works here

DigitalOcean Serverless Inference does **not** currently have a
speech-to-text / transcription endpoint — I checked the published API
reference before building this, and the audio surface area is
`/v1/audio/speech` (text-to-speech) plus an async image/audio-generation
endpoint for fal.ai models. There's no `/v1/audio/transcriptions`.

So the architecture is:

1. **Speech-to-text** runs **in the browser**, using the standard
   [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API)
   (`SpeechRecognition`). This is free, built into Chrome and Edge, and
   needs no server round trip. There's a text-input fallback for browsers
   that don't support it (notably Firefox and Safari have little/no
   support).
2. **Thinking** calls DigitalOcean's `/v1/chat/completions`.
3. **Talking back** calls DigitalOcean's `/v1/audio/speech`, which returns
   base64-encoded audio that the browser plays directly.

This is an honest representation of what DigitalOcean's API currently
offers — not a workaround to hide — so the demo UI calls this out explicitly
in the "pipeline" strip under the header and in the footer.

## What it looks like

- A gradient header (pink/purple/teal) with a pipeline strip showing the
  three steps: 🎙️ your voice → 🧠 DO chat completions → 🔊 DO audio/speech.
- A chat log with colored bubbles (teal for you, purple for Nova).
- A big circular mic button that pulses while listening, with live
  "interim" transcript text shown as you talk.
- Three quick-start chips with example questions, for when mic access isn't
  reliable in a live room (conference wifi, stage audio, etc.).
- A text input fallback that always works, mic or no mic.
- Each assistant reply shows small timing metadata (thinking time, voice
  generation time) — nice for a technical audience.

## Run it locally

```bash
cd voice-assistant-demo
DRY_RUN=true PORT=8080 node server.js
# open http://localhost:8080 in Chrome or Edge for mic support
```

To hit the real API locally instead:

```bash
export MODEL_ACCESS_KEY=sk-...
PORT=8080 node server.js
```

### Env vars

| Var                | Default                 | Notes                                                                 |
|---------------------|--------------------------|------------------------------------------------------------------------|
| `MODEL_ACCESS_KEY`  | *(none)*                | Required unless `DRY_RUN=true`. Control Panel → Inference → Model Access Keys. |
| `CHAT_MODEL`        | `openai-gpt-oss-120b`   | Fast, cheap chat model for the "thinking" step.                       |
| `TTS_MODEL`         | `qwen3-tts-voicedesign` | Text-to-speech model, per DigitalOcean's `/v1/audio/speech` reference.|
| `TTS_VOICE`         | `alloy`                 | Voice name passed to the TTS model.                                   |
| `DRY_RUN`           | `false`                 | `true` = canned reply + a locally generated chime, no API calls, no cost. |
| `PORT`              | `8080`                  | App Platform sets this automatically.                                 |

In dry-run mode, you'll hear a short two-tone chime instead of real speech —
that's intentional (generating real speech audio without the API would mean
either faking it or adding a TTS dependency, which breaks the
zero-dependency design). The mock reply text in the chat bubble still shows
exactly what a live run would send to the API.

## Deploying to App Platform

This folder is ready to deploy as-is. See **`DEPLOY.md`** for the full
step-by-step (push to GitHub, fill in `app.yaml`, deploy with `doctl` or the
Control Panel, verify dry-run, then go live with a real key).

Quick version:

```bash
git init && git add . && git commit -m "Voice assistant demo"
git remote add origin https://github.com/<you>/voice-assistant-demo.git
git push -u origin main
# fill in github.repo in app.yaml, then:
doctl apps create --spec app.yaml
```

## Customizing for a specific demo

- Edit `SYSTEM_PROMPT` near the top of `server.js` to change Nova's
  persona, tone, or topic focus (e.g. narrow it to your product's domain).
- Edit `EXAMPLE_PROMPTS` to swap in questions relevant to the audience
  you're demoing for.
- Swap `TTS_VOICE` / `TTS_MODEL` to try different voices — check
  DigitalOcean's Inference model catalog for what's available.
- The conversation history sent to the API is capped (12 messages / 6,000
  characters combined) to keep cost and latency predictable in a live demo
  — raise `MAX_MESSAGES` / `MAX_TOTAL_CHARS` in `server.js` if you want a
  longer back-and-forth.

## Notes

- Mic access requires HTTPS (or localhost) in the browser — this is a
  browser security requirement for the Web Speech API, not something this
  app controls. App Platform serves over HTTPS by default, so this isn't an
  issue once deployed.
- If the chat completion succeeds but text-to-speech fails (rate limit,
  unsupported voice, etc.), the reply still shows as text in the chat log,
  with a note that the voice failed — the demo degrades gracefully instead
  of going silent.
- Browser support for `SpeechRecognition` varies — Chrome and Edge work
  well; Firefox and Safari have limited or no support. The text input
  always works regardless of browser.
