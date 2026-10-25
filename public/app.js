'use strict';

const DEFAULT_BRIEF = `A white-knuckle drive up the Mount Washington Auto Road in New Hampshire, in the middle of peak fall foliage.

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
  voice: { id: '', title: 'Engine voice', author: null },
  defaultVoice: null, // Fish voice details for config.defaultVoiceId, once looked up
  current: null, // episode now loaded in the player
  busy: 0, // requests in flight (write and voice can overlap)
  mode: 'summary', // the active tab: 'summary' (Audio Summary) or 'podcast'
  drafts: { summary: null, podcast: null }, // each tab's brief, length, title, script, engine, review state
  hosts: null, // podcast hosts: { male: { name, voice }, female: { name, voice } }
  voiceTarget: 'male', // on the Podcast tab, which host the voice list picks for
  episodes: [], // every episode on disk; each tab lists its own kind
};

// ------------------------------------------------------------ pure helpers (tested from test/smoke.js)
/** Store the outgoing tab's inputs and hand back the incoming tab's. */
function swapDraft(drafts, from, to, current) {
  const next = { ...drafts, [from]: { ...drafts[from], ...current } };
  return { drafts: next, load: next[to] };
}

/** Rename a host's label at the start of lines only (mirrors podcast.js). */
function renameLabels(script, oldName, newName) {
  const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)([ \\t]*[*_]{0,2}[ \\t]*)${esc}([ \\t]*[*_]{0,2}[ \\t]*:)`, 'gi');
  return String(script).replace(re, (m, start, pre, post) => `${start}${pre}${newName}${post}`);
}

/** Footnote: the engine and the settings the episode was voiced with ("Engine Drama 3 (drama-3) · temperature 1.0 · …"). */
function settingsLine(ep, labels) {
  const engine = labels[ep.engine] ? `Engine ${labels[ep.engine]} (${ep.engine})` : `Engine ${ep.engine}`;
  const s = ep.settings;
  if (!s) return engine;
  const requests = `${s.requests} request${s.requests === 1 ? '' : 's'}${s.voicing && s.voicing !== 'one voice' ? `, ${s.voicing}` : ''}`;
  return [engine, `temperature ${Number(s.temperature).toFixed(1)}`, `top-p ${Number(s.topP).toFixed(1)}`, `speed ${Number(s.speed).toFixed(2)}×`, `latency ${s.latency}`, `MP3 ${s.mp3Bitrate} kbps`, requests].join(' · ');
}

/** The /api/narrative body. Audio Summary bodies are exactly what they were before podcasts existed. */
function buildNarrativeBody(mode, f) {
  const body = { system: f.system, instructions: f.instructions, minutes: f.minutes };
  if (mode === 'podcast') {
    body.mode = 'podcast';
    body.hosts = { male: f.hosts.male, female: f.hosts.female };
  }
  if (f.feedback) {
    body.feedback = f.feedback;
    body.previous = { title: f.title, script: f.script };
  }
  return body;
}

/** The /api/audio body: one narrator voice for a summary, both hosts for a podcast. */
function buildAudioBody(mode, f) {
  if (mode !== 'podcast') {
    return { title: f.title, script: f.script, engine: f.engine, voiceId: f.voice.id, voiceTitle: f.voice.title, voiceAuthor: f.voice.author, speed: f.speed };
  }
  const speaker = (h) => ({ name: h.name, voiceId: h.voice.id, voiceTitle: h.voice.title, voiceAuthor: h.voice.author });
  return { mode: 'podcast', title: f.title, script: f.script, engine: f.engine, speed: f.speed, source: f.source, speakers: [speaker(f.hosts.male), speaker(f.hosts.female)] };
}

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
      loadDefaultVoice();
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
$('#minutes').addEventListener('input', () => {
  $('#minutesOut').textContent = `${$('#minutes').value} min`;
  renderRules();
});

// The system prompt is editable and remembered in this browser; the server appends fixed rules, previewed here.
const SYSTEM_KEY = 'podcastStudio.systemPrompt';
function fillSystemPrompt() {
  let saved = null;
  try {
    saved = localStorage.getItem(SYSTEM_KEY);
  } catch {
    /* storage unavailable */
  }
  $('#systemPrompt').value = saved || state.config.defaultSystemPrompt;
  renderRules();
}
function renderRules() {
  if (!state.config) return;
  const minutes = Number($('#minutes').value);
  const podcast = state.mode === 'podcast';
  let rules = podcast ? state.config.podcast.rules : state.config.promptRules;
  if (podcast && state.hosts) rules = rules.replaceAll('{{male}}', state.hosts.male.name).replaceAll('{{female}}', state.hosts.female.name);
  $('#promptRules').textContent = rules
    .replaceAll('{{words}}', String(Math.round(minutes * (podcast ? state.config.podcast.wpm : 135))))
    .replaceAll('{{minutes}}', String(minutes));
}
$('#systemPrompt').addEventListener('input', () => {
  try {
    localStorage.setItem(SYSTEM_KEY, $('#systemPrompt').value);
  } catch {
    /* storage unavailable */
  }
});
$('#resetSystemBtn').addEventListener('click', () => {
  $('#systemPrompt').value = state.config.defaultSystemPrompt;
  try {
    localStorage.removeItem(SYSTEM_KEY);
  } catch {
    /* storage unavailable */
  }
});

