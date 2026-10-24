#!/usr/bin/env node
'use strict';

/**
 * Podcast Studio — local server.
 *
 * - Serves the one-page web app from ./public
 * - Proxies Claude (script writing) and Fish Audio (voicing) so API keys never reach the browser
 * - Keys come from the environment / .env, or are entered in the browser on launch and held in memory only
 * - Zero npm dependencies (Node 18+)
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUTPUT_DIR = process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.join(ROOT, 'output');
const ENV_PATH = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(ROOT, '.env');

// ---------------------------------------------------------------- .env loading
function loadEnvFile(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val; // real env vars win
  }
}
loadEnvFile(ENV_PATH);

// ---------------------------------------------------------------- configuration
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const ANTHROPIC_BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const FISH_BASE = (process.env.FISH_BASE_URL || 'https://api.fish.audio').replace(/\/+$/, '');

const ENGINES = [
  { id: 's2.1-pro-free', label: 'S2.1 Pro · free tier', tagStyle: 'brackets' },
  { id: 's2.1-pro', label: 'S2.1 Pro', tagStyle: 'brackets' },
  { id: 's2-pro', label: 'S2 Pro', tagStyle: 'brackets' },
  { id: 'drama-3', label: 'Drama 3', tagStyle: 'brackets' },
  { id: 's1', label: 'S1 (legacy)', tagStyle: 'parens' },
];
const DEFAULT_ENGINE = ENGINES.some((e) => e.id === process.env.FISH_MODEL) ? process.env.FISH_MODEL : 's2.1-pro-free';
// Default narrator: "Narrator" by Rogen Darell Aban on Fish Audio. Override with FISH_VOICE_ID (a 32-character voice ID).
const DEFAULT_VOICE_ID = /^[0-9a-f]{32}$/i.test(process.env.FISH_VOICE_ID || '') ? process.env.FISH_VOICE_ID.toLowerCase() : '785ee4188c594830bc2ec7065817c1e1';

function cleanKey(v) {
  v = String(v || '').trim();
  if (!v || /^(your[-_ ]|xxx|changeme|<)/i.test(v)) return '';
  return v;
}

// API keys live here, in memory only. They are never returned by any endpoint.
const keys = {
  anthropic: cleanKey(process.env.ANTHROPIC_API_KEY),
  fish: cleanKey(process.env.FISH_AUDIO_API_KEY),
};

function redact(text) {
  let out = String(text ?? '');
  for (const k of Object.values(keys)) {
    if (k && k.length > 6) out = out.split(k).join('[redacted]');
  }
  return out;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- narrative (Claude)
// The system prompt has two parts: an editable style (shown in the app, this is the default) and fixed rules
// the app always appends, so an edited style can't break title parsing or the Fish Audio tag syntax.
const DEFAULT_SYSTEM_PROMPT = `You are the writer-narrator of a National Geographic-style natural-history documentary. You write voice-over scripts in the measured, reverent and quietly wry voice of the great nature-documentary narrators: the voice that turns a single journey into a field report from the edge of the world. An expressive text-to-speech voice will perform your script, so write for the ear, not the page.

THE GOAL
The listener should feel the story in their body, not just hear it described: the tightening shoulders, the held breath, the awe, the relief. Every image, rhythm and pause serves that feeling.

CRAFT
- Open in the middle of the sensation, not with throat-clearing. Then widen out to the place, its history and its reputation, the way a documentary cuts from a close-up to the landscape.
- Observe like a naturalist: give the people, the land, the weather and any wildlife the same patient, curious attention, and let one or two well-established facts about the place deepen the scene.
- Build in beats of rising tension toward a peak, then the release, then a reflective close.
- Be sensory and specific: sounds, textures, light, temperature, the body's reactions. Prefer concrete images to adjectives.
- Vary rhythm. Long, rolling sentences for awe; short, clipped ones at moments of fear. Let silence do work.
- Keep the narrator reverent, observant and a little wry, never melodramatic or cheesy. No clichés piled on top of each other, no profanity.
- Honour the producer's brief, including any first-person point of view. Do not invent named people, quotes, dates or statistics. Use only well-established facts, and say "roughly" or "about" when unsure.
- End well. Land the story on a closing image or reflection, then sign off with a short, warm goodbye to the listener in the narrator's own voice.`;

const PROMPT_RULES = `LENGTH
Write about {{words}} spoken words (tags and pauses excluded) so the finished audio runs about {{minutes}} minutes at a measured documentary pace. The final sentence must be complete and sound like an ending; never stop mid-thought or mid-scene.

AUDIO TAGS (Fish Audio S2 syntax: square brackets)
- Emotion or delivery tags go at the START of the sentence they colour: [calm] [curious] [nervous] [anxious] [scared] [worried] [determined] [relieved] [awestruck] [moved] [satisfied].
- Tone tags: [whispering] [soft tone] [low and tense] and [emphasis] placed directly before the word to stress. Free-form cues are allowed, e.g. [hushed, reverent] or [voice tightening].
- Sound tags: [sighing] [gasping] [panting] [clear throat].
- Pauses: [break] (short) between phrases, [long-break] at most 4 times for the biggest beats.
- One primary emotion per sentence, at most three stacked tags, and do not tag every sentence: roughly one tag for every one to two sentences. Shift emotion gradually.
- Never put tags inside quotation marks, never use parentheses for directions, and never describe sounds in prose brackets such as [wind howls] unless it is a tone cue.

OUTPUT FORMAT (strict)
Line 1: TITLE: <a short evocative episode title>
Line 2: blank
Then the script only: plain paragraphs separated by blank lines. No markdown, no headings, no speaker labels, no stage directions outside square brackets, no emojis, no commentary before or after.`;

function buildSystemPrompt(minutes, style) {
  const rules = PROMPT_RULES.replaceAll('{{words}}', String(Math.round(minutes * 135))).replaceAll('{{minutes}}', String(minutes));
  return `${String(style || '').trim() || DEFAULT_SYSTEM_PROMPT}\n\n${rules}`;
}

function stripTags(text) {
  return String(text).replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}
function spokenWords(text) {
  const t = stripTags(text);
  return t ? t.split(' ').length : 0;
}

function parseNarrative(raw) {
  let t = String(raw || '').trim().replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```$/, '').trim();
  let title = 'Untitled Episode';
  const m = t.match(/^\s*TITLE:\s*(.+?)\s*(?:\r?\n|$)/i);
  if (m) {
    title = m[1].replace(/[*#_`"]/g, '').trim() || title;
    t = t.slice(m[0].length).trim();
  }
  t = t.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  if (!t) throw new HttpError(502, 'Claude returned an empty script. Please try again.');
  return { title, script: t };
}

async function callClaude(system, messages, maxTokens) {
  const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': keys.anthropic,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages }),
    signal: AbortSignal.timeout(360_000),
  });
  const bodyText = await res.text();
  let data = {};
  try {
    data = JSON.parse(bodyText);
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const msg = data?.error?.message || bodyText.slice(0, 300) || res.statusText;
    if (res.status === 401) throw new HttpError(401, 'Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY.');
    if (res.status === 429) throw new HttpError(429, 'Anthropic rate limit reached. Wait a moment and try again.');
    throw new HttpError(502, `Claude error (${res.status}): ${redact(msg)}`);
  }
  // A cut-off reply would otherwise be voiced as-is and end mid-sentence.
  if (data.stop_reason === 'max_tokens') throw new HttpError(502, 'Claude ran out of room before finishing, so the script was cut off. Please try again.');
  if (data.stop_reason === 'refusal') throw new HttpError(502, 'Claude declined to write this script. Try rewording the brief.');
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function handleNarrative(body) {
  requireKey('anthropic');
  const instructions = String(body.instructions || '').trim().slice(0, 8000);
  if (!instructions) throw new HttpError(400, 'Describe what the narrative should be about first.');
  const minutes = Math.min(15, Math.max(1, Number(body.minutes) || 5));
  const target = Math.round(minutes * 135);
  const system = buildSystemPrompt(minutes, String(body.system || '').slice(0, 20000));

  const messages = [
    { role: 'user', content: `Brief from the producer:\n\n${instructions}\n\nWrite the complete ${minutes}-minute voice-over script now.` },
  ];
  const prev = body.previous;
  const feedback = String(body.feedback || '').trim().slice(0, 4000);
  if (prev && typeof prev.script === 'string' && feedback) {
    messages.push(
      { role: 'assistant', content: `TITLE: ${String(prev.title || 'Untitled').slice(0, 200)}\n\n${prev.script.slice(0, 30000)}` },
      {
        role: 'user',
        content: `Revise the script using this feedback from the producer:\n\n${feedback}\n\nKeep the same output format and the ~${target} spoken-word target. Return the complete revised script.`,
      },
    );
  }

  // Sonnet thinks before writing and those tokens count against max_tokens (~2.5K on a 5-minute script), so leave plenty of room.
  const maxTokens = 16000;
  let text = await callClaude(system, messages, maxTokens);
  let result = parseNarrative(text);

  // One corrective pass if the length is far from the requested duration.
  const words = spokenWords(result.script);
  if (words < target * 0.85 || words > target * 1.15) {
    try {
      const direction = words < target ? 'expand it with richer sensory detail and additional beats' : 'tighten it';
      const retry = await callClaude(
        system,
        [
          ...messages,
          { role: 'assistant', content: text },
          {
            role: 'user',
            content: `That script is about ${words} spoken words, but the target is ${target} (a ${minutes}-minute piece). Rewrite it so it lands within 5% of ${target} spoken words: ${direction}. Keep the quality, tags and format. Return the complete script.`,
          },
        ],
        maxTokens,
      );
      const second = parseNarrative(retry);
      if (Math.abs(spokenWords(second.script) - target) < Math.abs(words - target)) result = second;
    } catch {
      /* keep the first draft */
    }
  }
  return { ...result, targetWords: target, minutes, model: CLAUDE_MODEL };
}

