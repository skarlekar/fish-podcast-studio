'use strict';
// End-to-end smoke test: runs the real server against mock Claude + Fish Audio upstreams.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

const CLAUDE_KEY = 'sk-ant-test-0123456789';
const FISH_KEY = 'fish-test-0123456789';
const calls = { claude: [], tts: [], model: [], art: [], artFailNext: false };
const VOICE_ID = '785ee4188c594830bc2ec7065817c1e1';
const SARAH_ID = '933563129e564b19a115bedd57b7406a';
const OFFICIAL_ID = 'd8b0991f96b44e489422ca2ddf0bd31d'; // Fish Official account
const AUTHOR_ID = '9672b25f05dd4f7fa38257dea00ad01d';

// A real 1x1 PNG, standing in for the cover the browser renders from the illustration.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Minimal ID3v2.3 reader for the checks: returns { frames: { ID: Buffer }, audio: Buffer }. */
function readId3(buf) {
  assert.equal(buf.subarray(0, 3).toString('latin1'), 'ID3', 'starts with an ID3 tag');
  assert.equal(buf[3], 3, 'ID3v2.3');
  const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
  const frames = {};
  for (let i = 10; i + 10 <= 10 + size && buf[i] !== 0; ) {
    const id = buf.subarray(i, i + 4).toString('latin1');
    const len = buf.readUInt32BE(i + 4);
    frames[id] = buf.subarray(i + 10, i + 10 + len);
    i += 10 + len;
  }
  return { frames, audio: buf.subarray(10 + size) };
}
const id3Text = (b) => (b[0] === 1 ? b.subarray(3).toString('utf16le') : b.subarray(1).toString('latin1')).replace(/\0+$/, '');

const SCRIPT = (n) =>
  'TITLE: The Road to the Sky\n\n' +
  Array.from({ length: n }, (_, i) => `[nervous] The road bends again, and the valley drops away beneath the wheels, word${i}. [break]`).join('\n\n');

function mockUpstream() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url.startsWith('/v1/models')) return req.headers['x-api-key'] === CLAUDE_KEY ? json(200, { data: [] }) : json(401, { error: { message: 'bad key' } });
      if (req.url === '/v1/messages') {
        if (req.headers['x-api-key'] !== CLAUDE_KEY) return json(401, { error: { message: 'invalid x-api-key' } });
        const parsed = JSON.parse(body);
        // Illustration requests: answer with an SVG (unsafe parts included when the story says EVIL).
        if (/illustrator for Podcast Studio/.test(parsed.system)) {
          calls.art.push(parsed);
          if (calls.artFailNext) { calls.artFailNext = false; return json(500, { error: { message: 'art down' } }); }
          const evil = /EVIL/.test(parsed.messages[0].content);
          const svg = evil
            ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" onload="alert(1)"><script>alert(2)</script><foreignObject><div>x</div></foreignObject><image href="http://evil.example.com/x.png"/><rect width="400" height="400" fill="#123" onclick="steal()"/></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#123"/><circle cx="200" cy="120" r="30" fill="#fe9"/></svg>';
          return json(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: `Here you go:\n${svg}\n` }] });
        }
        calls.claude.push(parsed);
        // A brief containing CUTOFF simulates Claude hitting max_tokens mid-sentence.
        if (/CUTOFF/.test(parsed.messages[0].content)) {
          return json(200, { stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'TITLE: Cut\n\n[soft tone] I st' }] });
        }
        // First answer is far too short to force the length-correction pass.
        const text = calls.claude.length === 1 ? SCRIPT(3) : SCRIPT(40);
        return json(200, { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] });
      }
      if (req.url === '/v1/tts') {
        if (req.headers.authorization !== `Bearer ${FISH_KEY}`) return json(401, { message: 'unauthorized' });
        const parsed = JSON.parse(body);
        calls.tts.push({ model: req.headers.model, body: parsed });
        if (req.headers.model === 'drama-3') return json(402, { status: 402, message: 'Insufficient API credit. API credit is managed independently from platform credit. Please visit https://fish.audio/app/developers to view your API credit balance or add funds.' });
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(5000, 7)]));
      }
      if (req.url.startsWith('/model')) {
        if (req.headers.authorization !== `Bearer ${FISH_KEY}`) return json(401, {});
        calls.model.push(req.url);
        const one = req.url.match(/^\/model\/([0-9a-f]{32})$/);
        if (one) {
          if (one[1] !== VOICE_ID) return json(404, { message: 'not found' });
          return json(200, { _id: VOICE_ID, title: 'Narrator', tags: ['male'], samples: [], author: { _id: AUTHOR_ID, nickname: 'Rogen Darell Aban' } });
        }
        const qs = new URL(req.url, 'http://x').searchParams;
        if (qs.get('author_id') === OFFICIAL_ID) {
          const official = { _id: SARAH_ID, title: qs.get('title') ? 'Official Narrator' : 'Sarah', tags: ['female'], samples: [{ audio: 'https://example.com/o.mp3' }], author: { _id: OFFICIAL_ID, nickname: 'Fish Official' } };
          return json(200, { total: 30, items: [official] });
        }
        return json(200, { total: 1, items: [{ _id: 'abcdef1234567890', title: 'Doc Narrator', description: 'Warm', tags: ['narration'], samples: [{ audio: 'https://example.com/s.mp3' }], author: { _id: AUTHOR_ID, nickname: 'fish' } }] });
      }
      json(404, {});
    });
  });
}