// The podcast tab's system prompt has its own box, storage key and Reset.
const PODCAST_PROMPT_KEY = 'podcastStudio.podcastPrompt';
function fillPodcastPrompt() {
  let saved = null;
  try {
    saved = localStorage.getItem(PODCAST_PROMPT_KEY);
  } catch {
    /* storage unavailable */
  }
  $('#podcastPrompt').value = saved || state.config.podcast.defaultPrompt;
}
$('#podcastPrompt').addEventListener('input', () => {
  try {
    localStorage.setItem(PODCAST_PROMPT_KEY, $('#podcastPrompt').value);
  } catch {
    /* storage unavailable */
  }
});
$('#resetPodcastBtn').addEventListener('click', () => {
  $('#podcastPrompt').value = state.config.podcast.defaultPrompt;
  try {
    localStorage.removeItem(PODCAST_PROMPT_KEY);
  } catch {
    /* storage unavailable */
  }
});

// ------------------------------------------------------------ podcast hosts and story
function fillHosts() {
  $('#hostMaleName').value = state.hosts.male.name;
  $('#hostFemaleName').value = state.hosts.female.name;
  renderHostCards();
}

/** Renaming a host renames their lines in the script; picking a voice never renames anyone. */
function renameHost(slot, input) {
  const other = slot === 'male' ? 'female' : 'male';
  const name = input.value.trim();
  const old = state.hosts[slot].name;
  if (!/^[A-Za-z0-9][A-Za-z0-9 '.-]{0,23}$/.test(name) || name.toLowerCase() === state.hosts[other].name.toLowerCase()) {
    notice('Host names need 1–24 letters or digits, and the two hosts need different names.');
    input.value = old;
    return;
  }
  if (name === old) return;
  state.hosts[slot].name = name;
  $('#script').value = renameLabels($('#script').value, old, name);
  if (state.drafts.podcast) state.drafts.podcast.script = renameLabels(state.drafts.podcast.script || '', old, name);
  renderRules();
  renderHostCards();
  refreshStats();
  if (!$('#preview').hidden) renderPreview();
}
$('#hostMaleName').addEventListener('change', (e) => renameHost('male', e.target));
$('#hostFemaleName').addEventListener('change', (e) => renameHost('female', e.target));

/** "Start from an episode": the audio summaries, newest first; picking one puts its narration in the user prompt. */
function renderStoryPicker() {
  const sel = $('#startFromEpisode');
  const keep = sel.value;
  sel.replaceChildren(new Option('Choose an audio summary to use its story…', ''));
  for (const ep of state.episodes.filter((e) => (e.mode || 'summary') === 'summary' && e.script)) sel.append(new Option(ep.title, ep.file));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
}
function useStory(file) {
  const ep = state.episodes.find((e) => e.file === file);
  if (ep) $('#instructions').value = stripTags(ep.script);
}
$('#startFromEpisode').addEventListener('change', (e) => e.target.value && useStory(e.target.value));

// ------------------------------------------------------------ tabs: Audio Summary / Podcast
const MODE_KEY = 'podcastStudio.mode';
const WRITE_LABEL = { summary: 'Write the narrative', podcast: 'Write the podcast' };

function draftInputs() {
  return {
    brief: $('#instructions').value,
    minutes: Number($('#minutes').value),
    title: $('#title').value,
    script: $('#script').value,
    reviewOpen: !$('#reviewPanel').hidden,
    engine: $('#engine').value,
  };
}

function loadDraft(d) {
  $('#instructions').value = d.brief;
  $('#minutes').value = String(d.minutes);
  $('#minutesOut').textContent = `${d.minutes} min`;
  $('#title').value = d.title;
  $('#script').value = d.script;
  $('#feedback').value = '';
  $('#reviewPanel').hidden = !d.reviewOpen;
  fillEngines(d.engine);
  showTab('edit');
  refreshStats();
  setStep(d.reviewOpen ? 'review' : 'brief');
}

/** Switch tabs: keep the outgoing tab's draft, load the other's. Locked while a request runs. */
function switchMode(mode, { initial = false } = {}) {
  if (state.busy || (mode === state.mode && !initial)) return;
  const out = swapDraft(state.drafts, state.mode, mode, draftInputs());
  state.drafts = out.drafts;
  state.mode = mode;
  document.body.dataset.mode = mode;
  $('#tabSummary').setAttribute('aria-selected', String(mode === 'summary'));
  $('#tabPodcast').setAttribute('aria-selected', String(mode === 'podcast'));
  $('#writeBtn').textContent = WRITE_LABEL[mode];
  loadDraft(out.load);
  $('#instructions').placeholder = mode === 'podcast' ? state.config.podcast.defaultBrief : '';
  if (mode === 'podcast' && !$('#instructions').value.trim()) {
    const newest = $('#startFromEpisode').options[1];
    if (newest) {
      $('#startFromEpisode').value = newest.value;
      useStory(newest.value);
    }
  }
  renderRules();
  renderVoicePanel();
  renderLibrary();
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* storage unavailable */
  }
}