// ---------------------------------------------------------------- audio (Fish Audio)
const S1_TAGS = new Set([
  'happy', 'sad', 'angry', 'excited', 'calm', 'nervous', 'confident', 'surprised', 'satisfied', 'delighted',
  'scared', 'worried', 'upset', 'frustrated', 'depressed', 'empathetic', 'embarrassed', 'disgusted', 'moved',
  'proud', 'relaxed', 'grateful', 'curious', 'sarcastic', 'disdainful', 'unhappy', 'anxious', 'hysterical',
  'indifferent', 'uncertain', 'doubtful', 'confused', 'disappointed', 'regretful', 'guilty', 'ashamed',
  'jealous', 'envious', 'hopeful', 'optimistic', 'pessimistic', 'nostalgic', 'lonely', 'bored', 'contemptuous',
  'sympathetic', 'compassionate', 'determined', 'resigned', 'in a hurry tone', 'shouting', 'screaming',
  'whispering', 'soft tone', 'emphasis', 'laughing', 'chuckling', 'sobbing', 'crying loudly', 'sighing',
  'groaning', 'panting', 'gasping', 'yawning', 'snoring', 'break', 'long-break',
]);

/** S1 uses (parentheses) and a fixed tag set; S2-family models use [brackets] and accept free-form cues. */
function prepareText(script, tagStyle) {
  let text = String(script).replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (tagStyle === 'parens') {
    text = text
      .replace(/\[([^\]]+)\]/g, (_m, inner) => {
        const known = inner.split(/[,;]/).map((s) => s.trim().toLowerCase()).filter((s) => S1_TAGS.has(s));
        return known.map((k) => `(${k})`).join('');
      })
      .replace(/[ \t]{2,}/g, ' ');
  }
  return text;
}

