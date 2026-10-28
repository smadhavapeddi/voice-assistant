#!/usr/bin/env node
/**
 * Voice Assistant Demo — DigitalOcean App Platform
 *
 * "Talk to it" web widget showcasing the full voice round trip:
 *   speech-to-text  -> chat completion -> text-to-speech
 *
 * Important architecture note: DigitalOcean Serverless Inference does not
 * currently offer a speech-to-text / transcription endpoint (confirmed
 * against the published API reference — it has /v1/audio/speech for
 * text-to-speech, but no /v1/audio/transcriptions). So:
 *
 *   - Speech-to-text runs in the BROWSER, via the standard Web Speech API
 *     (SpeechRecognition). This is free, built into Chrome/Edge, and needs
 *     no backend. There's a text-input fallback for browsers that don't
 *     support it (e.g. Firefox).
 *   - The "thinking" step calls DigitalOcean's /v1/chat/completions.
 *   - The "talking back" step calls DigitalOcean's /v1/audio/speech — the
 *     one endpoint none of the other demos in this series touch.
 *
 * No external dependencies — Node.js 18+ standard library + built-in fetch
 * only. Listens on process.env.PORT (App Platform sets this).
 *
 * Env vars:
 *   MODEL_ACCESS_KEY   DigitalOcean Serverless Inference model access key.
 *                      Required unless DRY_RUN=true.
 *   CHAT_MODEL         Chat completion model (default: openai-gpt-oss-120b).
 *   TTS_MODEL          Text-to-speech model (default: qwen3-tts-voicedesign).
 *   TTS_VOICE          Voice name for synthesis (default: alloy).
 *   DRY_RUN            Set to "true" to use a canned mock reply + a locally
 *                       generated chime instead of calling the live API.
 *   PORT               HTTP port to listen on (App Platform sets this).
 */

'use strict';

const http = require('http');

const BASE_URL = 'https://inference.do-ai.run';
const CHAT_PATH = '/v1/chat/completions';
const SPEECH_PATH = '/v1/audio/speech';
const REQUEST_TIMEOUT_MS = 25000;

const MAX_BODY_BYTES = 32 * 1024;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 1000;
const MAX_TOTAL_CHARS = 6000;

const SYSTEM_PROMPT =
  "You are Nova, a friendly voice assistant demoing DigitalOcean Serverless Inference live on stage. " +
  'Keep the spoken part of your answer short — one to three sentences — since it will be read aloud by a ' +
  "text-to-speech voice. Be warm, upbeat, and clear. If asked who you are or how you work, mention you're " +
  'powered by DigitalOcean Serverless Inference: chat completions for thinking, and the audio/speech endpoint ' +
  'for talking.\n\n' +
  'Whenever a real, well-known, authoritative link would genuinely help — official DigitalOcean documentation ' +
  'for DigitalOcean-related questions, or a well-known reference such as Wikipedia for general-knowledge ' +
  'questions — include exactly one such link on its own line at the very end of your answer, as a plain URL ' +
  'starting with https://. Only include a link you are confident is real; never invent or guess a URL. Skip ' +
  "the link entirely if you aren't sure one is genuinely relevant and correct.";

// ---------------------------------------------------------------------------
// DigitalOcean Inference calls
// ---------------------------------------------------------------------------
async function callChat({ modelAccessKey, baseUrl, model, messages }) {
  const url = baseUrl.replace(/\/$/, '') + CHAT_PATH;
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${modelAccessKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      }),
    });
  } catch (err) {
    clearTimeout(timeout);
    return { content: null, error: err.name === 'AbortError' ? 'Chat request timed out.' : `Chat request failed: ${err.message}` };
  }
  clearTimeout(timeout);

  const latency_s = (Date.now() - start) / 1000;
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { content: null, error: `HTTP ${res.status}: ${errBody.slice(0, 300)}`, latency_s };
  }

  const data = await res.json();
  const usage = data.usage || {};
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return {
    content: content ? String(content).trim() : null,
    error: content ? null : 'Model returned an empty reply.',
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    latency_s,
  };
}

