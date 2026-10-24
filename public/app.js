'use strict';

const DEFAULT_BRIEF = `Write in the voice of a nature-documentary narrator. The subject: a white-knuckle drive up the Mount Washington Auto Road in New Hampshire, in the middle of peak fall foliage.

The road climbs about 7.6 miles to the 6,288-foot summit — steep, winding, with tight hairpins, sheer drop-offs, and on the upper stretches barely a divider or low fence between the car and open air. For the person in the car it was one of the scariest drives of their life.

Capture the creeping dread, the pounding pulse and white knuckles, the vast and beautiful autumn valley falling away below, the cloud and wind near the top, and the shaky relief of reaching the summit. Make the listener feel it.`;

const ENGINE_HINTS = {
  's2.1-pro-free': 'Same model as S2.1 Pro at no cost, for testing. No latency guarantees.',
  's2.1-pro': 'Fish Audio’s recommended production model. Uses your Fish Audio credit.',
  's2-pro': 'Previous generation, open-source model. Uses [bracket] tags.',
  'drama-3': 'Expressive drama model. Tag support may differ — listen and compare.',
  's1': 'Legacy model with a fixed tag set. Brackets are converted to (parentheses) for you; unsupported tags are dropped.',
};

const $ = (sel) => document.querySelector(sel);
const state = {
  config: null,
  narrative: null, // { title, script }
  voice: { id: '', title: 'Default voice' },
  current: null, // episode now loaded in the player
  busy: false,
};

// ------------------------------------------------------------ helpers
async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.method = 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('Could not reach the Podcast Studio server. Is it still running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let noticeTimer;
function notice(msg, kind = 'error', ms = 0) {
  const el = $('#notice');
  clearTimeout(noticeTimer);
  if (!msg) {
    el.hidden = true;
    return;
  }
  el.textContent = msg;
  el.className = `notice ${kind}`;
  el.hidden = false;
  if (ms) noticeTimer = setTimeout(() => (el.hidden = true), ms);
}

function setBusy(btn, busy, labelBusy) {
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.textContent = labelBusy;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.disabled = false;
  }
}

function setStep(active) {
  const order = ['brief', 'review', 'produce', 'listen'];
  const idx = order.indexOf(active);
  document.querySelectorAll('.steps li').forEach((li) => {
    const i = order.indexOf(li.dataset.step);
    li.classList.toggle('on', i === idx);
    li.classList.toggle('done', i < idx);
  });
}

const fmtTime = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function stripTags(t) {
  return t.replace(/\[[^\]]*\]/g, ' ').replace(/[ \t]+/g, ' ').replace(/ +([.,;:!?])/g, '$1').replace(/\n[ \t]+/g, '\n').trim();
}

/** Estimated narration length: ~140 wpm plus pauses. */
function scriptStats(text) {
  const plain = stripTags(text).replace(/\s+/g, ' ').trim();
  const words = plain ? plain.split(' ').length : 0;
  const tags = (text.match(/\[[^\]]*\]/g) || []);
  const shortBreaks = tags.filter((t) => /^\[\s*break\s*\]$/i.test(t)).length;
  const longBreaks = tags.filter((t) => /^\[\s*long-break\s*\]$/i.test(t)).length;
  const seconds = (words / 140) * 60 + shortBreaks * 0.5 + longBreaks * 1.2;
  return { words, tags: tags.length, seconds };
}

// ------------------------------------------------------------ keys dialog
const keysDialog = $('#keysDialog');

function openKeys(force) {
  const has = state.config.hasKeys;
  // When opened from the header, show both fields (blank = keep); at launch show only what's missing.
  $('#anthropicField').hidden = force ? false : has.anthropic;
  $('#fishField').hidden = force ? false : has.fish;
  $('#keysError').hidden = true;
  $('#anthropicKey').value = '';
  $('#fishKey').value = '';
  $('#keysCancel').hidden = !(has.anthropic && has.fish) && !force ? true : false;
  if (!keysDialog.open) keysDialog.showModal();
}

$('#keysBtn').addEventListener('click', () => openKeys(true));
$('#keysCancel').addEventListener('click', () => keysDialog.close());
keysDialog.addEventListener('cancel', (e) => {
  if (!(state.config.hasKeys.anthropic && state.config.hasKeys.fish)) e.preventDefault(); // can't dismiss until set
});