function chunkText(text, maxLen = 2500) {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = '';
  };
  for (const p of paragraphs) {
    if (p.length > maxLen) {
      push();
      for (const s of p.split(/(?<=[.!?])\s+/)) {
        if ((cur + ' ' + s).length > maxLen) push();
        cur += (cur ? ' ' : '') + s;
      }
      push();
    } else if ((cur + '\n\n' + p).length > maxLen) {
      push();
      cur = p;
    } else {
      cur += (cur ? '\n\n' : '') + p;
    }
  }
  push();
  return chunks;
}

async function fishTts(text, { engine, voiceId, speed }) {
  const body = {
    text,
    format: 'mp3',
    mp3_bitrate: 128,
    normalize: true,
    latency: 'normal',
    language: 'en',
    temperature: 0.7,
    top_p: 0.7,
    prosody: { speed, volume: 0, normalize_loudness: true },
  };
  if (voiceId) body.reference_id = voiceId;
  const res = await fetch(`${FISH_BASE}/v1/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${keys.fish}`, 'Content-Type': 'application/json', model: engine },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j.message || j.detail || j.reason || JSON.stringify(j);
    } catch {
      /* ignore */
    }
    const err = new HttpError(res.status, '');
    if (res.status === 401) err.message = 'Fish Audio rejected the API key (401). Check FISH_AUDIO_API_KEY.';
    else if (res.status === 402) {
      // API credit is billed separately from a fish.audio web subscription, so say which one ran out.
      const label = ENGINES.find((e) => e.id === engine)?.label || engine;
      err.message =
        `Fish Audio won't voice this with ${label} (402): ${redact(detail || 'insufficient API credit.')} ` +
        'API credit is separate from a fish.audio web subscription — add API credit at https://fish.audio/app/developers, or switch to the S2.1 Pro · free tier engine.';
    }
    else if (res.status === 429) err.message = 'Fish Audio rate limit reached (429). Wait a moment and try again.';
    else if (res.status === 503) err.message = 'Fish Audio is under high load (503). Try again shortly.';
    else err.message = `Fish Audio error (${res.status}): ${redact(detail || res.statusText)}`;
    err.upstreamStatus = res.status;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new HttpError(502, 'Fish Audio returned an empty audio stream.');
  return buf;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'episode';
}