async function callSpeech({ modelAccessKey, baseUrl, model, voice, text }) {
  const url = baseUrl.replace(/\/$/, '') + SPEECH_PATH;
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${modelAccessKey}` },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: 'mp3',
        instructions: 'Speak naturally and warmly, like a friendly assistant.',
      }),
    });
  } catch (err) {
    clearTimeout(timeout);
    return { audioBase64: null, error: err.name === 'AbortError' ? 'Speech request timed out.' : `Speech request failed: ${err.message}` };
  }
  clearTimeout(timeout);

  const latency_s = (Date.now() - start) / 1000;
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { audioBase64: null, error: `HTTP ${res.status}: ${errBody.slice(0, 300)}`, latency_s };
  }

  const contentType = res.headers.get('content-type') || '';
  if (/^audio\//i.test(contentType)) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { audioBase64: buf.toString('base64'), mime: contentType.split(';')[0].trim(), error: null, latency_s };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { audioBase64: null, error: 'Could not parse the speech response.', latency_s };
  }
  const b64 = data.data && data.data[0] && data.data[0].b64_json;
  if (!b64) return { audioBase64: null, error: 'Speech response did not include audio data.', latency_s };
  return { audioBase64: b64, mime: 'audio/mpeg', error: null, latency_s };
}

// ---------------------------------------------------------------------------
// Dry-run mocks — a canned reply + a locally generated two-tone chime, so the
// whole pipeline (and the UI) can be demoed with no API key and no cost.
// ---------------------------------------------------------------------------
function mockChatReply(userText) {
  const snippet = userText.length > 80 ? userText.slice(0, 80) + '…' : userText;
  return (
    `Dry-run mode: in a live run I'd ask DigitalOcean's chat completions endpoint to answer "${snippet}", ` +
    "and include a relevant link when one applies — like this.\n" +
    'Flip DRY_RUN off and add a model access key to hear me for real!\n' +
    'https://docs.digitalocean.com/products/inference/'
  );
}

// Strips URLs out of a reply before it's sent to text-to-speech, so the voice
// doesn't read a raw link aloud — the link still appears (and is clickable)
// in the chat bubble, which gets the untouched reply text.
function stripLinksForSpeech(text) {
  let s = text.replace(/https?:\/\/[^\s)]+/g, '');
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/\n[ \t]*\n+/g, '\n').replace(/^\s+|\s+$/gm, '');
  s = s.trim();
  return s || text.trim();
}

function generateChimeWavBase64() {
  const sampleRate = 22050;
  const durationSec = 0.6;
  const numSamples = Math.floor(sampleRate * durationSec);
  const freqs = [659.25, 987.77]; // a friendly two-note chime (E5 -> B5)
  const data = Buffer.alloc(numSamples * 2); // 16-bit mono PCM

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const freq = i < numSamples / 2 ? freqs[0] : freqs[1];
    const envelope = Math.sin(Math.PI * (i / numSamples)); // fade in/out, no clicks
    const sample = Math.sin(2 * Math.PI * freq * t) * envelope * 0.35;
    const clamped = Math.max(-32767, Math.min(32767, Math.round(sample * 32767)));
    data.writeInt16LE(clamped, i * 2);
  }

  const byteRate = sampleRate * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]).toString('base64');
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  let msgs = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_MESSAGE_CHARS) }))
    .filter((m) => m.content.length > 0);

  if (msgs.length > MAX_MESSAGES) msgs = msgs.slice(msgs.length - MAX_MESSAGES);

  let total = msgs.reduce((sum, m) => sum + m.content.length, 0);
  while (total > MAX_TOTAL_CHARS && msgs.length > 1) {
    total -= msgs[0].content.length;
    msgs = msgs.slice(1);
  }
  return msgs;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Page — colorful "talk to it" widget
// ---------------------------------------------------------------------------
const PAGE_STYLE = `
  :root {
    --ink: #1a1333; --muted: #6b6180; --border: #e7e2f5; --bg: #f6f3ff; --card: #ffffff;
    --user-bubble: #0ea5a0; --assistant-bubble: #5b3df5; --accent-pink: #ff5da2; --accent-orange: #ffb020;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--ink);
  }
  header {
    background: radial-gradient(circle at 15% 20%, #ff5da2 0%, transparent 42%),
                radial-gradient(circle at 85% 0%, #ffb020 0%, transparent 38%),
                linear-gradient(120deg, #2a1a66, #5b3df5 55%, #0ea5a0);
    color: #fff; padding: 30px 28px 26px 28px;
  }
  header .title-row { display: flex; align-items: center; gap: 14px; }
  header h1 { margin: 0; font-size: 22px; }
  header p { margin: 6px 0 0 0; font-size: 13.5px; color: #e8e3ff; }
  .pipeline { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
  .pipeline .step { display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.25); border-radius: 999px; padding: 6px 12px; font-size: 12px; font-weight: 600; }
  .pipeline svg { width: 15px; height: 15px; flex: none; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 22px 20px 36px 20px; }
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 18px; box-shadow: 0 10px 30px rgba(91,61,245,0.07); margin-bottom: 18px; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .panel-head h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0; }
  .icon-btn { display: inline-flex; align-items: center; gap: 5px; background: #f1edff; color: #5b3df5; border: none; border-radius: 999px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .icon-btn:hover { background: #e4ddff; }
  .icon-btn svg { width: 13px; height: 13px; }

  .chat-log { max-height: 360px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
  .msg-row { display: flex; flex-direction: column; max-width: 84%; }
  .msg-row.user { align-self: flex-end; align-items: flex-end; }
  .msg-row.assistant { align-self: flex-start; align-items: flex-start; }
  .bubble { padding: 11px 15px; border-radius: 16px; font-size: 14.5px; line-height: 1.5; white-space: pre-wrap; }
  .bubble.user { background: var(--user-bubble); color: #fff; border-bottom-right-radius: 4px; }
  .bubble.assistant { background: #efeaff; color: #2a1a66; border-bottom-left-radius: 4px; }
  .msg-row.system { align-self: center; align-items: center; max-width: 92%; }
  .bubble.system { background: #fff4ea; color: #9a3412; border: 1px dashed #ffcf9e; font-size: 12.5px; font-style: italic; text-align: center; border-radius: 10px; }
  .bubble a { color: inherit; font-weight: 700; text-decoration: underline; text-underline-offset: 2px; }
  .bubble.user a { color: #fff; }
  .bubble-meta { font-size: 10.5px; color: var(--muted); margin-top: 3px; padding: 0 4px; }

  .interim { min-height: 18px; font-size: 13px; color: var(--muted); font-style: italic; text-align: center; margin: 6px 0; }

  .input-row { display: flex; gap: 8px; margin-top: 8px; }
  .input-row input[type="text"] { flex: 1; padding: 11px 14px; border: 1px solid var(--border); border-radius: 999px; font-size: 14px; font-family: inherit; }
  .send-btn { background: var(--assistant-bubble); color: #fff; border: none; border-radius: 999px; width: 42px; height: 42px; flex: none; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .send-btn:hover { background: #4a2fe0; }
  .send-btn:disabled, .mic-btn:disabled, .chip:disabled { opacity: .5; cursor: default; }
  .send-btn svg { width: 17px; height: 17px; }

  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 2px 0 14px 0; }
  .chip { background: #fff7e8; color: #b45309; border: 1px solid #ffe3ad; border-radius: 999px; padding: 6px 13px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .chip:hover { background: #ffecc4; }

  .mic-stage { display: flex; flex-direction: column; align-items: center; padding: 18px 0 6px 0; }
  .mic-btn {
    position: relative; width: 84px; height: 84px; border-radius: 50%; border: none; cursor: pointer;
    background: linear-gradient(135deg, #ff5da2, #5b3df5); color: #fff;
    display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 24px rgba(91,61,245,.35);
  }
  .mic-btn svg { width: 30px; height: 30px; position: relative; z-index: 2; }
  .mic-btn.listening { animation: pulse-ring 1.4s ease-out infinite; }
  @keyframes pulse-ring {
    0% { box-shadow: 0 10px 24px rgba(91,61,245,.35), 0 0 0 0 rgba(255,93,162,.55); }
    70% { box-shadow: 0 10px 24px rgba(91,61,245,.35), 0 0 0 22px rgba(255,93,162,0); }
    100% { box-shadow: 0 10px 24px rgba(91,61,245,.35), 0 0 0 0 rgba(255,93,162,0); }
  }
  .status-line { margin-top: 12px; font-size: 13.5px; color: var(--muted); text-align: center; min-height: 18px; }
  .note { font-size: 13px; color: var(--muted); margin-top: 14px; line-height: 1.6; text-align: center; }
  .mode-flag { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 3px 9px; border-radius: 999px; background: rgba(255,255,255,.22); color: #fff; margin-left: 10px; vertical-align: middle; }
  footer { text-align: center; font-size: 11px; color: var(--muted); padding: 10px 24px 28px 24px; }
`;

function micIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" stroke="currentColor" stroke-width="1.8"/><path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 18v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
}
function stopIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>';
}
function sendIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 12 20 4l-6 16-2.5-7L4 12Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
}
function trashIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function brainIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 4a3 3 0 0 0-3 3v1a2.5 2.5 0 0 0-1 4.5A2.5 2.5 0 0 0 6 17h1a3 3 0 0 0 3 3V4Zm6 0a3 3 0 0 1 3 3v1a2.5 2.5 0 0 1 1 4.5A2.5 2.5 0 0 1 18 17h-1a3 3 0 0 1-3 3V4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
}
function speakerIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 9v6h4l5 4V5L8 9H4Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M16.5 8.5a5 5 0 0 1 0 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M19 6a9 9 0 0 1 0 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
}
function waveMicIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
}
function robotIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="8" width="16" height="11" rx="4" fill="#fff" fill-opacity=".18" stroke="#fff" stroke-width="1.6"/><circle cx="9" cy="13.5" r="1.4" fill="#fff"/><circle cx="15" cy="13.5" r="1.4" fill="#fff"/><path d="M12 8V5m0 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>';
}

const CLIENT_SCRIPT = `
var history = [];
var isListening = false;
var recognition = null;
var SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
var busy = false;

function setStatus(text) {
  document.getElementById('statusLine').textContent = text;
}

function setBusy(flag) {
  busy = flag;
  document.getElementById('sendBtn').disabled = flag;
  document.getElementById('micBtn').disabled = flag;
  var chips = document.querySelectorAll('.chip');
  for (var i = 0; i < chips.length; i++) chips[i].disabled = flag;
}

function escapeHtmlClient(s) {
  var div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function linkify(text) {
  var escaped = escapeHtmlClient(text);
  return escaped.replace(/(https?:\\/\\/[^\\s<]+)/g, function (url) {
    var trail = '';
    var clean = url;
    var m = clean.match(/[.,;:!?)\\]]+$/);
    if (m) {
      trail = m[0];
      clean = clean.slice(0, clean.length - trail.length);
    }
    return '<a href="' + clean + '" target="_blank" rel="noopener noreferrer">' + clean + '</a>' + trail;
  });
}

function addBubble(role, text, metaText) {
  var log = document.getElementById('chatLog');
  var row = document.createElement('div');
  row.className = 'msg-row ' + role;
  var bubble = document.createElement('div');
  bubble.className = 'bubble ' + role;
  bubble.innerHTML = linkify(text);
  row.appendChild(bubble);
  if (metaText) {
    var meta = document.createElement('div');
    meta.className = 'bubble-meta';
    meta.textContent = metaText;
    row.appendChild(meta);
  }
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}

function clearConversation() {
  history = [];
  document.getElementById('chatLog').innerHTML = '';
  addBubble('assistant', "Hi, I'm Nova — DigitalOcean's demo voice assistant. Tap the mic or type below to chat!", null);
  setStatus('Tap the mic and speak, or type a message below.');
}

async function sendMessage(text) {
  if (busy) return;
  text = (text || '').trim();
  if (!text) return;

  addBubble('user', text, null);
  history.push({ role: 'user', content: text });

  document.getElementById('textInput').value = '';
  setStatus('Thinking...');
  setBusy(true);

  try {
    var res = await fetch('/api/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    var data = await res.json();

    if (!res.ok) {
      var errText = data.error || ('Request failed with status ' + res.status);
      addBubble('system', errText, null);
      setStatus('Tap the mic and speak, or type a message below.');
      setBusy(false);
      return;
    }

    history.push({ role: 'assistant', content: data.reply });

    var metaParts = [];
    if (typeof data.chatLatencyS === 'number') metaParts.push('thinking ' + data.chatLatencyS.toFixed(2) + 's');
    if (typeof data.speechLatencyS === 'number') metaParts.push('voice ' + data.speechLatencyS.toFixed(2) + 's');
    if (data.dryRun) metaParts.push('dry run');
    addBubble('assistant', data.reply, metaParts.join(' · '));

    if (data.audioBase64) {
      setStatus('Speaking...');
      var player = document.getElementById('player');
      player.src = 'data:' + data.audioMime + ';base64,' + data.audioBase64;
      player.onended = function () {
        setStatus('Tap the mic and speak, or type a message below.');
        setBusy(false);
      };
      player.play().catch(function () {
        setStatus('Tap the mic and speak, or type a message below.');
        setBusy(false);
      });
    } else {
      if (data.speechError) setStatus('Reply ready (voice failed: ' + data.speechError + ')');
      else setStatus('Tap the mic and speak, or type a message below.');
      setBusy(false);
    }
  } catch (err) {
    addBubble('system', 'Request failed: ' + err.message, null);
    setStatus('Tap the mic and speak, or type a message below.');
    setBusy(false);
  }
}

function updateMicUi(listening) {
  var btn = document.getElementById('micBtn');
  btn.classList.toggle('listening', listening);
  btn.innerHTML = listening ? ${JSON.stringify(stopIconSvg())} : ${JSON.stringify(micIconSvg())};
}

function toggleListening() {
  if (busy) return;
  if (!SpeechRecognitionImpl) {
    setStatus('Speech recognition is not supported in this browser (try Chrome or Edge) — type your message below instead.');
    return;
  }
  if (isListening) {
    if (recognition) recognition.stop();
    return;
  }

  recognition = new SpeechRecognitionImpl();
  recognition.lang = 'en-US';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  var finalTranscript = '';
  var lastInterim = '';

  recognition.onstart = function () {
    isListening = true;
    updateMicUi(true);
    setStatus('Listening... speak now.');
  };
  recognition.onresult = function (event) {
    var interim = '';
    for (var i = event.resultIndex; i < event.results.length; i++) {
      var transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalTranscript += transcript;
      else interim += transcript;
    }
    if (interim) lastInterim = interim;
    document.getElementById('interimText').textContent = finalTranscript + interim;
  };
  recognition.onerror = function (event) {
    var messages = {
      'no-speech': "I didn't hear anything — try again, a bit closer to the mic.",
      'audio-capture': 'No microphone was found. Check your mic and try again.',
      'not-allowed': 'Microphone access was blocked. Allow mic permission for this site and try again.',
      'service-not-allowed': 'Microphone access was blocked. Allow mic permission for this site and try again.',
      'network': 'A network error interrupted speech recognition. Try again.',
      'aborted': null,
    };
    var friendly = Object.prototype.hasOwnProperty.call(messages, event.error)
      ? messages[event.error]
      : ('Mic error: ' + event.error + '. Try again, or type your message below.');
    if (friendly) {
      addBubble('system', friendly, null);
      setStatus(friendly);
    }
  };
  recognition.onend = function () {
    isListening = false;
    updateMicUi(false);
    document.getElementById('interimText').textContent = '';
    // The browser sometimes ends recognition without ever marking a result
    // final (common for short one-shot phrases) — fall back to the last
    // interim transcript rather than silently giving up.
    var text = (finalTranscript || lastInterim).trim();
    if (text) {
      sendMessage(text);
    } else {
      addBubble('system', "I didn't catch that — try again, or type your message below.", null);
      setStatus('Tap the mic and speak, or type a message below.');
    }
  };

  try {
    recognition.start();
  } catch (err) {
    setStatus('Could not start the microphone: ' + err.message);
  }
}

document.addEventListener('DOMContentLoaded', function () {
  if (!SpeechRecognitionImpl) {
    setStatus("This browser doesn't support voice input (try Chrome or Edge) — type a message below to try the demo.");
  } else {
    setStatus('Tap the mic and speak, or type a message below.');
  }

  document.getElementById('micBtn').addEventListener('click', toggleListening);
  document.getElementById('sendBtn').addEventListener('click', function () {
    sendMessage(document.getElementById('textInput').value);
  });
  document.getElementById('textInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendMessage(document.getElementById('textInput').value);
  });
  document.getElementById('clearBtn').addEventListener('click', clearConversation);

  var chips = document.querySelectorAll('.chip');
  for (var i = 0; i < chips.length; i++) {
    chips[i].addEventListener('click', function () {
      sendMessage(this.getAttribute('data-text'));
    });
  }

  addBubble('assistant', "Hi, I'm Nova — DigitalOcean's demo voice assistant. Tap the mic or type below to chat!", null);
});
`;

const EXAMPLE_PROMPTS = [
  "What's the difference between a Droplet and a Kubernetes cluster?",
  'Recommend a simple setup for hosting a small Node.js app.',
  'Tell me one fun fact about the ocean.',
];

function landingPage({ dryRun, hasKey, chatModel, ttsModel, ttsVoice }) {
  const chips = EXAMPLE_PROMPTS.map((p) => `<button type="button" class="chip" data-text="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Voice Assistant Demo</title><style>${PAGE_STYLE}</style></head><body>
<header>
  <div class="title-row">
    ${robotIconSvg()}
    <div>
      <h1>Nova — Voice Assistant Demo${dryRun ? '<span class="mode-flag">dry run</span>' : ''}</h1>
      <p>DigitalOcean Serverless Inference — speech-to-text &rarr; chat completion &rarr; text-to-speech</p>
    </div>
  </div>
  <div class="pipeline">
    <span class="step">${waveMicIconSvg()} Your voice (browser speech-to-text)</span>
    <span class="step">${brainIconSvg()} DO chat completions thinks</span>
    <span class="step">${speakerIconSvg()} DO audio/speech talks back</span>
  </div>
</header>

<div class="wrap">
  <div class="panel">
    <div class="panel-head">
      <h2>Conversation</h2>
      <button type="button" class="icon-btn" id="clearBtn">${trashIconSvg()} Clear</button>
    </div>
    <div class="chat-log" id="chatLog"></div>
    <div class="interim" id="interimText"></div>

    <div class="mic-stage">
      <button type="button" class="mic-btn" id="micBtn">${micIconSvg()}</button>
      <div class="status-line" id="statusLine"></div>
    </div>

    <div class="chips">${chips}</div>

    <div class="input-row">
      <input type="text" id="textInput" placeholder="...or type a message">
      <button type="button" class="send-btn" id="sendBtn">${sendIconSvg()}</button>
    </div>

    <audio id="player" style="display:none;"></audio>

    <div class="note">
      ${dryRun
        ? `Running in <strong>dry-run mode</strong>: replies are canned and the "voice" is a locally generated chime, not real text-to-speech — no API calls, no cost. Set <code>DRY_RUN=false</code> and a valid <code>MODEL_ACCESS_KEY</code> to go live.`
        : hasKey
          ? `Running live — chat model <code>${escapeHtml(chatModel)}</code>, voice model <code>${escapeHtml(ttsModel)}</code> (voice: <code>${escapeHtml(ttsVoice)}</code>). Each turn is a small real usage charge.`
          : `<strong>No MODEL_ACCESS_KEY is configured</strong> — live requests will fail. Set it as an app-level secret, or set DRY_RUN=true to demo with mock data.`}
    </div>
  </div>
</div>
<footer>Unofficial internal demo. Speech-to-text runs locally in your browser (Web Speech API); DigitalOcean Serverless Inference powers the reply and the voice.</footer>
<script>${CLIENT_SCRIPT}</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 8080;
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
const MODEL_ACCESS_KEY = process.env.MODEL_ACCESS_KEY || null;
const CHAT_MODEL = process.env.CHAT_MODEL || 'openai-gpt-oss-120b';
const TTS_MODEL = process.env.TTS_MODEL || 'qwen3-tts-voicedesign';
const TTS_VOICE = process.env.TTS_VOICE || 'alloy';

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(landingPage({ dryRun: DRY_RUN, hasKey: !!MODEL_ACCESS_KEY, chatModel: CHAT_MODEL, ttsModel: TTS_MODEL, ttsVoice: TTS_VOICE }));
      return;
    }

    if (req.url === '/api/respond' && req.method === 'POST') {
      if (!DRY_RUN && !MODEL_ACCESS_KEY) {
        sendJson(res, 500, { error: "MODEL_ACCESS_KEY is not configured and DRY_RUN is not true. Set one of them in the app's environment variables." });
        return;
      }

      let body;
      try {
        body = await readRequestBody(req);
      } catch (err) {
        sendJson(res, 413, { error: 'Request body too large.' });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (err) {
        sendJson(res, 400, { error: 'Request body must be valid JSON.' });
        return;
      }

      const messages = sanitizeMessages(payload.messages);
      if (messages.length === 0) {
        sendJson(res, 400, { error: 'Field "messages" must include at least one non-empty user or assistant message.' });
        return;
      }
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
      if (!lastUserMsg) {
        sendJson(res, 400, { error: 'The conversation must include at least one user message.' });
        return;
      }

      let reply, chatLatencyS, speechAudio, speechError, speechLatencyS;

      if (DRY_RUN) {
        reply = mockChatReply(lastUserMsg.content);
        chatLatencyS = 0.35 + Math.random() * 0.2;
        speechAudio = { audioBase64: generateChimeWavBase64(), mime: 'audio/wav' };
        speechError = null;
        speechLatencyS = 0.2 + Math.random() * 0.15;
      } else {
        const chatResult = await callChat({ modelAccessKey: MODEL_ACCESS_KEY, baseUrl: BASE_URL, model: CHAT_MODEL, messages });
        if (chatResult.error) {
          console.error(`[chat] model=${CHAT_MODEL} error: ${chatResult.error}`);
          sendJson(res, 502, { error: `Chat completion failed: ${chatResult.error}` });
          return;
        }
        reply = chatResult.content;
        chatLatencyS = chatResult.latency_s;
        console.log(`[chat] model=${CHAT_MODEL} ok latency=${chatLatencyS != null ? chatLatencyS.toFixed(2) : '?'}s`);

        const speechResult = await callSpeech({
          modelAccessKey: MODEL_ACCESS_KEY,
          baseUrl: BASE_URL,
          model: TTS_MODEL,
          voice: TTS_VOICE,
          text: stripLinksForSpeech(reply),
        });
        speechLatencyS = speechResult.latency_s;
        if (speechResult.error) {
          console.error(`[speech] model=${TTS_MODEL} voice=${TTS_VOICE} error: ${speechResult.error}`);
          speechAudio = null;
          speechError = speechResult.error;
        } else {
          speechAudio = { audioBase64: speechResult.audioBase64, mime: speechResult.mime };
          speechError = null;
        }
      }

      sendJson(res, 200, {
        dryRun: DRY_RUN,
        reply,
        chatLatencyS,
        speechLatencyS,
        audioBase64: speechAudio ? speechAudio.audioBase64 : null,
        audioMime: speechAudio ? speechAudio.mime : null,
        speechError,
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error('Unhandled error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal error — check app logs.');
  }
});

server.listen(PORT, () => {
  console.log(`Voice assistant demo listening on :${PORT} (DRY_RUN=${DRY_RUN}, key configured=${!!MODEL_ACCESS_KEY}, chatModel=${CHAT_MODEL}, ttsModel=${TTS_MODEL})`);
});
