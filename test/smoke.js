'use strict';
// End-to-end smoke test: runs the real server against mock Claude + Fish Audio upstreams.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const CLAUDE_KEY = 'sk-ant-test-0123456789';
const FISH_KEY = 'fish-test-0123456789';
const calls = { claude: [], tts: [], model: [], art: [], artFailNext: false };
const VOICE_ID = '785ee4188c594830bc2ec7065817c1e1';
const SARAH_ID = '933563129e564b19a115bedd57b7406a';
const MASON_ID = '02e950ce577d4f008a2dfb4782789a3a'; // default male podcast host
const HARPER_ID = 'c250136a9ec74cc0b799be54664a83f2'; // default female podcast host
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
        // Podcast scripts: valid dialogue for the host names in the rules; BADFORMAT / ALWAYSBAD briefs slip.
        const hostsIn = parsed.system.match(/labelled exactly (.+?) and (.+?)\. Every turn/);
        if (hostsIn) {
          const [m, f] = [hostsIn[1], hostsIn[2]];
          const dialogue = (n, words, extra = '') => Array.from({ length: n }, (_, i) => `${i % 2 ? f : m}: ${i === 1 ? extra : ''}${'word '.repeat(words).trim()} number ${i}.`).join('\n\n');
          const brief = parsed.messages[0].content;
          const last = parsed.messages.at(-1).content;
          const bad = `${m}: Welcome (laughs) to the show.\n\nNarrator: Meanwhile.\n\n${f}: Hi.`;
          let text;
          if (/ALWAYSBAD/.test(brief)) text = bad;
          else if (/breaks the format/.test(last)) text = dialogue(8, 10, 'CORRECTED ');
          else if (parsed.messages.length === 1 && /BADFORMAT/.test(brief)) text = bad;
          else if (parsed.messages.length === 1) text = `Sure! Here is your episode.\n\n${dialogue(8, 10)}`;
          else text = dialogue(50, 14);
          return json(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: `TITLE: The Orange Cord, Discussed\n\n${text}` }] });
        }
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
        if (Array.isArray(parsed.reference_id)) {
          if (/RETRY429/.test(parsed.text) && !calls.retried) { calls.retried = true; return json(429, { message: 'slow down' }); }
          if (/FAILHERE/.test(parsed.text)) return json(500, { message: 'boom' });
          res.writeHead(200, { 'content-type': 'audio/mpeg' });
          return res.end(Buffer.concat([Buffer.from(`WIN[${parsed.text.slice(0, 24)}]`), Buffer.alloc(1200, 5)]));
        }
        if (req.headers.model === 'drama-3' && /^x+$/.test(parsed.text)) return json(402, { status: 402, message: 'Insufficient API credit. API credit is managed independently from platform credit. Please visit https://fish.audio/app/developers to view your API credit balance or add funds.' });
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
  const envFile = path.join(tmp, '.env');
  // A tiny sample library, standing in for samples/ (checked separately below).
  const samplesDir = path.join(tmp, 'samples');
  fs.mkdirSync(samplesDir);
  fs.writeFileSync(path.join(samplesDir, 'sample-one.mp3'), Buffer.alloc(2000, 1));
  fs.writeFileSync(path.join(samplesDir, 'sample-one.txt'), '[calm] A sample.');
  fs.writeFileSync(path.join(samplesDir, 'sample-one.json'), JSON.stringify({ file: 'sample-one.mp3', title: 'Sample One', createdAt: '2026-01-01T00:00:00.000Z', engine: 's2.1-pro-free', transcript: 'sample-one.txt', script: '[calm] A sample.', coverOf: 'default', lyricsIn: true, bytes: 2000 }));

  // Every server gets a port the OS picks (PORT=0); its real port is read from the "running at" line,
  // so test servers can never collide with each other or with anything else on the machine.
  const servers = [];
  const startServer = (extraEnv = {}) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        PATH: process.env.PATH, PORT: '0', OUTPUT_DIR: path.join(tmp, 'output'), ENV_FILE: envFile, SAMPLES_DIR: samplesDir,
        ANTHROPIC_BASE_URL: up, FISH_BASE_URL: up, ANTHROPIC_API_KEY: '', FISH_AUDIO_API_KEY: '', FISH_RETRY_MS: '20', ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    servers.push(proc);
    return new Promise((resolve, reject) => {
      proc.stdout.on('data', (d) => {
        const m = String(d).match(/running at http:\/\/[^:]+:(\d+)/);
        if (m) resolve({ proc, port: Number(m[1]) });
      });
      proc.on('exit', (code) => reject(new Error(`server exited (${code}) before it was ready`)));
    });
  };
  const { proc: child, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;

  const get = (p, h) => fetch(base + p, { headers: h });
  const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
  let episode;

  console.log('Podcast Studio smoke test');

  // ---- podcast.js: pure helpers (no server needed)
  const pod = () => require('../podcast.js');
  const HOSTS = { male: 'Adrian', female: 'Sarah' };
  const MALE_ID = 'bf322df2096a46f18c579d0baa36f41d';
  const SPEAKERS = [
    { name: 'Adrian', voiceId: MALE_ID, voiceTitle: 'Adrian', voiceAuthor: 'Fish Official' },
    { name: 'Sarah', voiceId: SARAH_ID, voiceTitle: 'Sarah', voiceAuthor: 'Fish Official' },
  ];
  const podcastScript = (n, words = 6) => Array.from({ length: n }, (_, i) => `${i % 2 ? 'Sarah' : 'Adrian'}: [amused]   Turn ${i} ${'word '.repeat(words).trim()}.`).join('\n\n');
  const VALID6 = 'Adrian: [amused] Welcome back!\n\nSarah: Hi, everyone.\n\nAdrian: Today, a skydive.\n\nSarah: [teasing] You hate heights.\n\nAdrian: Which is why it is fun.\n\nSarah: Goodbye, everyone!';
  await check('podcast: system prompt names both hosts, structure, storyteller and rules', async () => {
    const sys = pod().buildPodcastSystemPrompt(5, '', HOSTS);
    for (const want of ['Adrian (male)', 'Sarah (female)', 'our storyteller', 'two or three concrete takeaways', 'open-ended question', '750 spoken words', 'labelled exactly Adrian and Sarah', 'parentheses or asterisks']) assert.ok(sys.includes(want), want);
    assert.ok(!sys.includes('{{'), 'all placeholders filled');
    assert.ok(pod().buildPodcastSystemPrompt(5, 'Custom for {{male}} and {{female}}.', HOSTS).startsWith('Custom for Adrian and Sarah.'));
  });
  await check('podcast: the prompt asks for an energetic, expressive performance', async () => {
    const sys = pod().buildPodcastSystemPrompt(5, '', HOSTS);
    assert.match(sys, /high-energy and genuinely engaging/i);
    for (const want of ['[very excited]', '[laughing] Ha!', 'Give most turns a delivery tag']) assert.ok(sys.includes(want), want);
    assert.ok(!/leave many turns untagged/i.test(sys), 'no longer asks for untagged turns');
  });
  await check('podcast: only host names (and known labels) start turns', async () => {
    const { turns, unknown, preamble } = pod().parseTurns("Sure! Here's your script.\n\nAdrian: Hi.\n\n**sarah:** Hello!\n\nSo here's the thing: more of Sarah's turn\n\nAdrian: Bye.\n\nADRIAN: And again.", HOSTS);
    assert.deepEqual(turns.map((t) => t.speaker), [0, 1, 0]);
    assert.ok(turns[1].text.includes("here's the thing"), 'colon inside a sentence is not a label');
    assert.ok(turns[2].text.includes('And again'), 'back-to-back turns by one host merge');
    assert.deepEqual(unknown, []);
    assert.match(preamble, /Here's your script/);
  });
  await check('podcast: format problems are explained', async () => {
    const c = (t) => pod().checkDialogue(t, HOSTS);
    assert.equal(c(VALID6), null);
    assert.match(c(VALID6 + '\n\nNarrator: The end.'), /Narrator/);
    assert.match(c(VALID6.replace('Sarah: Goodbye', 'Both: Goodbye')), /Both/);
    assert.match(c(VALID6.replace('You hate heights.', 'You hate heights. (laughs)')), /parenthes/i);
    assert.match(c(VALID6.replace('You hate heights.', 'You hate heights. *chuckles*')), /asterisk/i);
    assert.match(c('Adrian: One.\n\nAdrian: Two.\n\nAdrian: Three.'), /Sarah/);
    assert.match(c('Adrian: Hi.\n\nSarah: Hi.'), /turns/i);
  });
  await check('podcast: Fish text and windows keep speaker markers', async () => {
    const { turns } = pod().parseTurns(VALID6, HOSTS);
    assert.equal(pod().fishDialogueText(turns.slice(0, 2)), '<|speaker:0|>[amused] Welcome back!\n\n<|speaker:1|>Hi, everyone.');
    const chunks = pod().chunkDialogue(turns, 60);
    assert.ok(chunks.length > 1);
    for (const ch of chunks) assert.ok(ch.startsWith('<|speaker:'), ch);
    assert.equal(chunks.join('\n\n'), pod().fishDialogueText(turns), 'all turns, in order');
    const long = [{ speaker: 1, name: 'Sarah', text: 'One sentence here. '.repeat(10).trim() }];
    for (const ch of pod().chunkDialogue(long, 60)) { assert.ok(ch.startsWith('<|speaker:1|>')); assert.ok(ch.length <= 60 + 15); }
    assert.equal(pod().chunkDialogue(turns).length, 1, 'default window holds a short dialogue');
  });
  await check('podcast: a host label on the next line starts a new turn (single line break)', async () => {
    const { turns } = pod().parseTurns('Adrian: Three.\nSarah: Wait, really?\nAdrian: Really.', HOSTS);
    assert.deepEqual(turns.map((t) => [t.speaker, t.text]), [[0, 'Three.'], [1, 'Wait, really?'], [0, 'Really.']]);
  });
  await check('podcast: other name-like labels are refused, ordinary colons are not', async () => {
    const c = (t) => pod().checkDialogue(t, HOSTS);
    assert.match(c(VALID6 + '\n\nProducer: Great take, everyone.'), /Producer/);
    assert.match(c(VALID6.replace('Adrian: Today, a skydive.', 'Mary Jane: I jumped first.')), /Mary Jane/);
    assert.equal(c(VALID6.replace('Adrian: Today, a skydive.', 'Adrian: Today, a skydive.\n\nSo here is the thing: it was windy.')), null);
    assert.equal(c(VALID6.replace('Adrian: Today, a skydive.', 'Adrian: Today, a skydive.\n\nLook at this one: wow.')), null);
  });
  await check('podcast: only real stage directions in parentheses are refused', async () => {
    const c = (t) => pod().checkDialogue(VALID6.replace('You hate heights.', t), HOSTS);
    assert.equal(c('You hate heights (clearly a mistake on my part).'), null);
    assert.equal(c('You hate heights (smiling aside, I mean it).'), null);
    for (const bad of ['(laughs)', '(laughing)', '(chuckles softly)', '(sighs)', '(clears throat)', '(pause)', '(whispers)']) assert.match(c(`You hate heights. ${bad}`), /parenthes/i, bad);
  });
  await check('podcast: host names validated', async () => {
    assert.deepEqual(pod().validHosts({ male: ' Adrian ', female: 'Sarah' }), HOSTS);
    assert.throws(() => pod().validHosts({ male: 'Adrian', female: 'adrian' }), /different/);
    assert.throws(() => pod().validHosts({ male: '', female: 'Sarah' }));
    assert.throws(() => pod().validHosts({ male: 'Al<script>', female: 'Sarah' }));
    assert.throws(() => pod().validHosts({ male: 'A'.repeat(25), female: 'Sarah' }));
  });
  await check('podcast: rename, words, lyrics and artist', async () => {
    assert.equal(pod().renameLabels('Sarah: Hi.\n\nAdrian: Sarah: is me', 'Sarah', 'Maya'), 'Maya: Hi.\n\nAdrian: Sarah: is me');
    assert.equal(pod().dialogueWords('Adrian: [amused] Hi there.\n\nSarah: Hello!', HOSTS), 3);
    assert.equal(pod().dialogueLyrics('<|speaker:0|>Hi.\n\n<|speaker:1|>Yo.', ['Adrian', 'Sarah']), 'Adrian: Hi.\n\nSarah: Yo.');
    assert.equal(pod().hostedBy([{ name: 'Adrian' }, { name: 'Sarah' }]), 'Adrian & Sarah');
    assert.equal(pod().PODCAST_WPM, 150);
    assert.deepEqual(pod().PODCAST_DEFAULTS, { male: { name: 'Mason', voiceId: MASON_ID }, female: { name: 'Harper', voiceId: HARPER_ID } }, 'energetic conversational hosts');
  });
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
    const again = await startServer();
    let eps;
    try {
      eps = (await (await fetch(`http://127.0.0.1:${again.port}/api/episodes`)).json()).episodes;
    } finally {
      again.proc.kill();
    }
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
      assert.equal(m.lyricsIn, true, `${n}: lyrics flagged as embedded`);
      const lyrics = readId3(mp3).frames.USLT;
      assert.ok(lyrics && !/\[[^\]]*\]/.test(lyrics.subarray(10).toString('utf16le')), `${m.file}: lyrics embedded and free of audio tags`);
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
    assert.match(await (await get('/app.js')).text(), /system: \(mode === 'podcast' \? \$\('#podcastPrompt'\) : \$\('#systemPrompt'\)\)\.value/);
  });
  await check('podcast script: podcast prompt, hosts, storyteller, length', async () => {
    calls.claude.length = 0;
    const r = await post('/api/narrative', { mode: 'podcast', instructions: 'The ledge is cold beneath my knees.', minutes: 5, hosts: HOSTS });
    const n = await r.json();
    assert.equal(r.status, 200, JSON.stringify(n));
    assert.equal(n.mode, 'podcast');
    assert.match(calls.claude[0].system, /Adrian \(male\)/);
    assert.match(calls.claude[0].system, /750 spoken words/);
    assert.match(calls.claude[0].messages[0].content, /The ledge is cold/);
    assert.match(calls.claude[0].messages[0].content, /hosted by Adrian and Sarah/);
    assert.equal(calls.claude.length, 2, 'short first draft gets a length pass');
    assert.match(calls.claude[1].messages.at(-1).content, /add exchanges/);
    assert.equal(pod().checkDialogue(n.script, HOSTS), null);
    assert.ok(!/Here is your episode/.test(n.script), 'preamble stripped');
    assert.equal(n.targetWords, 750);
  });
  await check('podcast script: one format correction, built on; a persistent slip is an error', async () => {
    calls.claude.length = 0;
    const r = await post('/api/narrative', { mode: 'podcast', instructions: 'BADFORMAT story', minutes: 5, hosts: HOSTS });
    const n = await r.json();
    assert.equal(r.status, 200, JSON.stringify(n));
    assert.match(calls.claude[1].messages.at(-1).content, /breaks the format: .*Narrator/);
    assert.match(calls.claude[2].messages.at(-2).content, /CORRECTED/, 'length pass builds on the corrected script');
    assert.equal(pod().checkDialogue(n.script, HOSTS), null);
    const r2 = await post('/api/narrative', { mode: 'podcast', instructions: 'ALWAYSBAD story', minutes: 5, hosts: HOSTS });
    assert.equal(r2.status, 502);
    assert.match((await r2.json()).error, /podcast format/i);
  });
  await check('podcast script: bad host names are refused', async () => {
    const r = await post('/api/narrative', { mode: 'podcast', instructions: 'x', minutes: 5, hosts: { male: 'Sam', female: 'sam' } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /different/);
  });
  await check('config offers the podcast defaults, without s1', async () => {
    const c = await (await get('/api/config')).json();
    assert.equal(c.podcast.hosts.male.name, 'Mason');
    assert.equal(c.podcast.wpm, 150);
    assert.deepEqual(c.podcast.engines, ['s2.1-pro-free', 's2.1-pro', 's2-pro', 'drama-3', 's1'], 'every engine is offered for podcasts');
    assert.match(c.podcast.defaultPrompt, /\{\{male\}\}/);
    assert.match(c.podcast.rules, /SPEAKERS \(strict\)/);
    assert.ok(c.podcast.defaultBrief);
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
    assert.equal(typeof t.body.reference_id, 'string', 'summaries still send one voice');
    assert.deepEqual([t.body.temperature, t.body.top_p], [0.7, 0.7], 'summaries keep their calmer settings');
    assert.deepEqual(a.settings, { temperature: 0.7, topP: 0.7, speed: 1, latency: 'normal', mp3Bitrate: 128, normalize: true, requests: 1, voicing: 'one voice' }, 'the record says exactly what was sent');
    assert.deepEqual([t.body.latency, t.body.mp3_bitrate, t.body.normalize, t.body.prosody.speed], ['normal', 128, true, 1]);
    assert.equal(a.mode, undefined, 'summaries carry no mode');
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
  // Pull one top-level function out of app.js (browser code) to test it directly, like narratorCredit below.
  const appFn = (js, name) => {
    const at = js.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `app.js defines ${name}`);
    return new Function(`${js.slice(at, js.indexOf('\n}\n', at) + 2)}; return ${name};`)();
  };
  await check('tabs: Audio Summary and Podcast, each with its own system prompt', async () => {
    const html = await (await get('/')).text();
    assert.match(html, /id="tabSummary"[^>]*>Audio Summary/);
    assert.match(html, /id="tabPodcast"[^>]*>Podcast/);
    assert.match(html, /id="systemPrompt"[^>]*data-mode-only="summary"|data-mode-only="summary"[^>]*id="systemPrompt"/);
    assert.match(html, /id="podcastPrompt"/);
  });
  await check('tabs: switching keeps each tab its own draft', async () => {
    const swapDraft = appFn(await (await get('/app.js')).text(), 'swapDraft');
    const drafts = { summary: { brief: 'S', script: 's1', engine: 's1' }, podcast: { brief: 'P', script: '', engine: 's2.1-pro-free' } };
    const out = swapDraft(drafts, 'summary', 'podcast', { brief: 'S edited', script: 's2', engine: 's1' });
    assert.equal(out.load.brief, 'P');
    assert.equal(out.drafts.summary.brief, 'S edited');
    assert.equal(out.drafts.summary.engine, 's1', 'engine choice kept per tab');
    assert.equal(drafts.summary.brief, 'S', 'input not mutated');
    const back = swapDraft(out.drafts, 'podcast', 'summary', { brief: 'P2', script: 'p', engine: 'drama-3' });
    assert.equal(back.load.script, 's2');
    assert.equal(back.drafts.podcast.engine, 'drama-3');
  });
  await check('tabs: Audio Summary requests carry no podcast fields', async () => {
    const js = await (await get('/app.js')).text();
    const narrative = appFn(js, 'buildNarrativeBody')('summary', { system: 'S', instructions: 'I', minutes: 5, hosts: HOSTS });
    assert.deepEqual(narrative, { system: 'S', instructions: 'I', minutes: 5 });
    const revise = appFn(js, 'buildNarrativeBody')('summary', { system: 'S', instructions: 'I', minutes: 5, feedback: 'more', title: 'T', script: 'X' });
    assert.deepEqual(revise, { system: 'S', instructions: 'I', minutes: 5, feedback: 'more', previous: { title: 'T', script: 'X' } });
    const audio = appFn(js, 'buildAudioBody')('summary', { title: 'T', script: 'X', engine: 's1', speed: 1, voice: { id: 'v', title: 'V', author: 'A' }, hosts: {}, source: 'x' });
    assert.deepEqual(audio, { title: 'T', script: 'X', engine: 's1', voiceId: 'v', voiceTitle: 'V', voiceAuthor: 'A', speed: 1 });
  });
  await check('tabs: overlapping requests keep everything locked; a late script goes to its own tab', async () => {
    const js = await (await get('/app.js')).text();
    const lock = js.slice(js.indexOf('function setBusyState'), js.indexOf('\n}\n', js.indexOf('function setBusyState')));
    for (const id of ['#approveBtn', '#writeBtn', '#reviseBtn', '#redoBtn', '#tabSummary', '#tabPodcast']) assert.ok(lock.includes(id), `locks ${id}`);
    assert.match(lock, /state\.busy \+= busy \? 1 : -1/, 'a counter, not a flag');
    const write = js.slice(js.indexOf('async function writeNarrative'));
    assert.match(write, /if \(state\.mode !== mode\)/, 'result stored in the starting tab\'s draft');
    assert.ok(!/\.forEach\(\(b\) => \(b\.disabled = false\)\)/.test(write.slice(0, write.indexOf('\n}\n'))), 'no unconditional re-enable');
  });
  await check('tabs: the library lists the active tab, but covers are embedded for every episode', async () => {
    const js = await (await get('/app.js')).text();
    const lib = js.slice(js.indexOf('async function refreshLibrary'));
    assert.match(lib, /embedMissingCovers\(eps\)/);
    assert.match(lib, /\(ep\.mode \|\| 'summary'\) === state\.mode/);
    assert.match(js, /function switchMode/);
  });
  await check('podcast tab: host names, story picker and host voices', async () => {
    const html = await (await get('/')).text();
    for (const id of ['hostMaleName', 'hostFemaleName', 'startFromEpisode', 'hostCards']) assert.match(html, new RegExp(`id="${id}"`), id);
    const js = await (await get('/app.js')).text();
    const h = { male: { name: 'Adrian', voice: { id: MALE_ID, title: 'Adrian', author: 'Fish Official' } }, female: { name: 'Maya', voice: { id: SARAH_ID, title: 'Sarah', author: 'Fish Official' } } };
    const audio = appFn(js, 'buildAudioBody')('podcast', { title: 'T', script: 'X', engine: 's2.1-pro-free', speed: 1, voice: { id: 'v' }, hosts: h, source: 'The story.' });
    assert.deepEqual(audio, { mode: 'podcast', title: 'T', script: 'X', engine: 's2.1-pro-free', speed: 1, source: 'The story.', speakers: [
      { name: 'Adrian', voiceId: MALE_ID, voiceTitle: 'Adrian', voiceAuthor: 'Fish Official' },
      { name: 'Maya', voiceId: SARAH_ID, voiceTitle: 'Sarah', voiceAuthor: 'Fish Official' },
    ] });
    const narrative = appFn(js, 'buildNarrativeBody')('podcast', { system: 'S', instructions: 'I', minutes: 3, hosts: { male: 'Adrian', female: 'Maya' } });
    assert.deepEqual(narrative, { system: 'S', instructions: 'I', minutes: 3, mode: 'podcast', hosts: { male: 'Adrian', female: 'Maya' } });
  });
  await check('podcast tab: renaming a host rewrites the script labels, nothing else', async () => {
    const renameLabels = appFn(await (await get('/app.js')).text(), 'renameLabels');
    assert.equal(renameLabels('Sarah: Hi.\n\nAdrian: Sarah: is me.\n\n**sarah:** Bye.', 'Sarah', 'Maya'), 'Maya: Hi.\n\nAdrian: Sarah: is me.\n\n**Maya:** Bye.');
    assert.equal(renameLabels('Al.ex: Hi.', 'Al.ex', 'Bo'), 'Bo: Hi.', 'dots in a name are literal');
  });
  await check('footnote: the engine and the settings it was voiced with', async () => {
    const settingsLine = appFn(await (await get('/app.js')).text(), 'settingsLine');
    const labels = { 's2.1-pro-free': 'S2.1 Pro · free tier', 'drama-3': 'Drama 3' };
    assert.equal(settingsLine({ engine: 's2.1-pro-free', settings: { temperature: 0.9, topP: 0.9, speed: 1, latency: 'normal', mp3Bitrate: 128, normalize: true, requests: 5, voicing: 'both voices per request' } }, labels),
      'Engine S2.1 Pro · free tier (s2.1-pro-free) · temperature 0.9 · top-p 0.9 · speed 1.00× · latency normal · MP3 128 kbps · 5 requests, both voices per request');
    assert.equal(settingsLine({ engine: 'drama-3', settings: { temperature: 1, topP: 0.9, speed: 1.1, latency: 'normal', mp3Bitrate: 128, normalize: true, requests: 1, voicing: 'one voice' } }, labels),
      'Engine Drama 3 (drama-3) · temperature 1.0 · top-p 0.9 · speed 1.10× · latency normal · MP3 128 kbps · 1 request');
    assert.equal(settingsLine({ engine: 'mystery' }, labels), 'Engine mystery');
  });
  await check('podcast transcript says which speaker marker is which host', async () => {
    assert.match(await (await get('/app.js')).text(), /Speaker \$\{i\} is \$\{s\.name\}/);
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
  await check('lyrics: the narration, without audio tags, is embedded for Apple Music in the MP3 and the .m4a', async () => {
    const script = '[calm] First line of the story. [long-break]\n\n[whispering] Second paragraph, “quoted”. (sighing) The end.';
    const expected = 'First line of the story.\n\nSecond paragraph, “quoted”. The end.';
    const a = await (await post('/api/audio', { title: 'Lyrics Test', script, engine: 's2.1-pro-free' })).json();
    const mp3 = path.join(tmp, 'output', a.file);
    // An episode made before lyrics existed must ask the browser to tag it again.
    let ep = (await (await get('/api/episodes')).json()).episodes.find((e) => e.file === a.file);
    assert.equal(ep.needsCover, true);
    assert.equal((await post('/api/cover', { file: a.file, png: PNG_1PX })).status, 200);
    const uslt = readId3(fs.readFileSync(mp3)).frames.USLT;
    assert.ok(uslt, 'USLT (lyrics) frame present');
    assert.equal(uslt[0], 1, 'UTF-16 with BOM');
    assert.equal(uslt.subarray(1, 4).toString('latin1'), 'eng');
    assert.equal(uslt.subarray(10).toString('utf16le'), expected, 'plain narration, no [tags], paragraphs kept'); // 1 + 3 + (BOM + 00 00) + BOM
    ep = (await (await get('/api/episodes')).json()).episodes.find((e) => e.file === a.file);
    assert.equal(ep.needsCover, false, 'tagged once, not asked again');
    // An episode whose cover is current but that was tagged before lyrics existed is tagged again.
    const metaPath = mp3.replace(/\.mp3$/, '.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    delete meta.lyricsIn;
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    ep = (await (await get('/api/episodes')).json()).episodes.find((e) => e.file === a.file);
    assert.equal(ep.needsCover, true, 'older tagged episode asks for a re-tag');
    assert.equal((await post('/api/cover', { file: a.file, png: PNG_1PX })).status, 200);
    if (spawnSync('ffmpeg', ['-version']).status !== 0) return console.log('    (.m4a part skipped: ffmpeg not installed)');
    // The .m4a is converted from the MP3, so the lyrics must survive the conversion.
    const real = path.join(tmp, 'lyrics-fixture.mp3');
    assert.equal(spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', '-b:a', '64k', real]).status, 0);
    fs.copyFileSync(real, mp3);
    assert.equal((await post('/api/cover', { file: a.file, png: PNG_1PX })).status, 200);
    const m4a = path.join(tmp, 'output', a.file.replace(/\.mp3$/, '.m4a'));
    const r = await get(`/audio/${a.file.replace(/\.mp3$/, '.m4a')}?download=1`);
    assert.equal(r.status, 200, await r.clone().text());
    await r.arrayBuffer();
    const probe = JSON.parse(String(spawnSync('ffprobe', ['-v', 'error', '-of', 'json', '-show_format', m4a]).stdout));
    assert.equal(probe.format.tags.lyrics, expected, 'm4a carries the lyrics (©lyr)');
    await post('/api/delete', { file: a.file });
  });
  await check('podcast files: the tag credits both hosts and the lyrics name the speakers', async () => {
    const script = 'Adrian: [amused] Welcome back, everyone!\n\nSarah: Hi! Today, a skydive.\n\nAdrian: You hate heights.\n\nSarah: [teasing] I do not.\n\nAdrian: Okay. Let us begin.\n\nSarah: Goodbye for now!';
    const a = await (await post('/api/audio', { mode: 'podcast', title: 'Pod Credits', script, engine: 's2.1-pro-free', speakers: SPEAKERS })).json();
    const mp3 = path.join(tmp, 'output', a.file);
    assert.equal((await post('/api/cover', { file: a.file, png: PNG_1PX })).status, 200);
    const { frames } = readId3(fs.readFileSync(mp3));
    assert.equal(id3Text(frames.TPE1), 'Adrian & Sarah');
    const lyrics = frames.USLT.subarray(10).toString('utf16le');
    assert.ok(lyrics.startsWith('Adrian: Welcome back, everyone!\n\nSarah: Hi! Today, a skydive.'), lyrics.slice(0, 80));
    assert.ok(!lyrics.includes('<|speaker') && !lyrics.includes('[amused]'));
    const eps = (await (await get('/api/episodes')).json()).episodes;
    assert.equal(eps.find((e) => e.file === a.file).mode, 'podcast');
    assert.ok(eps.filter((e) => !e.speakers).every((e) => e.mode === 'summary'), 'summaries listed as summary');
    if (spawnSync('ffmpeg', ['-version']).status !== 0) return console.log('    (.m4a part skipped: ffmpeg not installed)');
    const real = path.join(tmp, 'pod-fixture.mp3');
    assert.equal(spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'libmp3lame', '-b:a', '64k', real]).status, 0);
    fs.copyFileSync(real, mp3);
    assert.equal((await post('/api/cover', { file: a.file, png: PNG_1PX })).status, 200);
    const r = await get(`/audio/${a.file.replace(/\.mp3$/, '.m4a')}?download=1`);
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    const probe = JSON.parse(String(spawnSync('ffprobe', ['-v', 'error', '-of', 'json', '-show_format', mp3.replace(/\.mp3$/, '.m4a')]).stdout));
    assert.match(probe.format.tags.lyrics, /^Adrian: Welcome back/);
    assert.equal(probe.format.tags.artist, 'Adrian & Sarah');
    await post('/api/delete', { file: a.file });
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
  await check('podcast audio: both voices per request, markers in order, transcript exact', async () => {
    calls.tts.length = 0;
    const script = podcastScript(6);
    const r = await post('/api/audio', { mode: 'podcast', title: 'Pod One', script, engine: 's2.1-pro-free', speakers: SPEAKERS, source: 'The ledge is cold.' });
    const a = await r.json();
    assert.equal(r.status, 200, JSON.stringify(a));
    assert.equal(calls.tts.length, 1, 'a short episode fits one window');
    const t = calls.tts[0].body;
    assert.deepEqual(t.reference_id, [MALE_ID, SARAH_ID]);
    const { turns } = pod().parseTurns(script, HOSTS);
    assert.equal(t.text, pod().fishDialogueText(turns).replace(/[ \t]{2,}/g, (m) => m), 'dialogue text');
    assert.ok(t.text.startsWith('<|speaker:0|>[amused]') && t.text.includes('<|speaker:1|>'));
    assert.equal(fs.readFileSync(path.join(tmp, 'output', a.transcript), 'utf8'), t.text, 'saved transcript is what Fish got');
    assert.equal(a.mode, 'podcast');
    assert.equal(a.speakers[1].name, 'Sarah');
    assert.equal(a.voiceId, null);
    assert.equal(a.source, 'The ledge is cold.');
  });
  await check('podcast audio: a long episode is voiced in windows of whole turns, in order', async () => {
    calls.tts.length = 0;
    calls.retried = false;
    const script = podcastScript(40, 12).replace('Turn 7', 'Turn 7 RETRY429');
    const r = await post('/api/audio', { mode: 'podcast', title: 'Pod Long', script, engine: 's2.1-pro-free', speakers: SPEAKERS });
    const a = await r.json();
    assert.equal(r.status, 200, JSON.stringify(a));
    const windows = calls.tts.filter((c) => Array.isArray(c.body.reference_id));
    assert.ok(windows.length > 3, `several windows (${windows.length})`);
    assert.ok(calls.retried, 'a 429 was retried');
    const sent = [...new Set(windows.map((w) => w.body.text))];
    for (const w of sent) {
      assert.ok(w.startsWith('<|speaker:') && w.length <= 700, 'whole turns, at most 700 chars');
    }
    assert.equal(a.chunks, sent.length);
    const saved = fs.readFileSync(path.join(tmp, 'output', a.transcript), 'utf8');
    assert.equal(saved, sent.sort((x, y) => saved.indexOf(x) - saved.indexOf(y)).join('\n\n'), 'transcript = windows joined');
    const audio = fs.readFileSync(path.join(tmp, 'output', a.file)).toString('latin1');
    const order = [...audio.matchAll(/WIN\[(.{24})\]/g)].map((m) => m[1]);
    assert.deepEqual(order, sent.map((w) => w.slice(0, 24)), 'audio joined in script order');
  });
  await check('podcast audio: refused when it cannot be voiced right', async () => {
    calls.tts.length = 0;
    const body = { mode: 'podcast', title: 'Bad', script: podcastScript(6), engine: 's2.1-pro-free', speakers: SPEAKERS };
    let r = await post('/api/audio', { ...body, speakers: [SPEAKERS[0], { ...SPEAKERS[1], voiceId: '' }] });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /voice/i);
    r = await post('/api/audio', { ...body, script: podcastScript(6) + '\n\nNarrator: The end.' });
    assert.equal(r.status, 400);
    const msg = (await r.json()).error;
    assert.match(msg, /Narrator/);
    assert.match(msg, /Adrian/);
    assert.equal(calls.tts.length, 0, 'nothing sent to Fish');
  });
  await check('podcast audio: S2 engines voice both hosts per request with expressive settings', async () => {
    calls.tts.length = 0;
    await post('/api/audio', { mode: 'podcast', title: 'Pod Settings', script: podcastScript(6), engine: 's2.1-pro', speakers: SPEAKERS });
    const t = calls.tts.at(-1).body;
    assert.ok(Array.isArray(t.reference_id));
    assert.equal(t.temperature, 0.9);
    assert.equal(t.top_p, 0.9);
    const ep = (await (await get('/api/episodes')).json()).episodes.find((e) => e.title === 'Pod Settings');
    assert.deepEqual(ep.settings, { temperature: 0.9, topP: 0.9, speed: 1, latency: 'normal', mp3Bitrate: 128, normalize: true, requests: 1, voicing: 'both voices per request' });
  });
  await check('podcast audio: Drama 3 and S1 voice one turn per request, each with its host\'s voice', async () => {
    for (const engine of ['drama-3', 's1']) {
      calls.tts.length = 0;
      const script = podcastScript(6);
      const r = await post('/api/audio', { mode: 'podcast', title: `Pod ${engine}`, script, engine, speakers: SPEAKERS });
      const a = await r.json();
      assert.equal(r.status, 200, JSON.stringify(a));
      assert.equal(calls.tts.length, 6, `${engine}: one request per turn`);
      // Requests run three at a time, so they may arrive out of order: identify each one's turn by its text.
      const seen = calls.tts.map((c) => {
        assert.equal(c.model, engine);
        assert.ok(!c.body.text.includes('<|speaker'), 'no speaker markers in a single-voice request');
        const i = Number(c.body.text.match(/Turn (\d+) /)[1]);
        assert.equal(c.body.reference_id, i % 2 ? SARAH_ID : MALE_ID, `${engine}: turn ${i} uses its host's voice`);
        return i;
      });
      assert.deepEqual(seen.sort((x, y) => x - y), [0, 1, 2, 3, 4, 5], 'every turn voiced once');
      if (engine === 'drama-3') assert.deepEqual([calls.tts[0].body.temperature, calls.tts[0].body.top_p], [1, 0.9]);
      assert.equal(a.settings.voicing, 'one line per request');
      assert.equal(a.settings.requests, 6);
      assert.equal(a.settings.temperature, calls.tts[0].body.temperature);
      if (engine === 's1') assert.ok(calls.tts.every((c) => !c.body.text.includes('[')), 'S1 gets (parenthesis) tags');
      const saved = fs.readFileSync(path.join(tmp, 'output', a.transcript), 'utf8');
      assert.ok(saved.startsWith('<|speaker:0|>') && saved.includes('<|speaker:1|>'), 'transcript records who voiced each line');
      assert.equal(a.chunks, 6);
    }
  });
  await check('podcast audio: after a window fails, no more windows are sent', async () => {
    calls.tts.length = 0;
    const script = podcastScript(90, 12).replace('Turn 0', 'Turn 0 FAILHERE');
    const r = await post('/api/audio', { mode: 'podcast', title: 'Pod Fail', script, engine: 's2.1-pro-free', speakers: SPEAKERS });
    assert.notEqual(r.status, 200);
    const windows = pod().chunkDialogue(pod().parseTurns(script, HOSTS).turns).length;
    await new Promise((res) => setTimeout(res, 200)); // let any stray worker show itself
    const sent = calls.tts.filter((c) => Array.isArray(c.body.reference_id)).length;
    assert.ok(windows > 6 && sent <= 3, `stopped early: ${sent} of ${windows} windows sent`);
  });
  await check('podcast audio: redrawing a podcast illustration says it is a conversation', async () => {
    const a = await (await post('/api/audio', { mode: 'podcast', title: 'Pod Redraw', script: podcastScript(6), engine: 's2.1-pro-free', speakers: SPEAKERS })).json();
    calls.art.length = 0;
    assert.equal((await post('/api/illustrate', { file: a.file })).status, 200);
    assert.match(calls.art.at(-1).messages[0].content, /not the hosts/);
  });
  await check('podcast audio: a server whose default engine is S1 still voices podcasts', async () => {
    const s1 = await startServer({ FISH_MODEL: 's1', FISH_AUDIO_API_KEY: 'fish-test-0123456789' });
    try {
      const at = `http://127.0.0.1:${s1.port}`;
      const c = await (await fetch(`${at}/api/config`)).json();
      assert.equal(c.defaultEngine, 's1');
      assert.equal(c.podcast.defaultEngine, 's2.1-pro-free');
      const r = await fetch(`${at}/api/audio`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'podcast', title: 'S1 default', script: podcastScript(6), speakers: SPEAKERS }) });
      assert.equal(r.status, 200, await r.clone().text());
      assert.equal((await r.json()).engine, 's2.1-pro-free');
    } finally {
      s1.proc.kill();
    }
  });
  await check('podcast audio: the illustrator is told it is a conversation about the story', async () => {
    calls.art.length = 0;
    await post('/api/audio', { mode: 'podcast', title: 'Pod Art', script: podcastScript(6), engine: 's2.1-pro-free', speakers: SPEAKERS });
    const content = calls.art.at(-1).messages[0].content;
    assert.match(content, /conversation/);
    assert.match(content, /not the hosts/);
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
    const dl = await get(`${episode.url}?download=1`, { Range: 'bytes=0-1' });
    assert.equal(dl.status, 200, 'downloads ignore Range so iOS never saves a partial file');
    assert.equal((await dl.arrayBuffer()).byteLength, total);
    assert.equal((await get('/audio/..%2Fserver.js')).status, 404);
    assert.equal((await get('/audio/..%2F..%2Fetc%2Fpasswd.mp3')).status, 404);
  });
  await check('episodes made before settings were recorded show the settings every request used then', async () => {
    const out = path.join(tmp, 'output');
    fs.copyFileSync(path.join(samplesDir, 'sample-one.mp3'), path.join(out, 'legacy.mp3'));
    fs.writeFileSync(path.join(out, 'legacy.json'), JSON.stringify({ file: 'legacy.mp3', title: 'Legacy', createdAt: '2026-10-24T12:00:00.000Z', engine: 's2.1-pro-free', speed: 1.1, chunks: 1, script: 'x' }));
    const ep = (await (await get('/api/episodes')).json()).episodes.find((e) => e.file === 'legacy.mp3');
    assert.deepEqual(ep.settings, { temperature: 0.7, topP: 0.7, speed: 1.1, latency: 'normal', mp3Bitrate: 128, normalize: true, requests: 1, voicing: 'one voice' });
    fs.unlinkSync(path.join(out, 'legacy.mp3'));
    fs.unlinkSync(path.join(out, 'legacy.json'));
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
    const pods = (names, titles) => ({ mode: 'podcast', speakers: [
      { name: names[0], voiceId: VOICE_ID, voiceTitle: titles[0], voiceAuthor: 'Fish Official' },
      { name: names[1], voiceId: SARAH_ID, voiceTitle: titles[1], voiceAuthor: 'Fish Official' },
    ] });
    assert.equal(narratorCredit(pods(['Adrian', 'Sarah'], ['Adrian', 'Sarah'])), `Hosted by Adrian and Sarah (voices by Fish Official, IDs ${VOICE_ID} and ${SARAH_ID})`);
    assert.equal(narratorCredit(pods(['Adrian', 'Maya'], ['Adrian', 'Sarah'])), `Hosted by Adrian (voice by Fish Official, ID ${VOICE_ID}) and Maya (voice “Sarah” by Fish Official, ID ${SARAH_ID})`);
    assert.equal(narratorCredit({ voiceId: null, voiceTitle: 'Default voice' }), 'Narrated by the engine’s own voice');
    assert.ok(!/ by .* by /.test(narratorCredit({ voiceId: VOICE_ID, voiceTitle: 'Narrator', voiceAuthor: 'Rogen Darell Aban' })));
  });
  await check('library and player credit the narrator voice and its author', async () => {
    const js = await (await get('/app.js')).text();
    assert.match(js, /ID \$\{ep\.voiceId\}/, 'voice ID shown in the credit');
    assert.match(js, /\/api\/delete/);
    assert.match(js, /voice: state\.voice,/);
    assert.match(js, /voiceAuthor: f\.voice\.author/);
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

  const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  await check('iPhone download: /audio/<name>.m4a serves AAC with title and cover art (Messages plays AAC, not MP3)', async () => {
    if (!haveFfmpeg) return console.log('    (skipped: ffmpeg not installed)');
    const out = path.join(tmp, 'output');
    fs.mkdirSync(out, { recursive: true });
    const png = path.join(out, 'cover-fixture.png');
    assert.equal(spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=orange:s=64x64', '-frames:v', '1', png]).status, 0);
    const src = path.join(out, 'iphone-test.mp3');
    const made = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-i', png, '-map', '0:a', '-map', '1:v',
      '-c:a', 'libmp3lame', '-ar', '44100', '-ac', '1', '-b:a', '128k', '-c:v', 'png', '-id3v2_version', '3',
      '-metadata', 'title=Test Episode', '-metadata', 'artist=Podcast Studio', '-metadata', 'album=Podcast Studio', '-disposition:v', 'attached_pic', src]);
    assert.equal(made.status, 0, 'fixture mp3 with cover art created: ' + made.stderr);
    assert.equal((await (await get('/api/config')).json()).m4a, true, 'config reports that .m4a conversion is available');
    const r = await get('/audio/iphone-test.m4a?download=1');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/mp4');
    assert.match(r.headers.get('content-disposition'), /attachment; filename="iphone-test\.m4a"/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(4, 8).toString('latin1'), 'ftyp', 'MP4 container');
    const probe = JSON.parse(String(spawnSync('ffprobe', ['-v', 'error', '-of', 'json', '-show_streams', '-show_format', path.join(out, 'iphone-test.m4a')]).stdout));
    assert.equal(probe.streams.find((s) => s.codec_type === 'audio').codec_name, 'aac');
    const pic = probe.streams.find((s) => s.codec_type === 'video');
    assert.ok(pic && ['png', 'mjpeg'].includes(pic.codec_name) && pic.disposition.attached_pic === 1, 'cover art embedded as attached picture');
    assert.equal(probe.format.tags.title, 'Test Episode');
    assert.equal(probe.format.tags.artist, 'Podcast Studio');
    const again = await get('/audio/iphone-test.m4a?download=1', { Range: 'bytes=0-1' });
    assert.equal(again.status, 200, 'downloads ignore Range');
    assert.equal((await again.arrayBuffer()).byteLength, buf.length, 'second request served whole from the cached copy');
    assert.equal((await get('/audio/missing-episode.m4a?download=1')).status, 404);
    assert.equal((await get('/audio/..%2Fserver.m4a')).status, 404);
  });
  await check('without ffmpeg: config says so and the .m4a route answers with a JSON error, never audio', async () => {
    const out = path.join(tmp, 'output');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'nocache.mp3'), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4000, 7)]));
    const { proc: c2, port: port2 } = await startServer({ FFMPEG_PATH: '/no/such/ffmpeg' });
    try {
      assert.equal((await (await fetch(`http://127.0.0.1:${port2}/api/config`)).json()).m4a, false);
      const r = await fetch(`http://127.0.0.1:${port2}/audio/nocache.m4a?download=1`);
      assert.equal(r.status, 501);
      assert.match(r.headers.get('content-type'), /json/);
      assert.equal(r.headers.get('content-disposition'), null, 'an error is never offered as a file download');
      assert.match((await r.json()).error, /ffmpeg/);
    } finally {
      c2.kill();
    }
  });

  for (const proc of servers) proc.kill();
  upstream.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${process.exitCode ? 'FAILED' : 'All'} ${pass} checks passed`);
  // Open keep-alive sockets or a stray child must never keep the run alive.
  process.exit(process.exitCode || 0);
})();