let pass = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e}`); process.exitCode = 1; }
}

(async () => {
  const upstream = mockUpstream();
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const up = `http://127.0.0.1:${upstream.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-test-'));
  const port = 3900 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const envFile = path.join(tmp, '.env');
  // A tiny sample library, standing in for samples/ (checked separately below).
  const samplesDir = path.join(tmp, 'samples');
  fs.mkdirSync(samplesDir);
  fs.writeFileSync(path.join(samplesDir, 'sample-one.mp3'), Buffer.alloc(2000, 1));
  fs.writeFileSync(path.join(samplesDir, 'sample-one.txt'), '[calm] A sample.');
  fs.writeFileSync(path.join(samplesDir, 'sample-one.json'), JSON.stringify({ file: 'sample-one.mp3', title: 'Sample One', createdAt: '2026-01-01T00:00:00.000Z', engine: 's2.1-pro-free', transcript: 'sample-one.txt', script: '[calm] A sample.', coverOf: 'default', bytes: 2000 }));

  const startServer = (p) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        PATH: process.env.PATH, PORT: String(p), OUTPUT_DIR: path.join(tmp, 'output'), ENV_FILE: envFile, SAMPLES_DIR: samplesDir,
        ANTHROPIC_BASE_URL: up, FISH_BASE_URL: up, ANTHROPIC_API_KEY: '', FISH_AUDIO_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return new Promise((resolve, reject) => { proc.stdout.on('data', (d) => /running at/.test(String(d)) && resolve(proc)); proc.on('exit', reject); });
  };
  const child = await startServer(port);

  const get = (p, h) => fetch(base + p, { headers: h });
  const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
  let episode;

  console.log('Podcast Studio smoke test');
  await check('serves the one-page app', async () => {
    const r = await get('/');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Podcast Studio/);
  });
  await check('starts with no keys and asks for them', async () => {
    const c = await (await get('/api/config')).json();
    assert.deepEqual(c.hasKeys, { anthropic: false, fish: false });
    assert.equal(c.defaultEngine, 's2.1-pro-free');
    assert.ok(c.engines.length >= 4);
    assert.match(c.defaultSystemPrompt, /National Geographic/);
    assert.match(c.defaultSystemPrompt, /feel/i);
    assert.match(c.promptRules, /\{\{words\}\}/, 'rules template exposed for display');
    assert.equal(c.defaultVoiceId, SARAH_ID, 'Sarah (Fish Official) is the default voice');
  });
  await check('a fresh library starts with the sample episodes, copied once', async () => {
    const { episodes } = await (await get('/api/episodes')).json();
    const sample = episodes.find((e) => e.file === 'sample-one.mp3');
    assert.ok(sample, 'sample listed');
    assert.equal(sample.title, 'Sample One');
    assert.ok(sample.transcriptUrl, 'sample transcript available');
    assert.equal(sample.needsCover, false);
    assert.ok(fs.existsSync(path.join(tmp, 'output', '.samples-added')), 'marker written');
    // Deleted samples don't come back on the next start.
    assert.equal((await post('/api/delete', { file: 'sample-one.mp3' })).status, 200);
    const again = await startServer(port + 100);
    const eps = (await (await fetch(`http://127.0.0.1:${port + 100}/api/episodes`)).json()).episodes;
    again.kill();
    assert.ok(!eps.some((e) => e.file === 'sample-one.mp3'));
  });
  await check('the repo samples are complete, tagged and free of local paths', async () => {
    const dir = path.join(__dirname, '..', 'samples');
    const metas = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    assert.ok(metas.length >= 2);
    for (const n of metas) {
      const raw = fs.readFileSync(path.join(dir, n), 'utf8');
      assert.ok(!/\/Users\/|\\Users\\|\/home\//.test(raw), `${n}: no local paths`);
      const m = JSON.parse(raw);
      const mp3 = fs.readFileSync(path.join(dir, m.file));
      assert.equal(mp3.subarray(0, 3).toString('latin1'), 'ID3', `${m.file}: cover tag embedded`);
      assert.equal(m.coverOf, m.art || 'default', `${n}: embedded cover matches`);
      assert.ok(m.transcript && fs.existsSync(path.join(dir, m.transcript)), `${n}: transcript present`);
      if (m.art) assert.ok(fs.existsSync(path.join(dir, m.art)), `${n}: illustration present`);
    }
  });
  await check('refuses to call Claude without a key', async () => {
    assert.equal((await post('/api/narrative', { instructions: 'x' })).status, 401);
  });
  await check('rejects an invalid Anthropic key', async () => {
    assert.equal((await post('/api/keys', { anthropic: 'sk-ant-wrong-key-12345' })).status, 401);
  });
  await check('accepts keys, keeps them in memory, never echoes them', async () => {
    const r = await post('/api/keys', { anthropic: CLAUDE_KEY, fish: FISH_KEY });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(!text.includes(CLAUDE_KEY) && !text.includes(FISH_KEY));
    assert.deepEqual(JSON.parse(text).hasKeys, { anthropic: true, fish: true });
    assert.equal(fs.existsSync(envFile), false, '.env must not be written unless requested');
  });
  await check('writes .env (mode 600) only when asked', async () => {
    await post('/api/keys', { fish: FISH_KEY, save: true });
    assert.ok(fs.readFileSync(envFile, 'utf8').includes(`FISH_AUDIO_API_KEY=${FISH_KEY}`));
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  });
  await check('Claude narrative: Sonnet, length-correction pass, title parsed', async () => {
    const r = await post('/api/narrative', { instructions: 'A scary drive up Mount Washington', minutes: 5 });
    const n = await r.json();
    assert.equal(r.status, 200, JSON.stringify(n));
    assert.equal(n.title, 'The Road to the Sky');
    assert.match(n.script, /\[nervous\]/);
    assert.equal(calls.claude.length, 2);
    assert.equal(calls.claude[0].model, 'claude-sonnet-5-5');
    assert.match(calls.claude[0].system, /675 spoken words/);
    assert.match(calls.claude[0].system, /\[long-break\]/);
    assert.match(calls.claude[0].system, /goodbye/i, 'prompt asks for a sign-off');
    assert.match(calls.claude[0].system, /final sentence/i, 'prompt asks for a complete ending');
    assert.ok(calls.claude[0].max_tokens >= 16000, 'room for adaptive thinking plus the script');
    episode = n;
  });
  await check('an edited system prompt replaces the default; the fixed rules are still appended', async () => {
    calls.claude.length = 0;
    const r = await post('/api/narrative', { system: 'CUSTOM STYLE: write like a ship captain.', instructions: 'A storm at sea', minutes: 5 });
    assert.equal(r.status, 200);
    const sys = calls.claude[0].system;
    assert.ok(sys.startsWith('CUSTOM STYLE: write like a ship captain.'));
    assert.ok(!/National Geographic/.test(sys), 'default style not mixed in');
    assert.match(sys, /675 spoken words/);
    assert.match(sys, /OUTPUT FORMAT/);
    assert.match(sys, /final sentence/i);
  });
  await check('a blank system prompt falls back to the default', async () => {
    calls.claude.length = 0;
    await post('/api/narrative', { system: '   ', instructions: 'A storm at sea', minutes: 5 });
    assert.match(calls.claude[0].system, /National Geographic/);
  });
  await check('the page shows both prompts and sends the system prompt', async () => {
    const html = await (await get('/')).text();
    assert.match(html, /id="systemPrompt"[\s\S]*id="instructions"/);
    assert.match(html, /id="promptRules"/);
    assert.match(await (await get('/app.js')).text(), /system: \$\('#systemPrompt'\)/);
  });
  await check('a script cut off at max_tokens is rejected, never returned', async () => {
    calls.claude.length = 0;
    const r = await post('/api/narrative', { instructions: 'CUTOFF brief', minutes: 5 });
    const j = await r.json();
    assert.equal(r.status, 502);
    assert.match(j.error, /ran out of room|cut off/i);
    assert.ok(!j.script);
  });
  await check('revision sends the previous script and feedback', async () => {
    calls.claude.length = 0;
    const r = await post('/api/narrative', { instructions: 'x', minutes: 5, previous: episode, feedback: 'scarier' });
    assert.equal(r.status, 200);
    assert.ok(calls.claude[0].messages.some((m) => m.role === 'assistant'));
    assert.match(calls.claude[0].messages.at(-1).content, /scarier/);
  });
  await check('voices list proxied; official matches come first and are marked', async () => {
    calls.model.length = 0;
    const v = await (await get('/api/voices?q=narrator')).json();
    assert.deepEqual(v.items.map((i) => [i.title, i.official]), [['Official Narrator', true], ['Doc Narrator', false]]);
    const doc = v.items[1];
    assert.equal(doc.sample, 'https://example.com/s.mp3');
    assert.equal(doc.authorId, AUTHOR_ID);
    assert.ok(calls.model.some((u) => u.includes(`author_id=${OFFICIAL_ID}`) && u.includes('title=narrator')), 'official voices searched too');
  });
  await check('with no search, the official English voices are listed (paged)', async () => {
    calls.model.length = 0;
    const v = await (await get('/api/voices?page=2')).json();
    assert.equal(v.total, 30);
    assert.ok(v.items.length && v.items.every((i) => i.official));
    assert.equal(v.official, true);
    const u = calls.model.at(-1);
    assert.ok(u.includes(`author_id=${OFFICIAL_ID}`) && u.includes('language=en') && u.includes('page_number=2'), u);
  });
  await check('voice lookup by ID or fish.audio link', async () => {
    for (const q of [VOICE_ID, `https://fish.audio/m/${VOICE_ID}/`]) {
      const v = await (await get(`/api/voices?q=${encodeURIComponent(q)}`)).json();
      assert.equal(v.items.length, 1, q);
      assert.equal(v.items[0].id, VOICE_ID);
      assert.equal(v.items[0].author, 'Rogen Darell Aban');
      assert.equal(calls.model.at(-1), `/model/${VOICE_ID}`);
    }
    const missing = await (await get(`/api/voices?q=${'0'.repeat(32)}`)).json();
    assert.equal(missing.items.length, 0);
  });
  await check('voices by creator use author_id', async () => {
    const r = await get(`/api/voices?author=${AUTHOR_ID}`);
    assert.equal(r.status, 200);
    assert.match(calls.model.at(-1), new RegExp(`author_id=${AUTHOR_ID}`));
  });
  await check('audio: default engine s2.1-pro-free, bracket tags kept, file saved', async () => {
    const r = await post('/api/audio', { title: episode.title, script: episode.script, engine: 's2.1-pro-free', voiceId: 'abcdef1234567890', voiceTitle: 'Doc Narrator', voiceAuthor: 'fish', speed: 1 });
    const a = await r.json();
    assert.equal(r.status, 200, JSON.stringify(a));
    assert.equal(a.voiceTitle, 'Doc Narrator');
    assert.equal(a.voiceAuthor, 'fish');
    const t = calls.tts.at(-1);
    assert.equal(t.model, 's2.1-pro-free');
    assert.equal(t.body.reference_id, 'abcdef1234567890');
    assert.equal(t.body.format, 'mp3');
    assert.match(t.body.text, /\[nervous\]/);
    assert.ok(fs.existsSync(path.join(tmp, 'output', a.file)));
    episode.url = a.url;
  });
  await check('illustration: drawn from the script alongside the audio and served safely', async () => {
    calls.art.length = 0;
    const r = await post('/api/audio', { title: 'Skydive', script: '[nervous] The door slides open at thirteen thousand feet. Wind roars in.', engine: 's2.1-pro-free' });
    const a = await r.json();
    assert.equal(r.status, 200, JSON.stringify(a));
    assert.match(a.art, /\.svg$/);
    assert.equal(calls.art.length, 1);
    assert.match(calls.art[0].messages[0].content, /thirteen thousand feet/, 'story text sent to the illustrator');
    assert.match(calls.art[0].system, /style reference/i, 'current art given as the style reference');
    const img = await get(a.artUrl);
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(img.headers.get('content-security-policy') || '', /default-src 'none'/);
    const body = await img.text();
    assert.ok(body.startsWith('<svg') && body.includes('<circle'));
    const { episodes } = await (await get('/api/episodes')).json();
    assert.equal(episodes.find((e) => e.file === a.file).artUrl, a.artUrl);
  });
  await check('illustration: scripts, handlers, foreign content and external links are stripped', async () => {
    const a = await (await post('/api/audio', { title: 'Evil', script: 'EVIL story text that is long enough to voice.', engine: 's2.1-pro-free' })).json();
    const body = await (await get(a.artUrl)).text();
    for (const bad of ['<script', 'onload', 'onclick', 'foreignObject', 'evil.example.com']) assert.ok(!body.includes(bad), bad);
    assert.ok(body.includes('<rect'));
  });
  await check('illustration: a failed drawing never blocks the audio; it can be created later', async () => {
    calls.artFailNext = true;
    const a = await (await post('/api/audio', { title: 'No art yet', script: 'A quiet story long enough to voice here.', engine: 's2.1-pro-free' })).json();
    assert.ok(a.file && !a.art, 'audio saved without art');
    const r = await post('/api/illustrate', { file: a.file });
    const ep = await r.json();
    assert.equal(r.status, 200, JSON.stringify(ep));
    assert.match(ep.art, /\.svg$/);
    assert.equal((await get(ep.artUrl)).status, 200);
    const d = await post('/api/delete', { file: a.file });
    assert.equal(d.status, 200);
    assert.equal((await get(ep.artUrl)).status, 404, 'delete removes the illustration too');
    assert.equal((await post('/api/illustrate', { file: '../server.js' })).status, 400);
    assert.equal((await get('/art/..%2Fserver.js')).status, 404);
  });
  await check('audio transcript: the exact text sent to Fish Audio is saved and served', async () => {
    const script = '[calm]   The valley opens below.   \n\n\n\n[soft tone] We breathe.';
    const r = await post('/api/audio', { title: 'Transcript test', script, engine: 's2.1-pro-free' });
    const a = await r.json();
    assert.match(a.transcript, /\.txt$/);
    const res = await get(a.transcriptUrl);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    assert.equal(await res.text(), calls.tts.at(-1).body.text);
    assert.match((await get(`${a.transcriptUrl}?download=1`)).headers.get('content-disposition') || '', /attachment/);
    const { episodes } = await (await get('/api/episodes')).json();
    assert.equal(episodes.find((e) => e.file === a.file).transcriptUrl, a.transcriptUrl);
    // An older episode without a saved transcript reports none.
    const oldJson = path.join(tmp, 'output', a.file.replace(/\.mp3$/, '.json'));
    fs.copyFileSync(path.join(tmp, 'output', a.file), path.join(tmp, 'output', 'old-episode.mp3'));
    const meta = JSON.parse(fs.readFileSync(oldJson, 'utf8'));
    delete meta.transcript;
    fs.writeFileSync(path.join(tmp, 'output', 'old-episode.json'), JSON.stringify({ ...meta, file: 'old-episode.mp3' }));
    const after = (await (await get('/api/episodes')).json()).episodes;
    assert.equal(after.find((e) => e.file === 'old-episode.mp3').transcriptUrl, null);
    assert.equal((await post('/api/delete', { file: a.file })).status, 200);
    assert.equal((await get(a.transcriptUrl)).status, 404, 'delete removes the transcript too');
    assert.equal((await get('/transcript/..%2Fserver.js')).status, 404);
  });
  await check('voice list shows official voices first with an Official badge', async () => {
    const js = await (await get('/app.js')).text();
    assert.match(js, /'Official'/);
    assert.match(js, /function loadOfficialVoices/);
  });
  await check('library shows a Transcript button only when a transcript was saved', async () => {
    const html = await (await get('/')).text();
    assert.match(html, /id="transcriptDialog"/);
    const js = await (await get('/app.js')).text();
    assert.match(js, /if \(ep\.transcriptUrl\)/);
  });
  await check('cover art: the rendered PNG is embedded in the MP3 with title, narrator and album', async () => {
    const r = await post('/api/audio', { title: 'Cover Test “Ω”', script: 'A story about the sea, long enough to voice.', engine: 's2.1-pro-free', voiceId: SARAH_ID, voiceTitle: 'Sarah', voiceAuthor: 'Fish Official' });
    const a = await r.json();
    const mp3 = path.join(tmp, 'output', a.file);
    const original = fs.readFileSync(mp3);
    let ep = (await (await get('/api/episodes')).json()).episodes.find((e) => e.file === a.file);
    assert.equal(ep.needsCover, true, 'a new episode needs its cover embedded');
    const c = await post('/api/cover', { file: a.file, png: PNG_1PX });
    assert.equal(c.status, 200, await c.clone().text());
    const tagged = fs.readFileSync(mp3);
    const { frames, audio } = readId3(tagged);
    assert.ok(audio.equals(original), 'the audio itself is unchanged');
    assert.equal(id3Text(frames.TIT2), 'Cover Test “Ω”');
    assert.equal(id3Text(frames.TPE1), 'Sarah');
    assert.equal(id3Text(frames.TALB), 'Podcast Studio');
    const apic = frames.APIC;
    assert.ok(apic.includes(Buffer.from('image/png\0', 'latin1')));
    assert.ok(apic.includes(Buffer.from(PNG_1PX, 'base64')), 'PNG bytes embedded');
    ep = (await (await get('/api/episodes')).json()).episodes.find((e) => e.file === a.file);
    assert.equal(ep.needsCover, false);
    // Re-embedding replaces the tag instead of stacking a second one.
    await post('/api/cover', { file: a.file, png: PNG_1PX });
    assert.ok(readId3(fs.readFileSync(mp3)).audio.equals(original));
    // The download carries the cover.
    const dl = Buffer.from(await (await get(`${a.url}?download=1`)).arrayBuffer());
    assert.ok(readId3(dl).frames.APIC);
    // A new illustration means the cover must be embedded again.
    await post('/api/illustrate', { file: a.file });
    ep = (await (await get('/api/episodes')).json()).episodes.find((e) => e.file === a.file);
    assert.equal(ep.needsCover, true);
    // Bad input.
    assert.equal((await post('/api/cover', { file: a.file, png: Buffer.from('not a png').toString('base64') })).status, 400);
    assert.equal((await post('/api/cover', { file: '../x.mp3', png: PNG_1PX })).status, 400);
    assert.equal((await post('/api/cover', { file: 'missing.mp3', png: PNG_1PX })).status, 404);
    await post('/api/delete', { file: a.file });
    assert.ok(!fs.existsSync(mp3.replace(/\.mp3$/, '.png')), 'delete removes the cover PNG');
  });
  await check('the page renders and uploads covers for episodes that need them', async () => {
    const js = await (await get('/app.js')).text();
    assert.match(js, /\/api\/cover/);
    assert.match(js, /needsCover/);
  });
  await check('player shows the episode art, with a default and a create button', async () => {
    const html = await (await get('/')).text();
    assert.match(html, /id="coverImg"[^>]*src="\/default-art\.svg"/);
    assert.match(html, /id="illustrateBtn"/);
    assert.equal((await get('/default-art.svg')).status, 200);
    const js = await (await get('/app.js')).text();
    assert.match(js, /ep\.artUrl/);
    assert.match(js, /\/api\/illustrate/);
  });
  await check('audio: s1 converts to (parentheses) and drops unknown tags', async () => {
    const r = await post('/api/audio', { title: 't', script: '[nervous, hushed] Hello there friend. [long-break] [voice tightening] Again.', engine: 's1' });
    assert.equal(r.status, 200);
    const a = await r.json();
    const t = calls.tts.at(-1);
    const saved = await (await get(a.transcriptUrl)).text();
    assert.equal(saved, t.body.text, 'the saved transcript is exactly the converted text sent to Fish Audio');
    assert.equal(t.model, 's1');
    assert.match(t.body.text, /\(nervous\) Hello there friend\. \(long-break\) Again\./);
    assert.ok(!t.body.text.includes('['));
  });
  await check('audio: upstream 402 explains API credit, names the engine, offers the free tier', async () => {
    const r = await post('/api/audio', { title: 't', script: 'x'.repeat(40), engine: 'drama-3' });
    assert.equal(r.status, 402);
    const { error } = await r.json();
    assert.match(error, /Drama 3/);
    assert.match(error, /API credit/);
    assert.match(error, /https:\/\/fish\.audio\/app\/developers/);
    assert.match(error, /free tier/i);
  });
  await check('audio errors are shown next to the Approve button, not only at the top', async () => {
    const html = await (await get('/')).text();
    assert.match(html, /id="approveBtn"[\s\S]*id="audioError"/);
    assert.match(await (await get('/app.js')).text(), /#audioError/);
  });
  await check('audio serving: full, range, suffix-range, download, traversal blocked', async () => {
    const full = await get(episode.url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    const total = (await full.arrayBuffer()).byteLength;
    const part = await get(episode.url, { Range: 'bytes=0-9' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 0-9/${total}`);
    assert.equal((await get(episode.url, { Range: 'bytes=-5' })).status, 206);
    assert.equal((await get(episode.url, { Range: 'bytes=99999999-' })).status, 416);
    assert.match((await get(`${episode.url}?download=1`)).headers.get('content-disposition'), /attachment/);
    assert.equal((await get('/audio/..%2Fserver.js')).status, 404);
    assert.equal((await get('/audio/..%2F..%2Fetc%2Fpasswd.mp3')).status, 404);
  });
  await check('library lists saved episodes', async () => {
    const { episodes } = await (await get('/api/episodes')).json();
    assert.ok(episodes.length >= 2);
    assert.ok(episodes[0].script);
    assert.ok(episodes.some((e) => e.voiceAuthor === 'fish'), 'voice author kept in the library');
  });
  await check('delete removes an episode (audio + record) and rejects bad names', async () => {
    const r = await post('/api/audio', { title: 'To delete', script: 'x'.repeat(40), engine: 's2.1-pro-free' });
    const a = await r.json();
    const mp3 = path.join(tmp, 'output', a.file);
    assert.ok(fs.existsSync(mp3));
    const d = await post('/api/delete', { file: a.file });
    assert.equal(d.status, 200, await d.clone().text());
    assert.ok(!fs.existsSync(mp3) && !fs.existsSync(mp3.replace(/\.mp3$/, '.json')));
    const { episodes } = await (await get('/api/episodes')).json();
    assert.ok(!episodes.some((e) => e.file === a.file));
    assert.equal((await post('/api/delete', { file: a.file })).status, 404);
    assert.equal((await post('/api/delete', { file: '../server.js' })).status, 400);
    assert.equal((await post('/api/delete', { file: a.file }, { Origin: 'http://evil.example.com' })).status, 403);
  });
  await check('footnotes read "Narrated by …" with the voice details', async () => {
    const js = await (await get('/app.js')).text();
    const src = js.slice(js.indexOf('function narratorCredit'), js.indexOf('\n}\n', js.indexOf('function narratorCredit')) + 2);
    const narratorCredit = new Function(`${src}; return narratorCredit;`)();
    assert.equal(narratorCredit({ voiceId: VOICE_ID, voiceTitle: 'Narrator', voiceAuthor: 'Rogen Darell Aban' }),
      `Narrated by Rogen Darell Aban (“Narrator” voice, ID ${VOICE_ID})`);
    assert.equal(narratorCredit({ voiceId: SARAH_ID, voiceTitle: 'Sarah', voiceAuthor: 'Fish Official' }),
      `Narrated by Sarah (voice by Fish Official, ID ${SARAH_ID})`);
    assert.equal(narratorCredit({ voiceId: SARAH_ID, voiceTitle: 'Sarah', voiceAuthor: null }), `Narrated by Sarah (ID ${SARAH_ID})`);
    assert.equal(narratorCredit({ voiceId: null, voiceTitle: 'Engine voice' }), 'Narrated by the engine’s own voice');
    assert.equal(narratorCredit({ voiceId: null, voiceTitle: 'Default voice' }), 'Narrated by the engine’s own voice');
    assert.ok(!/ by .* by /.test(narratorCredit({ voiceId: VOICE_ID, voiceTitle: 'Narrator', voiceAuthor: 'Rogen Darell Aban' })));
  });
  await check('library and player credit the narrator voice and its author', async () => {
    const js = await (await get('/app.js')).text();
    assert.match(js, /ID \$\{ep\.voiceId\}/, 'voice ID shown in the credit');
    assert.match(js, /\/api\/delete/);
    assert.match(js, /voiceAuthor: state\.voice\.author/);
    assert.match(js, /function narratorCredit/);
    assert.ok((js.match(/narratorCredit\(ep\)/g) || []).length >= 2, 'used in both library and player');
  });
  await check('blocks foreign Host headers and cross-origin POSTs', async () => {
    const rebinding = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/config', headers: { Host: 'evil.example.com' } }, (res) => resolve(res.statusCode));
      req.end();
    });
    assert.equal(rebinding, 403);
    assert.equal((await post('/api/keys', { fish: 'attacker-key-123456' }, { Origin: 'http://evil.example.com' })).status, 403);
    const form = await fetch(base + '/api/narrative', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(form.status, 403);
  });
  await check('no endpoint response ever contains a key', async () => {
    for (const p of ['/api/config', '/api/episodes', '/', '/app.js']) {
      const t = await (await get(p)).text();
      assert.ok(!t.includes(CLAUDE_KEY) && !t.includes(FISH_KEY), p);
    }
  });

  child.kill();
  upstream.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${process.exitCode ? 'FAILED' : 'All'} ${pass} checks passed`);
})();