$('#keysForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { save: $('#saveEnv').checked };
  const a = $('#anthropicKey').value.trim();
  const f = $('#fishKey').value.trim();
  if (a) body.anthropic = a;
  if (f) body.fish = f;
  const err = $('#keysError');
  err.hidden = true;
  if (!a && !f) {
    err.textContent = 'Paste at least one key.';
    err.hidden = false;
    return;
  }
  const btn = $('#keysSave');
  setBusy(btn, true, 'Checking…');
  try {
    const cfg = await api('/api/keys', { body });
    state.config = { ...state.config, ...cfg };
    $('#anthropicKey').value = '';
    $('#fishKey').value = '';
    if (cfg.hasKeys.anthropic && cfg.hasKeys.fish) {
      keysDialog.close();
      notice('Keys connected.', 'ok', 3000);
    } else {
      openKeys(false); // still missing the other one
    }
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    setBusy(btn, false);
  }
});

// ------------------------------------------------------------ brief → narrative
$('#instructions').value = DEFAULT_BRIEF;
$('#minutes').addEventListener('input', () => ($('#minutesOut').textContent = `${$('#minutes').value} min`));

function ensureKey(which) {
  if (!state.config.hasKeys[which]) {
    openKeys(false);
    return false;
  }
  return true;
}

async function writeNarrative({ feedback } = {}) {
  if (!ensureKey('anthropic')) return;
  const btn = feedback ? $('#reviseBtn') : $('#writeBtn');
  const body = { instructions: $('#instructions').value.trim(), minutes: Number($('#minutes').value) };
  if (!body.instructions) return notice('Write a brief first.');
  if (feedback) body.feedback = feedback, (body.previous = { title: $('#title').value, script: $('#script').value });
  notice('');
  setBusy(btn, true, feedback ? 'Revising…' : 'Writing… (up to a minute)');
  [$('#writeBtn'), $('#reviseBtn'), $('#redoBtn')].forEach((b) => (b.disabled = true));
  try {
    const n = await api('/api/narrative', { body });
    state.narrative = { title: n.title, script: n.script };
    $('#title').value = n.title;
    $('#script').value = n.script;
    $('#feedback').value = '';
    $('#reviewPanel').hidden = false;
    showTab('edit');
    refreshStats();
    setStep('review');
    $('#reviewPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!state.voicesLoaded) searchVoices('narrator', true);
  } catch (ex) {
    notice(ex.message);
  } finally {
    setBusy(btn, false);
    [$('#writeBtn'), $('#reviseBtn'), $('#redoBtn')].forEach((b) => (b.disabled = false));
  }
}

$('#writeBtn').addEventListener('click', () => writeNarrative());
$('#redoBtn').addEventListener('click', () => writeNarrative());
$('#reviseBtn').addEventListener('click', () => {
  const fb = $('#feedback').value.trim();
  if (!fb) return notice('Tell Claude what to change first.');
  writeNarrative({ feedback: fb });
});
$('#feedback').addEventListener('keydown', (e) => e.key === 'Enter' && $('#reviseBtn').click());

// ------------------------------------------------------------ script editor + preview
function refreshStats() {
  const s = scriptStats($('#script').value);
  $('#stats').textContent = `${s.words} words · ~${fmtTime(s.seconds)} · ${s.tags} tags`;
}
$('#script').addEventListener('input', refreshStats);

function renderPreview() {
  const box = $('#preview');
  box.replaceChildren();
  for (const para of $('#script').value.split(/\n\s*\n/)) {
    if (!para.trim()) continue;
    const p = document.createElement('p');
    for (const part of para.split(/(\[[^\]]*\])/)) {
      if (!part) continue;
      if (/^\[[^\]]*\]$/.test(part)) {
        const s = document.createElement('span');
        s.className = 'tag' + (/break/i.test(part) ? ' pause' : '');
        s.textContent = part.slice(1, -1);
        p.append(s);
      } else {
        p.append(document.createTextNode(part));
      }
    }
    box.append(p);
  }
}

function showTab(which) {
  const edit = which === 'edit';
  $('#tabEdit').setAttribute('aria-selected', String(edit));
  $('#tabPreview').setAttribute('aria-selected', String(!edit));
  $('#script').hidden = !edit;
  $('#preview').hidden = edit;
  if (!edit) renderPreview();
}
$('#tabEdit').addEventListener('click', () => showTab('edit'));
$('#tabPreview').addEventListener('click', () => showTab('preview'));