async function handleAudio(body) {
  requireKey('fish');
  const script = String(body.script || '').trim();
  if (script.length < 20) throw new HttpError(400, 'The script is empty.');
  if (script.length > 40000) throw new HttpError(400, 'The script is too long (limit 40,000 characters).');
  const engineDef = ENGINES.find((e) => e.id === body.engine) || ENGINES.find((e) => e.id === DEFAULT_ENGINE);
  const speed = Math.min(2, Math.max(0.5, Number(body.speed) || 1));
  const voiceId = /^[A-Za-z0-9_-]{8,64}$/.test(String(body.voiceId || '')) ? String(body.voiceId) : '';
  const title = String(body.title || 'Untitled Episode').slice(0, 200);
  const text = prepareText(script, engineDef.tagStyle);

  let audio;
  let chunks = 1;
  try {
    audio = await fishTts(text, { engine: engineDef.id, voiceId, speed });
  } catch (err) {
    // If the single request is rejected for size/shape, retry as paragraph-sized pieces.
    if ([400, 413, 422].includes(err.upstreamStatus) && text.length > 2500) {
      const parts = chunkText(text);
      const bufs = [];
      for (const part of parts) bufs.push(await fishTts(part, { engine: engineDef.id, voiceId, speed }));
      audio = Buffer.concat(bufs);
      chunks = parts.length;
    } else {
      throw err;
    }
  }

  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const file = `${stamp}-${slugify(title)}.mp3`;
  await fsp.writeFile(path.join(OUTPUT_DIR, file), audio);
  const meta = {
    file,
    title,
    createdAt: new Date().toISOString(),
    engine: engineDef.id,
    voiceId: voiceId || null,
    voiceTitle: String(body.voiceTitle || (voiceId ? 'Custom voice' : 'Engine voice')).slice(0, 120),
    voiceAuthor: voiceId && body.voiceAuthor ? String(body.voiceAuthor).slice(0, 120) : null,
    speed,
    words: spokenWords(script),
    bytes: audio.length,
    chunks,
    script,
  };
  await fsp.writeFile(path.join(OUTPUT_DIR, file.replace(/\.mp3$/, '.json')), JSON.stringify(meta, null, 2));
  return { ...meta, url: `/audio/${encodeURIComponent(file)}`, savedTo: path.join('output', file) };
}

function voiceItem(m) {
  return {
    id: m._id || m.id,
    title: m.title,
    description: String(m.description || '').slice(0, 200),
    tags: (m.tags || []).slice(0, 4),
    sample: m.samples?.[0]?.audio || null,
    author: m.author?.nickname || null,
    authorId: m.author?._id || null,
  };
}