/** Count requests in flight; while any runs, the tabs and every action button stay locked. */
function setBusyState(busy) {
  state.busy += busy ? 1 : -1;
  const locked = state.busy > 0;
  for (const id of ['#tabSummary', '#tabPodcast', '#writeBtn', '#reviseBtn', '#redoBtn', '#approveBtn']) $(id).disabled = locked;
}

$('#tabSummary').addEventListener('click', () => switchMode('summary'));
$('#tabPodcast').addEventListener('click', () => switchMode('podcast'));
$('.modes').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const next = state.mode === 'summary' ? 'podcast' : 'summary';
  switchMode(next);
  $(next === 'podcast' ? '#tabPodcast' : '#tabSummary').focus();
});

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
  const mode = state.mode;
  const body = buildNarrativeBody(mode, {
    system: (mode === 'podcast' ? $('#podcastPrompt') : $('#systemPrompt')).value.trim(),
    instructions: $('#instructions').value.trim(),
    minutes: Number($('#minutes').value),
    hosts: state.hosts && { male: state.hosts.male.name, female: state.hosts.female.name },
    feedback,
    title: $('#title').value,
    script: $('#script').value,
  });
  if (!body.instructions) return notice(mode === 'podcast' ? 'Paste the story the hosts should talk about first.' : 'Write a user prompt first: what the story is about.');
  notice('');
  setBusy(btn, true, feedback ? 'Revising…' : mode === 'podcast' ? 'Writing… (up to a few minutes)' : 'Writing… (up to a minute)');
  setBusyState(true);
  try {
    const n = await api('/api/narrative', { body });
    if (state.mode !== mode) {
      // The other tab is showing: keep the script with the tab that asked for it.
      state.drafts[mode] = { ...state.drafts[mode], title: n.title, script: n.script, reviewOpen: true };
      return;
    }
    state.narrative = { title: n.title, script: n.script };
    $('#title').value = n.title;
    $('#script').value = n.script;
    $('#feedback').value = '';
    $('#reviewPanel').hidden = false;
    showTab('edit');
    refreshStats();
    setStep('review');
    $('#reviewPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!state.voicesLoaded) loadOfficialVoices({ quiet: true });
  } catch (ex) {
    notice(ex.message);
  } finally {
    setBusy(btn, false);
    setBusyState(false);
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
  if (state.mode === 'podcast' && state.hosts) {
    const names = [state.hosts.male.name, state.hosts.female.name].map((n) => n.toLowerCase());
    const paras = $('#script').value.split(/\n+/).filter((p) => p.trim());
    const turns = paras.filter((p) => names.includes((p.match(/^\s*[*_]{0,2}\s*([^:*_]+?)\s*[*_]{0,2}\s*:/) || [])[1]?.toLowerCase())).length;
    const words = stripTags(paras.map((p) => p.replace(/^[^:]{1,30}:\s*/, '')).join(' ')).split(/\s+/).filter(Boolean).length;
    $('#stats').textContent = `${turns} turns · ${words} words · ~${fmtTime((words / state.config.podcast.wpm) * 60)}`;
    return;
  }
  const s = scriptStats($('#script').value);
  $('#stats').textContent = `${s.words} words · ~${fmtTime(s.seconds)} · ${s.tags} tags`;
}
$('#script').addEventListener('input', refreshStats);

function renderPreview() {
  const box = $('#preview');
  box.replaceChildren();
  const hosts = state.mode === 'podcast' && state.hosts ? [state.hosts.male.name, state.hosts.female.name] : null;
  for (let para of $('#script').value.split(hosts ? /\n+/ : /\n\s*\n/)) {
    if (!para.trim()) continue;
    const p = document.createElement('p');
    if (hosts) {
      // Colour each turn by host, with the name in bold.
      const m = para.match(/^\s*[*_]{0,2}\s*([^:*_]+?)\s*[*_]{0,2}\s*:\s*/);
      const who = m ? hosts.findIndex((h) => h.toLowerCase() === m[1].toLowerCase()) : -1;
      if (who >= 0) {
        p.className = `turn ${who ? 'female' : 'male'}`;
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = `${hosts[who]}: `;
        p.append(label);
        para = para.slice(m[0].length);
      }
    }
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
function fillEngines(selected) {
  const sel = $('#engine');
  sel.replaceChildren();
  // Podcasts need an engine that can voice two hosts (no S1).
  const allowed = state.mode === 'podcast' ? state.config.podcast.engines : null;
  for (const e of state.config.engines.filter((x) => !allowed || allowed.includes(x.id))) {
    const o = document.createElement('option');
    o.value = e.id;
    o.textContent = e.label;
    sel.append(o);
  }
  const fallback = allowed ? state.config.podcast.defaultEngine : state.config.defaultEngine;
  sel.value = selected && [...sel.options].some((o) => o.value === selected) ? selected : fallback;
  updateEngineHint();
}
const engineLabels = () => Object.fromEntries((state.config?.engines || []).map((e) => [e.id, e.label]));

function updateEngineHint() {
  const id = $('#engine').value;
  const perLine = state.mode === 'podcast' && state.config && !['s2.1-pro-free', 's2.1-pro', 's2-pro'].includes(id);
  $('#engineHint').textContent = `${ENGINE_HINTS[id] || ''}${perLine ? ' For podcasts, each host\'s lines are voiced one at a time with that host\'s voice.' : ''}`;
}
$('#engine').addEventListener('change', updateEngineHint);
$('#speed').addEventListener('input', () => ($('#speedOut').textContent = `${Number($('#speed').value).toFixed(2)}×`));

let sampleAudio = null;
const voiceLabel = (v) => (v.author ? `${v.title} by ${v.author}` : v.title);

/** The voice the list is picking right now: the narrator's, or the target host's on the Podcast tab. */
const activeVoice = () => (state.mode === 'podcast' && state.hosts ? state.hosts[state.voiceTarget].voice : state.voice);

function setNarrator(v) {
  state.voice = { id: v.id, title: v.title, author: v.author || null };
  $('#voiceCurrent').textContent = voiceLabel(state.voice);
}

function selectVoice(v) {
  if (state.mode === 'podcast' && state.hosts) {
    state.hosts[state.voiceTarget].voice = { id: v.id, title: v.title, author: v.author || null, tags: v.tags || [] };
    renderHostCards();
  } else {
    setNarrator(v);
  }
  $('#voiceList').querySelectorAll('li[data-id]').forEach((li) => li.classList.toggle('sel', li.dataset.id === activeVoice().id));
}

/** One card per host: name, chosen voice, its gender tag when known, and "Choose voice". */
function renderHostCards() {
  const box = $('#hostCards');
  if (!state.hosts) return;
  box.replaceChildren();
  for (const slot of ['male', 'female']) {
    const h = state.hosts[slot];
    const card = document.createElement('div');
    card.className = `host-card${state.voiceTarget === slot ? ' active' : ''}`;
    const who = document.createElement('div');
    who.className = 'who';
    const name = document.createElement('b');
    name.textContent = `${h.name} · ${slot} host`;
    const voice = document.createElement('span');
    const gender = (h.voice.tags || []).find((t) => /^(male|female)$/i.test(t));
    voice.textContent = `Voice: ${voiceLabel(h.voice)}${gender ? ` (${gender.toLowerCase()})` : ''}`;
    who.append(name, voice);
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = state.voiceTarget === slot ? 'secondary small' : 'ghost small';
    pick.textContent = state.voiceTarget === slot ? 'Choosing…' : 'Choose voice';
    pick.addEventListener('click', () => {
      state.voiceTarget = slot;
      renderHostCards();
      renderVoicePanel();
      $('#voiceList').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    card.append(who, pick);
    box.append(card);
  }
  const same = state.hosts.male.voice.id === state.hosts.female.voice.id;
  $('#hostsHint').hidden = !same;
  $('#hostsHint').textContent = same ? 'Both hosts use the same voice, so listeners won\'t be able to tell them apart.' : '';
}

/** The default narrator and the engine's own voice are always listed first, then the search results. */
function renderVoices(items, { showEmpty = true, heading = '', more = null } = {}) {
  const ul = $('#voiceList');
  ul.replaceChildren();
  state.voiceView = { items, opts: { showEmpty, heading, more } };

  const mk = (v, sub) => {
    const li = document.createElement('li');
    li.dataset.id = v.id;
    li.className = activeVoice().id === v.id ? 'sel' : '';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'vname';
    pick.textContent = v.title;
    if (v.official) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'Official';
      pick.append(' ', b);
    }
    if (sub) {
      const s = document.createElement('span');
      s.className = 'vsub';
      s.textContent = sub;
      pick.append(s);
    }
    pick.addEventListener('click', () => selectVoice(v));
    li.append(pick);
    if (v.sample) {
      const pl = document.createElement('button');
      pl.type = 'button';
      pl.className = 'ghost vplay';
      pl.textContent = '▶ Sample';
      pl.addEventListener('click', () => {
        sampleAudio?.pause();
        sampleAudio = new Audio(v.sample);
        sampleAudio.play().catch(() => notice('Could not play that sample.'));
      });
      li.append(pl);
    }
    if (v.authorId && v.author && !v.official) {
      // Fish Audio's search only matches voice titles, so browse a creator's voices by their ID instead.
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'ghost vplay';
      more.textContent = 'More by';
      more.title = `More voices by ${v.author}`;
      more.addEventListener('click', () => searchVoices('', { author: v.authorId, authorName: v.author }));
      li.append(more);
    }
    return li;
  };

  const id = state.config.defaultVoiceId;
  const podcast = state.mode === 'podcast' && state.hosts;
  // Pinned first: the default narrator and Engine voice on Audio Summary; the target host's current voice on Podcast.
  const def = podcast ? { ...state.hosts[state.voiceTarget].voice } : state.defaultVoice || (id ? { id, title: 'Default narrator', author: null } : null);
  // The Official badge already names Fish Audio, so official voices skip the creator in their subtitle.
  const byline = (v) => (v.official ? null : v.author);
  if (podcast) ul.append(mk(def, [`Current voice for ${state.hosts[state.voiceTarget].name}`, byline(def)].filter(Boolean).join(' · ')));
  else if (def) ul.append(mk(def, ['Default narrator', byline(def)].filter(Boolean).join(' · ')));
  if (!podcast) ul.append(mk({ id: '', title: 'Engine voice', author: null }, 'No reference voice: the engine picks one, and it can vary between runs'));
  if (heading) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = heading;
    ul.append(li);
  }
  if (!items.length && showEmpty) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No voices matched. Search by voice title, or paste a voice ID or fish.audio voice link.';
    ul.append(li);
  }
  const others = items.filter((v) => !def || v.id !== def.id);
  if (items.length && !others.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = podcast ? 'That voice is already listed first above.' : 'That is the default narrator, listed first above.';
    ul.append(li);
  }
  for (const v of others) ul.append(mk(v, [byline(v), ...(v.tags || [])].filter(Boolean).join(' · ')));
  if (more) {
    const li = document.createElement('li');
    li.className = 'empty';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost small';
    b.textContent = 'Show more official voices';
    b.addEventListener('click', more);
    li.append(b);
    ul.append(li);
  }
}

/** Fish Audio's official English voices, 24 per page; "Show more" appends the next page. */
async function loadOfficialVoices({ quiet = false, page = 1 } = {}) {
  if (!state.config.hasKeys.fish) return renderVoices([], { showEmpty: false });
  try {
    const r = await api(`/api/voices?page=${page}`);
    state.officialVoices = page === 1 ? r.items : [...(state.officialVoices || []), ...r.items];
    state.voicesLoaded = true;
    const hasMore = r.items.length > 0 && state.officialVoices.length < r.total;
    renderVoices(state.officialVoices, {
      heading: 'Official voices',
      more: hasMore ? () => loadOfficialVoices({ page: page + 1 }) : null,
    });
  } catch (ex) {
    if (!quiet) notice(ex.message);
  }
}

async function searchVoices(q, { quiet = false, author = '', authorName = '' } = {}) {
  if (!state.config.hasKeys.fish) return renderVoices([], { showEmpty: false });
  if (!q && !author) return loadOfficialVoices({ quiet });
  const btn = $('#voiceBtn');
  setBusy(btn, true, 'Searching…');
  try {
    const qs = author ? `author=${encodeURIComponent(author)}` : `q=${encodeURIComponent(q)}`;
    const r = await api(`/api/voices?${qs}`);
    state.voicesLoaded = true;
    renderVoices(r.items, { heading: author ? `Voices by ${authorName}` : '' });
  } catch (ex) {
    renderVoices([], { showEmpty: !quiet });
    if (!quiet) notice(ex.message);
  } finally {
    setBusy(btn, false);
  }
}

/** Look up the default narrator's name (needs the Fish key); keep it selected unless another voice was picked. */
async function loadDefaultVoice() {
  const id = state.config.defaultVoiceId;
  if (!id || !state.config.hasKeys.fish || state.defaultVoice) return;
  try {
    const r = await api(`/api/voices?q=${id}`);
    if (r.items[0]) state.defaultVoice = r.items[0];
  } catch {
    /* keep the placeholder name */
  }
  if (state.voice.id === id && state.defaultVoice) setNarrator(state.defaultVoice);
  const view = state.voiceView || { items: [], opts: { showEmpty: false } };
  renderVoices(view.items, view.opts);
}
/** Redraw the voice list for the active tab. */
function renderVoicePanel() {
  const view = state.voiceView || { items: [], opts: { showEmpty: false } };
  renderVoices(view.items, view.opts);
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
  const errEl = $('#audioError');
  notice('');
  errEl.hidden = true;
  const mode = state.mode;
  setBusy(btn, true, 'Producing audio…');
  setBusyState(true);
  $('#progress').hidden = false;
  setStep('produce');
  progressTimer = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    $('#progressText').textContent = mode === 'podcast'
      ? `Fish Audio is voicing your hosts… ${fmtTime(s)} (a 5-minute episode can take a couple of minutes)`
      : `Fish Audio is voicing your story… ${fmtTime(s)} (a 5-minute piece can take a minute or two)`;
  }, 1000);
  try {
    const ep = await api('/api/audio', {
      body: buildAudioBody(mode, {
        title: $('#title').value.trim() || 'Untitled Episode',
        script,
        engine: $('#engine').value,
        speed: Number($('#speed').value),
        voice: state.voice,
        hosts: state.hosts,
        source: $('#instructions').value.trim(),
      }),
    });
    await embedCover(ep).catch((err) => console.warn('Cover not embedded:', err));
    loadEpisode(ep, true);
    await refreshLibrary();
    notice('Audio ready — and saved to your output folder.', 'ok', 5000);
  } catch (ex) {
    setStep('review');
    // The top-of-page notice is usually scrolled out of view here, so also show the reason by the button.
    errEl.textContent = `Audio not produced: ${ex.message}`;
    errEl.hidden = false;
    notice(ex.message);
  } finally {
    clearInterval(progressTimer);
    $('#progress').hidden = true;
    setBusy(btn, false);
    setBusyState(false);
  }
});