// ------------------------------------------------------------ production settings
function fillEngines() {
  const sel = $('#engine');
  sel.replaceChildren();
  for (const e of state.config.engines) {
    const o = document.createElement('option');
    o.value = e.id;
    o.textContent = e.label;
    sel.append(o);
  }
  sel.value = state.config.defaultEngine;
  updateEngineHint();
}
function updateEngineHint() {
  $('#engineHint').textContent = ENGINE_HINTS[$('#engine').value] || '';
}
$('#engine').addEventListener('change', updateEngineHint);
$('#speed').addEventListener('input', () => ($('#speedOut').textContent = `${Number($('#speed').value).toFixed(2)}×`));

let sampleAudio = null;
function renderVoices(items, showEmpty = true) {
  const ul = $('#voiceList');
  ul.replaceChildren();

  const mk = (id, title, sub, sample) => {
    const li = document.createElement('li');
    li.className = state.voice.id === id ? 'sel' : '';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'vname';
    pick.textContent = title;
    if (sub) {
      const s = document.createElement('span');
      s.className = 'vsub';
      s.textContent = sub;
      pick.append(s);
    }
    pick.addEventListener('click', () => {
      state.voice = { id, title };
      $('#voiceCurrent').textContent = title;
      ul.querySelectorAll('li').forEach((x) => x.classList.remove('sel'));
      li.classList.add('sel');
    });
    li.append(pick);
    if (sample) {
      const pl = document.createElement('button');
      pl.type = 'button';
      pl.className = 'ghost vplay';
      pl.textContent = '▶ Sample';
      pl.addEventListener('click', () => {
        sampleAudio?.pause();
        sampleAudio = new Audio(sample);
        sampleAudio.play().catch(() => notice('Could not play that sample.'));
      });
      li.append(pl);
    }
    return li;
  };

  ul.append(mk('', 'Default voice', 'Let the engine choose — can vary between runs', null));
  if (!items.length && showEmpty) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No voices matched. Try another search.';
    ul.append(li);
  }
  for (const v of items) ul.append(mk(v.id, v.title, [v.author, ...(v.tags || [])].filter(Boolean).join(' · '), v.sample));
}

async function searchVoices(q, quiet) {
  if (!state.config.hasKeys.fish) return renderVoices([], false);
  const btn = $('#voiceBtn');
  setBusy(btn, true, 'Searching…');
  try {
    const r = await api(`/api/voices?q=${encodeURIComponent(q)}`);
    state.voicesLoaded = true;
    renderVoices(r.items);
  } catch (ex) {
    renderVoices([], !quiet);
    if (!quiet) notice(ex.message);
  } finally {
    setBusy(btn, false);
  }
}
$('#voiceBtn').addEventListener('click', () => searchVoices($('#voiceQ').value.trim()));
$('#voiceQ').addEventListener('keydown', (e) => e.key === 'Enter' && $('#voiceBtn').click());

// ------------------------------------------------------------ approve → audio
let progressTimer;
$('#approveBtn').addEventListener('click', async () => {
  if (!ensureKey('fish')) return;
  const script = $('#script').value.trim();
  if (!script) return notice('The script is empty.');
  const btn = $('#approveBtn');
  const started = Date.now();
  notice('');
  setBusy(btn, true, 'Producing audio…');
  $('#progress').hidden = false;
  setStep('produce');
  progressTimer = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    $('#progressText').textContent = `Fish Audio is voicing your story… ${fmtTime(s)} (a 5-minute piece can take a minute or two)`;
  }, 1000);
  try {
    const ep = await api('/api/audio', {
      body: {
        title: $('#title').value.trim() || 'Untitled Episode',
        script,
        engine: $('#engine').value,
        voiceId: state.voice.id,
        voiceTitle: state.voice.title,
        speed: Number($('#speed').value),
      },
    });
    loadEpisode(ep, true);
    await refreshLibrary();
    notice('Audio ready — and saved to your output folder.', 'ok', 5000);
  } catch (ex) {
    setStep('review');
    notice(ex.message);
  } finally {
    clearInterval(progressTimer);
    $('#progress').hidden = true;
    setBusy(btn, false);
  }
});

// ------------------------------------------------------------ player
const audio = $('#audio');
const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M6 5h4v14H6zM14 5h4v14h-4z';
const RATES = [1, 1.25, 1.5, 1.75, 2, 0.75];