async function fishGet(pathAndQuery) {
  const res = await fetch(`${FISH_BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${keys.fish}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    if (res.status === 401) throw new HttpError(401, 'Fish Audio rejected the API key (401).');
    throw new HttpError(502, `Could not load voices (${res.status}).`);
  }
  return res.json();
}

/**
 * Voice search. Fish Audio only matches voice titles, so also accept a voice ID or fish.audio link in `q`
 * (direct lookup) and `author=<creator id>` (that creator's voices).
 */
async function handleVoices(url) {
  requireKey('fish');
  const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
  const author = (url.searchParams.get('author') || '').trim();
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);

  const id = q.match(/(?:^|[^0-9a-f])([0-9a-f]{32})(?:[^0-9a-f]|$)/i)?.[1];
  if (id) {
    const m = await fishGet(`/model/${id.toLowerCase()}`);
    const items = m ? [voiceItem(m)] : [];
    return { total: items.length, page: 1, items };
  }

  const params = new URLSearchParams({ page_size: '12', page_number: String(page), sort_by: 'score' });
  if (/^[0-9a-f]{32}$/i.test(author)) params.set('author_id', author);
  else params.set('language', 'en');
  if (q) params.set('title', q.slice(0, 80));
  const data = (await fishGet(`/model?${params}`)) || {};
  const items = (data.items || []).map(voiceItem);
  return { total: data.total ?? items.length, page, items };
}

async function listEpisodes() {
  let names = [];
  try {
    names = await fsp.readdir(OUTPUT_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(OUTPUT_DIR, n), 'utf8'));
      if (meta.file && fs.existsSync(path.join(OUTPUT_DIR, meta.file))) {
        out.push({ ...meta, url: `/audio/${encodeURIComponent(meta.file)}` });
      }
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function handleDelete(body) {
  const file = String(body.file || '');
  // Same rule as serving audio: a bare .mp3 name inside OUTPUT_DIR, no paths.
  if (!/^[A-Za-z0-9._-]+\.mp3$/.test(file) || file.startsWith('.')) throw new HttpError(400, 'Not a valid episode file name.');
  const mp3 = path.join(OUTPUT_DIR, file);
  try {
    await fsp.unlink(mp3);
  } catch {
    throw new HttpError(404, 'That episode no longer exists.');
  }
  await fsp.unlink(mp3.replace(/\.mp3$/, '.json')).catch(() => {});
  return { deleted: file };
}

// ---------------------------------------------------------------- keys
function requireKey(which) {
  if (!keys[which]) {
    const name = which === 'anthropic' ? 'Anthropic (Claude)' : 'Fish Audio';
    throw new HttpError(401, `No ${name} API key is set. Open Keys and add it.`);
  }
}

function validKeyShape(k) {
  return typeof k === 'string' && /^[\x21-\x7e]{8,512}$/.test(k.trim());
}

async function upsertEnv(updates) {
  let txt = '';
  try {
    txt = await fsp.readFile(ENV_PATH, 'utf8');
  } catch {
    /* new file */
  }
  const lines = txt ? txt.split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  const out = lines.filter((l, i) => !(l === '' && i === lines.length - 1)).join('\n') + '\n';
  await fsp.writeFile(ENV_PATH, out, { mode: 0o600 });
  await fsp.chmod(ENV_PATH, 0o600).catch(() => {});
}

async function handleKeys(body) {
  const updates = {};
  if (body.anthropic) {
    if (!validKeyShape(body.anthropic)) throw new HttpError(400, 'That Anthropic key does not look valid.');
    const candidate = body.anthropic.trim();
    // Cheap authenticated call so a typo is caught immediately. Network trouble does not block saving.
    try {
      const r = await fetch(`${ANTHROPIC_BASE}/v1/models?limit=1`, {
        headers: { 'x-api-key': candidate, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 401 || r.status === 403) throw new HttpError(401, 'Anthropic rejected that API key.');
    } catch (e) {
      if (e instanceof HttpError) throw e;
    }
    updates.ANTHROPIC_API_KEY = candidate;
  }
  if (body.fish) {
    if (!validKeyShape(body.fish)) throw new HttpError(400, 'That Fish Audio key does not look valid.');
    updates.FISH_AUDIO_API_KEY = body.fish.trim();
  }
  if (!Object.keys(updates).length) throw new HttpError(400, 'No keys provided.');
  if (updates.ANTHROPIC_API_KEY) keys.anthropic = updates.ANTHROPIC_API_KEY;
  if (updates.FISH_AUDIO_API_KEY) keys.fish = updates.FISH_AUDIO_API_KEY;
  if (body.save === true) await upsertEnv(updates);
  return configPayload();
}

function configPayload() {
  return {
    hasKeys: { anthropic: !!keys.anthropic, fish: !!keys.fish },
    engines: ENGINES.map(({ id, label }) => ({ id, label })),
    defaultEngine: DEFAULT_ENGINE,
    claudeModel: CLAUDE_MODEL,
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    promptRules: PROMPT_RULES,
    defaultVoiceId: DEFAULT_VOICE_ID,
  };
}

// ---------------------------------------------------------------- HTTP plumbing
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const t = Buffer.concat(chunks).toString('utf8');
        resolve(t ? JSON.parse(t) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function hostAllowed(req) {
  // Blocks DNS-rebinding style access: only loopback host names are served.
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '');
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function serveAudio(req, res, name, download) {
  if (!/^[A-Za-z0-9._-]+\.mp3$/.test(name)) return sendJson(res, 404, { error: 'Not found' });
  const file = path.join(OUTPUT_DIR, name);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { error: 'Not found' });
  }
  const headers = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${name}"`;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start;
    let end;
    if (m) {
      if (m[1] === '' && m[2] !== '') {
        start = Math.max(0, st.size - parseInt(m[2], 10));
        end = st.size - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === '' ? st.size - 1 : Math.min(parseInt(m[2], 10), st.size - 1);
      }
    }
    if (!m || !(start >= 0) || start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; media-src 'self' https: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (!hostAllowed(req)) return sendJson(res, 403, { error: 'Forbidden host' });

    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (STATIC[p]) {
        const [f, type] = STATIC[p];
        const data = await fsp.readFile(path.join(PUBLIC_DIR, f));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      if (p === '/api/config') return sendJson(res, 200, configPayload());
      if (p === '/api/episodes') return sendJson(res, 200, { episodes: await listEpisodes() });
      if (p === '/api/voices') return sendJson(res, 200, await handleVoices(url));
      if (p.startsWith('/audio/')) return serveAudio(req, res, decodeURIComponent(p.slice(7)), url.searchParams.get('download') === '1');
      return sendJson(res, 404, { error: 'Not found' });
    }

    if (req.method === 'POST' && p.startsWith('/api/')) {
      if (!sameOrigin(req) || !/^application\/json/i.test(req.headers['content-type'] || '')) {
        return sendJson(res, 403, { error: 'Cross-origin request blocked' });
      }
      const body = await readBody(req);
      if (p === '/api/keys') return sendJson(res, 200, await handleKeys(body));
      if (p === '/api/narrative') return sendJson(res, 200, await handleNarrative(body));
      if (p === '/api/audio') return sendJson(res, 200, await handleAudio(body));
      if (p === '/api/delete') return sendJson(res, 200, await handleDelete(body));
      return sendJson(res, 404, { error: 'Not found' });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : `Unexpected error: ${err?.cause?.code || err?.message || err}`;
    if (!res.headersSent) sendJson(res, status >= 400 && status < 600 ? status : 500, { error: redact(message) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const shown = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${addr.port}`;
  console.log(`\n  Podcast Studio running at ${shown}`);
  console.log(`  Claude:      ${CLAUDE_MODEL} (${keys.anthropic ? 'key loaded' : 'no key — the app will ask for it'})`);
  console.log(`  Fish Audio:  ${DEFAULT_ENGINE} (${keys.fish ? 'key loaded' : 'no key — the app will ask for it'})`);
  console.log(`  Audio saved to: ${OUTPUT_DIR}\n`);
});

module.exports = { server };
