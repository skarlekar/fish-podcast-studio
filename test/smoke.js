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
const AUTHOR_ID = '9672b25f05dd4f7fa38257dea00ad01d';

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

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      PATH: process.env.PATH, PORT: String(port), OUTPUT_DIR: path.join(tmp, 'output'), ENV_FILE: envFile,
      ANTHROPIC_BASE_URL: up, FISH_BASE_URL: up, ANTHROPIC_API_KEY: '', FISH_AUDIO_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => { child.stdout.on('data', (d) => /running at/.test(String(d)) && resolve()); child.on('exit', reject); });

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
  await check('voices list proxied', async () => {
    const v = await (await get('/api/voices?q=narrator')).json();
    assert.equal(v.items[0].title, 'Doc Narrator');
    assert.equal(v.items[0].sample, 'https://example.com/s.mp3');
    assert.equal(v.items[0].authorId, AUTHOR_ID);
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
  await check('library shows a Transcript button only when a transcript was saved', async () => {
    const html = await (await get('/')).text();
    assert.match(html, /id="transcriptDialog"/);
    const js = await (await get('/app.js')).text();
    assert.match(js, /if \(ep\.transcriptUrl\)/);
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