function loadEpisode(ep, autoplay) {
  state.current = ep;
  $('#playerPanel').hidden = false;
  $('#playerH').textContent = ep.title;
  const when = ep.createdAt ? new Date(ep.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  $('#playerMeta').textContent = [when, `Engine ${ep.engine}`, ep.voiceTitle, `${ep.words} words`].filter(Boolean).join(' · ');
  audio.src = ep.url;
  audio.playbackRate = RATES[0];
  $('#rate').textContent = '1×';
  $('#download').href = `${ep.url}${ep.url.includes('?') ? '&' : '?'}download=1`;
  $('#download').setAttribute('download', ep.file);
  $('#savedTo').textContent = ep.savedTo ? `Saved to ${ep.savedTo}` : `output/${ep.file}`;

  const t = $('#transcript');
  t.replaceChildren();
  for (const para of stripTags(ep.script || '').split(/\n\s*\n/)) {
    if (!para.trim()) continue;
    const p = document.createElement('p');
    p.textContent = para.trim();
    t.append(p);
  }
  setStep('listen');
  document.querySelectorAll('#episodes li').forEach((li) => li.classList.toggle('now', li.dataset.file === ep.file));
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: ep.title, artist: 'Podcast Studio' });
  }
  $('#playerPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (autoplay) audio.play().catch(() => {});
}

function syncPlayUi() {
  $('#playIcon').setAttribute('d', audio.paused ? PLAY_PATH : PAUSE_PATH);
  $('#play').setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
}
function syncTime() {
  const d = audio.duration;
  $('#cur').textContent = fmtTime(audio.currentTime);
  $('#dur').textContent = Number.isFinite(d) ? fmtTime(d) : '–:––';
  const frac = Number.isFinite(d) && d > 0 ? audio.currentTime / d : 0;
  const seek = $('#seek');
  seek.value = String(Math.round(frac * 1000));
  seek.style.setProperty('--pos', `${(frac * 100).toFixed(2)}%`);
}
audio.addEventListener('play', syncPlayUi);
audio.addEventListener('pause', syncPlayUi);
audio.addEventListener('ended', syncPlayUi);
audio.addEventListener('timeupdate', syncTime);
audio.addEventListener('loadedmetadata', syncTime);
audio.addEventListener('durationchange', syncTime);
audio.addEventListener('error', () => notice('The audio file could not be played.'));

$('#play').addEventListener('click', () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()));
$('#back').addEventListener('click', () => (audio.currentTime = Math.max(0, audio.currentTime - 15)));
$('#fwd').addEventListener('click', () => (audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 30)));
$('#seek').addEventListener('input', (e) => {
  if (Number.isFinite(audio.duration)) audio.currentTime = (Number(e.target.value) / 1000) * audio.duration;
});
$('#rate').addEventListener('click', () => {
  const i = (RATES.indexOf(audio.playbackRate) + 1) % RATES.length;
  audio.playbackRate = RATES[i];
  $('#rate').textContent = `${RATES[i]}×`;
});
document.addEventListener('keydown', (e) => {
  if (!state.current || /^(INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY)$/.test(document.activeElement?.tagName) || keysDialog.open) return;
  if (e.code === 'Space') { e.preventDefault(); $('#play').click(); }
  else if (e.code === 'ArrowLeft') $('#back').click();
  else if (e.code === 'ArrowRight') $('#fwd').click();
});

// ------------------------------------------------------------ library
async function refreshLibrary() {
  let eps = [];
  try {
    eps = (await api('/api/episodes')).episodes;
  } catch {
    /* ignore */
  }
  const ul = $('#episodes');
  ul.replaceChildren();
  $('#libraryPanel').hidden = eps.length === 0;
  for (const ep of eps) {
    const li = document.createElement('li');
    li.dataset.file = ep.file;
    if (state.current && state.current.file === ep.file) li.classList.add('now');
    const t = document.createElement('div');
    t.className = 'etitle';
    t.textContent = ep.title;
    const s = document.createElement('div');
    s.className = 'esub';
    s.textContent = `${new Date(ep.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${ep.engine} · ${ep.voiceTitle} · ${(ep.bytes / 1048576).toFixed(1)} MB`;
    const act = document.createElement('div');
    act.className = 'eact';
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'secondary';
    play.textContent = '▶ Play';
    play.addEventListener('click', () => loadEpisode(ep, true));
    const dl = document.createElement('a');
    dl.className = 'ghost btn';
    dl.textContent = 'Download';
    dl.href = `${ep.url}?download=1`;
    dl.setAttribute('download', ep.file);
    act.append(play, dl);
    li.append(t, s, act);
    ul.append(li);
  }
}

// ------------------------------------------------------------ boot
(async function init() {
  try {
    state.config = await api('/api/config');
  } catch (ex) {
    return notice(ex.message);
  }
  fillEngines();
  renderVoices([], false);
  await refreshLibrary();
  const has = state.config.hasKeys;
  if (!has.anthropic || !has.fish) openKeys(false);
})();