// ------------------------------------------------------------ player
const audio = $('#audio');
const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M6 5h4v14H6zM14 5h4v14h-4z';
const RATES = [1, 1.25, 1.5, 1.75, 2, 0.75];

/**
 * "Narrated by Sarah (voice by Fish Official, ID 9335…)". Fish voice titles can be generic ("Narrator"),
 * so then the creator is named as the narrator: "Narrated by Rogen Darell Aban ("Narrator" voice, ID 785e…)".
 */
function narratorCredit(ep) {
  if (ep.mode === 'podcast' && Array.isArray(ep.speakers)) {
    // "Hosted by Adrian and Sarah (voices by Fish Official, IDs …)"; a host renamed away from their voice's name credits the voice.
    const [a, b] = ep.speakers;
    if (a.name === a.voiceTitle && b.name === b.voiceTitle && a.voiceAuthor && a.voiceAuthor === b.voiceAuthor) {
      return `Hosted by ${a.name} and ${b.name} (voices by ${a.voiceAuthor}, IDs ${a.voiceId} and ${b.voiceId})`;
    }
    const one = (h) => {
      const voice = h.name === h.voiceTitle ? 'voice' : `voice “${h.voiceTitle || 'custom'}”`;
      return `${h.name} (${voice}${h.voiceAuthor ? ` by ${h.voiceAuthor}` : ''}, ID ${h.voiceId})`;
    };
    return `Hosted by ${one(a)} and ${one(b)}`;
  }
  if (!ep.voiceId) return ep.voiceTitle ? 'Narrated by the engine’s own voice' : '';
  const title = String(ep.voiceTitle || '').trim();
  const generic = !title || /^(the )?(narrator|narration|voice|custom voice)$/i.test(title);
  const name = generic ? ep.voiceAuthor || 'a custom voice' : title;
  const about = generic ? (title && ep.voiceAuthor ? `“${title}” voice` : '') : ep.voiceAuthor ? `voice by ${ep.voiceAuthor}` : '';
  return `Narrated by ${name} (${[about, `ID ${ep.voiceId}`].filter(Boolean).join(', ')})`;
}

