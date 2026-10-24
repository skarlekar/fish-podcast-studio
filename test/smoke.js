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
const calls = { claude: [], tts: [] };

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
        calls.claude.push(parsed);
        // First answer is far too short to force the length-correction pass.
        const text = calls.claude.length === 1 ? SCRIPT(3) : SCRIPT(40);
        return json(200, { content: [{ type: 'text', text }] });
      }
      if (req.url === '/v1/tts') {
        if (req.headers.authorization !== `Bearer ${FISH_KEY}`) return json(401, { message: 'unauthorized' });
        const parsed = JSON.parse(body);
        calls.tts.push({ model: req.headers.model, body: parsed });
        if (req.headers.model === 'drama-3') return json(402, { message: 'payment required' });
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(5000, 7)]));
      }
      if (req.url.startsWith('/model')) {
        if (req.headers.authorization !== `Bearer ${FISH_KEY}`) return json(401, {});
        return json(200, { total: 1, items: [{ _id: 'abcdef1234567890', title: 'Doc Narrator', description: 'Warm', tags: ['narration'], samples: [{ audio: 'https://example.com/s.mp3' }], author: { nickname: 'fish' } }] });
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
    episode = n;
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
  });
  await check('audio: default engine s2.1-pro-free, bracket tags kept, file saved', async () => {
    const r = await post('/api/audio', { title: episode.title, script: episode.script, engine: 's2.1-pro-free', voiceId: 'abcdef1234567890', speed: 1 });
    const a = await r.json();
    assert.equal(r.status, 200, JSON.stringify(a));
    const t = calls.tts.at(-1);
    assert.equal(t.model, 's2.1-pro-free');
    assert.equal(t.body.reference_id, 'abcdef1234567890');
    assert.equal(t.body.format, 'mp3');
    assert.match(t.body.text, /\[nervous\]/);
    assert.ok(fs.existsSync(path.join(tmp, 'output', a.file)));
    episode.url = a.url;
  });
  await check('audio: s1 converts to (parentheses) and drops unknown tags', async () => {
    const r = await post('/api/audio', { title: 't', script: '[nervous, hushed] Hello there friend. [long-break] [voice tightening] Again.', engine: 's1' });
    assert.equal(r.status, 200);
    const t = calls.tts.at(-1);
    assert.equal(t.model, 's1');
    assert.match(t.body.text, /\(nervous\) Hello there friend\. \(long-break\) Again\./);
    assert.ok(!t.body.text.includes('['));
  });
  await check('audio: upstream 402 becomes a friendly error', async () => {
    const r = await post('/api/audio', { title: 't', script: 'x'.repeat(40), engine: 'drama-3' });
    assert.equal(r.status, 402);
    assert.match((await r.json()).error, /free tier/i);
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