/**
 * Fetch first, then save: a plain download link would save an error reply (for example "needs ffmpeg") as if it
 * were the audio file. Here an error is shown on screen and no file is created.
 */
async function saveFile(url, filename, link) {
  const label = link.textContent;
  link.textContent = 'Preparing…';
  link.setAttribute('aria-disabled', 'true');
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Download failed (${res.status}).`);
    }
    const href = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 15000);
    notice('Saved ' + filename + ' to your Downloads folder.', 'ok', 5000);
  } catch (ex) {
    notice(ex.message);
  } finally {
    link.textContent = label;
    link.removeAttribute('aria-disabled');
  }
}

/** The iPhone-friendly .m4a download (Messages can't play MP3 attachments, but it plays this AAC copy). */
function wireIphoneDownload(link, ep) {
  const url = `${ep.url.replace(/\.mp3$/, '.m4a')}?download=1`;
  const name = ep.file.replace(/\.mp3$/, '.m4a');
  link.href = url;
  link.classList.toggle('unavailable', state.config?.m4a === false);
  link.title = state.config?.m4a === false
    ? 'Needs ffmpeg — install it (macOS: brew install ffmpeg), restart the app and reload this page'
    : 'AAC version with cover art — plays when sent through Messages';
  link.onclick = (e) => {
    e.preventDefault();
    if (link.getAttribute('aria-disabled')) return;
    saveFile(url, name, link);
  };
}

function loadEpisode(ep, autoplay) {
  state.current = ep;
  $('#playerPanel').hidden = false;
  $('#playerH').textContent = ep.title;
  const when = ep.createdAt ? new Date(ep.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  $('#playerMeta').textContent = [when, narratorCredit(ep), `${ep.words} words`].filter(Boolean).join(' · ');
  $('#playerSettings').textContent = settingsLine(ep, engineLabels());
  audio.src = ep.url;
  audio.playbackRate = RATES[0];
  $('#rate').textContent = '1×';
  $('#download').href = `${ep.url}${ep.url.includes('?') ? '&' : '?'}download=1`;
  $('#download').setAttribute('download', ep.file);
  wireIphoneDownload($('#downloadIphone'), ep);
  $('#savedTo').textContent = ep.savedTo ? `Saved to ${ep.savedTo}` : `output/${ep.file}`;
  showCover(ep);

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

/** The episode's own illustration, or the series default; older episodes can have one drawn on request. */
function showCover(ep) {
  $('#coverImg').src = ep.artUrl ? `${ep.artUrl}?v=${encodeURIComponent(ep.art || '')}-${Date.now()}` : '/default-art.svg';
  $('#illustrateBtn').hidden = !!ep.artUrl;
}

$('#illustrateBtn').addEventListener('click', async () => {
  if (!state.current || !ensureKey('anthropic')) return;
  const btn = $('#illustrateBtn');
  setBusy(btn, true, 'Drawing… (up to a minute)');
  try {
    const ep = await api('/api/illustrate', { body: { file: state.current.file } });
    state.current = { ...state.current, ...ep };
    showCover(state.current);
    await embedCover(state.current).catch((err) => console.warn('Cover not embedded:', err));
    await refreshLibrary();
    notice('Illustration ready.', 'ok', 4000);
  } catch (ex) {
    notice(ex.message);
  } finally {
    setBusy(btn, false);
    if (state.current && state.current.artUrl) btn.hidden = true;
  }
});

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
  if (!state.current || /^(INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY)$/.test(document.activeElement?.tagName) || keysDialog.open || transcriptDialog.open) return;
  if (e.code === 'Space') { e.preventDefault(); $('#play').click(); }
  else if (e.code === 'ArrowLeft') $('#back').click();
  else if (e.code === 'ArrowRight') $('#fwd').click();
});

// ------------------------------------------------------------ MP3 cover art
/**
 * Players only show PNG/JPEG covers, so render the episode's illustration (or the series default) to a
 * 600×600 PNG with the same label as the player, and have the server embed it in the MP3's ID3 tag.
 */
async function renderCoverPng(ep) {
  const svg = await (await fetch(ep.artUrl || '/default-art.svg')).text();
  // Some browsers can't draw an SVG without an intrinsic size onto a canvas.
  const sized = /<svg\b[^>]*\swidth=/i.test(svg) ? svg : svg.replace(/<svg\b/i, '<svg width="600" height="600"');
  // A data: URL, because the page's Content-Security-Policy allows data: images but not blob: ones.
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 600;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, 600, 600);
  ctx.font = '600 24px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillStyle = '#f6dba0';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '3.8px';
  ctx.fillText('PODCAST STUDIO', 32, 570);
  const bytes = new Uint8Array(await (await new Promise((done) => canvas.toBlob(done, 'image/png'))).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function embedCover(ep) {
  const r = await api('/api/cover', { body: { file: ep.file, png: await renderCoverPng(ep) } });
  if (state.current && state.current.file === ep.file) {
    state.current.needsCover = false;
    // The file on disk changed under the player; reload it and carry on from the same place.
    const at = audio.currentTime;
    const playing = !audio.paused;
    audio.addEventListener('loadedmetadata', () => {
      audio.currentTime = at;
      if (playing) audio.play().catch(() => {});
    }, { once: true });
    audio.src = `${ep.url}?v=${Date.now()}`;
  }
  return r;
}

/** Older episodes (and any whose illustration changed) get their cover embedded in the background. */
let embeddingCovers = false;
async function embedMissingCovers(episodes) {
  if (embeddingCovers) return;
  embeddingCovers = true;
  try {
    for (const ep of episodes.filter((e) => e.needsCover)) {
      await embedCover(ep).catch((err) => console.warn(`Cover not embedded for ${ep.file}:`, err));
    }
  } finally {
    embeddingCovers = false;
  }
}

// ------------------------------------------------------------ library
/** Shows the exact text that was sent to Fish Audio (saved next to the MP3 since transcripts were added). */
const transcriptDialog = $('#transcriptDialog');
async function showTranscript(ep) {
  let text;
  try {
    const res = await fetch(ep.transcriptUrl);
    if (!res.ok) throw new Error(String(res.status));
    text = await res.text();
  } catch {
    return notice('Could not load that transcript.');
  }
  $('#transcriptH').textContent = ep.title;
  const who = ep.mode === 'podcast' && Array.isArray(ep.speakers) ? ` ${ep.speakers.map((s, i) => `Speaker ${i} is ${s.name}`).join(', ')}.` : '';
  $('#transcriptMeta').textContent = `The exact text Fish Audio voiced, with its audio tags (engine ${ep.engine}${ep.chunks > 1 ? `, sent in ${ep.chunks} parts` : ''}).${who}`;
  $('#transcriptText').textContent = text;
  $('#transcriptDownload').href = `${ep.transcriptUrl}?download=1`;
  $('#transcriptDownload').setAttribute('download', ep.transcript);
  $('#transcriptCopy').textContent = 'Copy';
  transcriptDialog.showModal();
}
$('#transcriptCopy').addEventListener('click', async () => {
  const btn = $('#transcriptCopy');
  try {
    await navigator.clipboard.writeText($('#transcriptText').textContent);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Select the text to copy';
  }
  setTimeout(() => (btn.textContent = 'Copy'), 2500);
});
$('#transcriptClose').addEventListener('click', () => transcriptDialog.close());

/** Two clicks: the first arms the button for a few seconds, the second deletes the audio and its record. */
async function deleteEpisode(ep, btn) {
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Confirm delete';
    btn.classList.add('armed');
    setTimeout(() => {
      if (btn.isConnected && btn.dataset.armed === '1') {
        btn.dataset.armed = '';
        btn.textContent = 'Delete';
        btn.classList.remove('armed');
      }
    }, 4000);
    return;
  }
  btn.disabled = true;
  try {
    await api('/api/delete', { body: { file: ep.file } });
    if (state.current && state.current.file === ep.file) {
      audio.pause();
      audio.removeAttribute('src');
      state.current = null;
      $('#playerPanel').hidden = true;
    }
    await refreshLibrary();
    notice(`Deleted “${ep.title}”.`, 'ok', 4000);
  } catch (ex) {
    btn.disabled = false;
    notice(ex.message);
  }
}

async function refreshLibrary() {
  let eps = [];
  try {
    eps = (await api('/api/episodes')).episodes;
  } catch {
    /* ignore */
  }
  state.episodes = eps;
  embedMissingCovers(eps); // every episode, whichever tab is showing
  renderStoryPicker();
  renderLibrary();
}

/** List the active tab's episodes; the tab labels show how many each has. */
function renderLibrary() {
  const all = state.episodes;
  const count = (m) => all.filter((ep) => (ep.mode || 'summary') === m).length;
  $('#countSummary').textContent = count('summary') ? `(${count('summary')})` : '';
  $('#countPodcast').textContent = count('podcast') ? `(${count('podcast')})` : '';
  const eps = all.filter((ep) => (ep.mode || 'summary') === state.mode);
  $('#libH').textContent = state.mode === 'podcast' ? 'Your podcasts' : 'Your episodes';
  const ul = $('#episodes');
  ul.replaceChildren();
  $('#libraryPanel').hidden = eps.length === 0;
  for (const ep of eps) {
    const li = document.createElement('li');
    li.dataset.file = ep.file;
    if (state.current && state.current.file === ep.file) li.classList.add('now');
    const thumb = document.createElement('img');
    thumb.className = 'ethumb';
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.src = ep.artUrl || '/default-art.svg';
    const t = document.createElement('div');
    t.className = 'etitle';
    t.textContent = ep.title;
    const s = document.createElement('div');
    s.className = 'esub';
    s.textContent = [
      new Date(ep.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
      narratorCredit(ep),
      `${(ep.bytes / 1048576).toFixed(1)} MB`,
    ].filter(Boolean).join(' · ');
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
    const dlPhone = document.createElement('a');
    dlPhone.className = 'ghost btn';
    dlPhone.textContent = 'Download for iPhone';
    wireIphoneDownload(dlPhone, ep);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost danger';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteEpisode(ep, del));
    act.append(play);
    if (ep.transcriptUrl) {
      const tr = document.createElement('button');
      tr.type = 'button';
      tr.className = 'secondary';
      tr.textContent = 'Transcript';
      tr.title = 'The exact text Fish Audio voiced for this episode';
      tr.addEventListener('click', () => showTranscript(ep));
      act.append(tr);
    }
    act.append(dl, dlPhone, del);
    const set = document.createElement('div');
    set.className = 'esettings';
    set.textContent = settingsLine(ep, engineLabels());
    li.append(thumb, t, s, set, act);
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
  fillSystemPrompt();
  fillPodcastPrompt();
  const d = state.config.podcast.hosts;
  state.hosts = {
    male: { name: d.male.name, voice: { id: d.male.voiceId, title: d.male.name, author: 'Fish Official' } },
    female: { name: d.female.name, voice: { id: d.female.voiceId, title: d.female.name, author: 'Fish Official' } },
  };
  state.drafts.podcast = { brief: '', minutes: 5, title: '', script: '', reviewOpen: false, engine: state.config.podcast.defaultEngine };
  fillHosts();
  const id = state.config.defaultVoiceId;
  if (id) setNarrator({ id, title: 'Default narrator', author: null });
  renderVoices([], { showEmpty: false });
  loadDefaultVoice();
  await refreshLibrary();
  let saved = null;
  try {
    saved = localStorage.getItem(MODE_KEY);
  } catch {
    /* storage unavailable */
  }
  if (saved === 'podcast') switchMode('podcast');
  const has = state.config.hasKeys;
  if (!has.anthropic || !has.fish) openKeys(false);
})();
