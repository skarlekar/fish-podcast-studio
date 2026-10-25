# Podcast Tab Implementation Plan (revised after Opus review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the app into an *Audio Summary* tab (today's app, unchanged) and a new *Podcast* tab that turns a narrative into a two-host (male + female) bantering podcast and runs it through the same write → review → voice → listen process.

**Architecture:** Podcast logic (prompts, dialogue parsing, Fish dialogue text, windowing, credits) lives in a new pure module `podcast.js`; `server.js` branches on `mode: "podcast"` in `/api/narrative` and `/api/audio` and stores `meta.mode`/`meta.speakers`. Per Task 0, Fish voices the dialogue in windows of whole turns ≤ 700 characters, each with both voices (`reference_id` array + `<|speaker:N|>` markers), 3 requests at a time, joined in order. The page gets a two-tab switch; one set of panels is reused with per-tab drafts, per-tab prompt textareas and podcast-only controls.

**Tech Stack:** Node 18+ (no npm deps), vanilla JS/HTML/CSS, Claude Messages API (`claude-sonnet-5-5`), Fish Audio `/v1/tts`, `node test/smoke.js` (mock upstreams), ffmpeg (already used) for the Task 0 analysis.

**Spec:** `docs/superpowers/specs/2026-10-25-podcast-tab-design.md`

**Review:** An independent Opus examiner reviewed v1 (2026-10-25): "approve with changes". Every Must-fix and Should-fix is folded in below; "Changes from review" at the end maps them.

## Global Constraints
- Zero npm dependencies; CommonJS; match existing style.
- Audio-summary behaviour, prompts, files, and all 41 existing checks stay unchanged in meaning (assertions may be extended, never weakened). The Summary tab's request bodies carry no podcast fields.
- Episode files stay flat in `output/`; `meta.mode` is `"podcast"` for podcasts and absent (treated as `"summary"`) for summaries.
- Podcast engines: `s2.1-pro-free` (default), `s2.1-pro`, `s2-pro`, `drama-3`. Never `s1`. Each tab remembers its own engine choice.
- Default hosts: male `Adrian` = `bf322df2096a46f18c579d0baa36f41d`; female `Sarah` = `933563129e564b19a115bedd57b7406a` (both Fish Official).
- Host names: 1–24 chars of letters/digits/spaces/`'`/`-`/`.`, different case-insensitively. Picking a voice never renames a host.
- Podcast pace: 150 spoken words per minute; length slider stays 1–10 min.
- Don't commit or push unless the user asks; tasks end at "npm test green".
- `Dockerfile` copies `podcast.js`.

## Review Focus
1. **Two voices not distinct, or speakers swap late in a long episode** → Task 0 measures pitch per turn on a short and a ~10-minute dialogue; failure switches Task 3 to per-turn requests.
2. **Tab switched while a write/voice request runs** → tabs are disabled while busy; results are written into the draft of the mode that started the request. Pure-function test in Task 5.
3. **Claude drifts from format** (`Narrator:`/`Both:` lines, `(laughs)`/`*chuckles*`, one host only) → one corrective pass, then a clear 502; never voiced. Tests in Tasks 1–2.
4. **Host renamed after writing** → the client rewrites labels at paragraph starts; the server still refuses unknown labels with a clear message. Tests in Tasks 3 and 6.
5. **Long podcast rejected by Fish as one request** → split at turn boundaries; every chunk goes through `prepareText`, keeps its markers and the same `reference_id` array. Test in Task 3.

---

### Task 0: Voicing gate (before any UI work)

**Files:** none in the repo; scripts and audio in the session scratchpad.

- [ ] Voice two dialogues with `reference_id: [Adrian, Sarah]` on `s2.1-pro-free`: a 6-turn ~30 s exchange and a ~8,000-character (~10 min) one written by hand from the sample narratives, turns joined with `\n\n`.
- [ ] Measure: decode with ffmpeg to 16 kHz mono PCM; split at silences (`silencedetect`); estimate median F0 per voiced segment by autocorrelation (Node, no deps). Map segments to turns by order. Pass = male turns median F0 < 160 Hz, female > 170 Hz, for every turn including the last ones of the long dialogue; gaps between turns ≤ 1.2 s.
- [ ] If it passes: keep the one-request design and the `\n\n` separator (or switch to `\n` if gaps are too long). If it fails: Task 3 voices each turn separately with a single `reference_id` and joins buffers (`chunkDialogue` → per-turn list); record the decision in the spec.
- [ ] Give the user both MP3s to listen to; their ears are the final word, but don't block the build on it.

### Task 1: `podcast.js` — prompts and dialogue helpers

**Files:** Create `podcast.js`; modify `Dockerfile`, `test/smoke.js` (unit checks via `require('../podcast.js')`).

**Interfaces (all exported):**
- `PODCAST_DEFAULTS = { male: { name: 'Adrian', voiceId }, female: { name: 'Sarah', voiceId } }`, `PODCAST_WPM = 150`, `DEFAULT_PODCAST_PROMPT`, `PODCAST_RULES`, `DEFAULT_PODCAST_BRIEF` (exact copy below).
- `validHosts({ male, female }) -> { male, female }` (trimmed) — throws `Error` with a user-facing message.
- `buildPodcastSystemPrompt(minutes, style, hosts) -> string` — style (or default) with `{{male}}`/`{{female}}` replaced, then rules with `{{words}} {{minutes}} {{male}} {{female}}` replaced; no `{{` left.
- `parseTurns(script, hosts) -> { turns: [{ speaker: 0|1, name, text }], unknown: string[], preamble: string }` — a paragraph is a turn start only if it begins with a host name (exact, case-insensitive, after stripping `*`/`**` wrappers) followed by `:`; or with a denylisted label (`Narrator`, `Both`, `All`, `Host`, `Guest`, `Announcer`, `Speaker \d+`, `Host \d+`) + `:`, which goes to `unknown`. Other paragraphs continue the previous turn ("So here's the thing: …" is not a label). Text before the first turn → `preamble` (dropped). Back-to-back turns by the same host are merged.
- `checkDialogue(script, hosts) -> string|null` — problems in plain words: unknown/denylisted labels; `*…*` actions or `(laughs|chuckles|sighs|pauses…)` in parentheses; fewer than 6 turns; a host with no lines. Null when fine.
- `dialogueWords(script, hosts) -> number` (labels and `[tags]` excluded).
- `fishDialogueText(turns) -> string` — `<|speaker:N|>` + text, joined with the Task 0 separator.
- `chunkDialogue(turns, maxLen = 700) -> string[]` — whole turns in order per chunk; an over-long turn split at sentence ends, each piece re-prefixed.
- `dialogueLyrics(text, names) -> string` — markers → `Name: `.
- `renameLabels(script, oldName, newName) -> string` — rewrites `^Old:` at paragraph starts only.
- `hostedBy(speakers) -> string` — `"Adrian & Sarah"`.
- Draft helpers for the page (pure, also used by app.js via a copy-free inline export — see Task 5): `swapDraft(drafts, from, to, current) -> { drafts, load }`.

**Prompt copy (exact):**

`DEFAULT_PODCAST_PROMPT`:
```
You are the head writer of a world-class, two-host narrative podcast. You turn a story into an episode in which two hosts talk it through from beginning to end: the kind of show people binge because the hosts are sharp, warm and genuinely funny together. An expressive text-to-speech engine performs every line, so write for the ear.

THE HOSTS
- {{male}} (male) and {{female}} (female) are longtime co-hosts who like and respect each other. Both are curious, quick and funny; they trade roles through the episode, so sometimes one is the skeptic poking holes and the other the champion painting the scene, and then they swap.
- They genuinely disagree a few times, about choices and meaning rather than facts ("Would you have turned back?"), argue it out with good humour, and land somewhere or agree to disagree.

WHOSE STORY IT IS
The story was sent in by someone else. If it is told in the first person, the hosts talk about "our storyteller" or "the person who sent this in". Neither host lived it, and they never give the storyteller a name unless the story does.

THE EPISODE, IN ORDER
1. Opening: a quick hook, then the hosts welcome the listener, introduce themselves, and say in plain words what today's episode is about and what they are going to dig into.
2. The conversation (most of the episode): walk through the story from start to finish, in order. Retell its key moments in their own words, react, debate what they mean, and banter. Bring out the tension, the surprises and the human side. Keep the story's thread clear, so the listener always knows where in the story we are. If the story is short, go deeper into the choices, the why, and well-established context about the place or activity; never add events.
3. Takeaways: the hosts clearly signal the wrap-up and agree on two or three concrete takeaways (one if the episode is very short), said plainly enough to remember.
4. The listener question: one host poses a single open-ended question tied to the story for the listener to ponder; the hosts don't answer it. Then both sign off with a short, warm goodbye.

VOICE AND CRAFT
- Light-hearted, humorous and professional: quick wit, playful teasing, maybe a running joke; never mean, crude or cheesy. No profanity.
- Sound like two real people: contractions, short reactions, and longer turns when someone retells part of the story. Vary turn length. An interruption, marked by ending a turn with an em dash, at most two or three times in the episode.
- Earn the laughs from the story itself. Avoid canned podcast filler such as "Absolutely!", "Great point!" or "That's so true".
- Stay true to the story: don't invent events, named people, quotes, dates or statistics. Well-established general facts are fine; say "roughly" or "about" when unsure.
```

`PODCAST_RULES`:
```
LENGTH
Write about {{words}} spoken words in total (labels, tags and pauses excluded) so the finished audio runs about {{minutes}} minutes at a natural conversational pace. The last turn must end with a complete goodbye.

SPEAKERS (strict)
- Exactly two speakers, labelled exactly {{male}} and {{female}}. Every turn is its own paragraph and starts with the speaker's label and a colon, for example "{{male}}: ...". No other labels: no narrator, no "Both", no stage directions.
- The hosts take turns; the same host never has two turns in a row.

AUDIO TAGS (Fish Audio S2 syntax: square brackets, inside a turn after the label)
- Delivery tags at the start of the sentence they colour, e.g. [excited] [curious] [amused] [skeptical] [surprised] [warm] [serious] [teasing].
- Sounds: [laughing] or [chuckling] about four times in the whole episode, plus [sighing] or [gasping] where they fit. Pauses: [break], and [long-break] at most 4 times.
- At most two tags per turn, and leave many turns untagged.
- Never write actions in parentheses or asterisks, such as (laughs) or *chuckles*; use the bracket tags. Never put tags inside quotation marks.

OUTPUT FORMAT (strict)
Line 1: TITLE: <a short, catchy episode title>
Line 2: blank
Then the turns only, one paragraph each, separated by blank lines. No markdown, no headings, no commentary before or after.
```

`DEFAULT_PODCAST_BRIEF` (used only when the library has no summary episode):
```
Paste a story here (a narration from the Audio Summary tab works well), or pick one under "Start from an episode".
```

- [ ] **Step 1: Failing unit checks:**
  - `podcast: system prompt names both hosts, structure, storyteller and rules` — `buildPodcastSystemPrompt(5, '', {male:'Adrian', female:'Sarah'})` contains `Adrian (male)`, `Sarah (female)`, `our storyteller`, `two or three concrete takeaways`, `open-ended question`, `750 spoken words`, `labelled exactly Adrian and Sarah`, `parentheses or asterisks`; no `{{`.
  - `podcast: only host names (and known labels) start turns` — `Adrian: Hi.\n\n**sarah:** Hello!\n\nSo here's the thing: more of Sarah's turn\n\nAdrian: Bye.` → speakers `[0,1,0]`, turn 2 includes `here's the thing`; `Sure! Here's your script.\n\nAdrian: …` → preamble dropped; two consecutive Adrian turns merge.
  - `podcast: format problems are explained` — `checkDialogue` mentions `Narrator` for a `Narrator:` turn, `Both` for `Both:`, `parentheses` for `(laughs)`, `asterisks` for `*chuckles*`, `Sarah` for an Adrian-only script; null for a valid 6-turn script.
  - `podcast: Fish text and chunking keep markers` — 2 turns → `<|speaker:0|>Hi.` + separator + `<|speaker:1|>Hello!`; `chunkDialogue(turns, 60)` on 6 turns: each chunk starts with `<|speaker:`, all turns present in order.
  - `podcast: host names validated` — same name (any case) throws /different/; empty throws; `Al<script>` throws.
  - `podcast: rename, lyrics and artist` — `renameLabels('Sarah: Hi.\n\nAdrian: Sarah: is me', 'Sarah', 'Maya')` → `Maya: Hi.\n\nAdrian: Sarah: is me`; `dialogueLyrics` and `hostedBy` as before.
- [ ] **Step 2:** fail. **Step 3:** implement; Dockerfile `COPY package.json server.js podcast.js ./`. **Step 4:** green (41 + 6).

### Task 2: Podcast scripts from Claude (`/api/narrative`, `mode: "podcast"`)

**Files:** `server.js` (`handleNarrative`, `configPayload`), `test/smoke.js`.

**Interfaces:** `POST /api/narrative { mode:'podcast', system?, instructions, minutes, hosts:{male,female}, previous?, feedback? } -> { title, script, targetWords, minutes, model, mode:'podcast' }`. `configPayload().podcast = { defaultPrompt, rules, defaultBrief, hosts: PODCAST_DEFAULTS, engines: [ids ≠ 's1'], wpm: 150 }`.

- [ ] **Step 1: Failing checks** (mock Claude: when `system` contains `SPEAKERS (strict)`, reply with a valid labelled script for the names after `labelled exactly `; first reply short → length pass; brief `BADFORMAT` → first a `(laughs)`/`Narrator:` script, then valid; `ALWAYSBAD` → always bad):
  - `podcast script: podcast prompt, hosts, storyteller, length` — 200; system has `Adrian (male)`, `750 spoken words`; user message has the brief and `hosted by Adrian and Sarah`; `checkDialogue === null`; `mode === 'podcast'`.
  - `podcast script: one format correction, built on; persistent slip is an error` — `BADFORMAT` → 200, the correction message names the problem; the length pass (if any) sends the *corrected* script as the assistant turn; `ALWAYSBAD` → 502 /format/i.
  - `podcast script: bad host names → 400`.
- [ ] **Step 2:** fail. **Step 3:** podcast branch in `handleNarrative`: `validHosts`; `buildPodcastSystemPrompt`; user message `The story for today's episode:\n\n${instructions}\n\nWrite the complete ${minutes}-minute episode script now, hosted by ${male} and ${female}.`; revision message mirrors the summary one; strip preamble/merge via `parseTurns` before checking; format pass: "That script breaks the format: <problem>. Return the complete script again, fixing that and keeping everything else."; still bad → 502 `Claude didn't follow the podcast format (<problem>). Please try again.`; length pass builds on the latest valid text with podcast wording ("add exchanges and more debate about the story" / "cut repetition and tighten the exchanges") and is used only if it also passes `checkDialogue`. Summary branch untouched. **Step 4:** green.

### Task 3: Voicing a podcast (`/api/audio`, `mode: "podcast"`)

**Files:** `server.js` (`fishTts`, `handleAudio`, `drawArt`), `test/smoke.js`.

**Interfaces:** `POST /api/audio { mode:'podcast', title, script, engine, speed, source?, speakers:[{name, voiceId, voiceTitle, voiceAuthor},{…}] }` (0 = male, 1 = female) → summary response shape + `mode`, `speakers`. `fishTts(text, { engine, voiceId, speed })` accepts `voiceId` string or array. `drawArt(title, script, { podcast })`.

- [ ] **Step 1: Failing checks** (Fish mock records `reference_id`; engine `s2-pro` returns 413 when `text.length > 2500`):
  - `podcast audio: one request, both voices, markers in order` — `reference_id` = `[maleId, femaleId]`; `text` = `prepareText(fishDialogueText(turns))`; saved `.txt` equals it; meta `mode`, `speakers[1].name === 'Sarah'`, `voiceId === null`, `source` saved when sent.
  - `podcast audio: long episode split at turns, every chunk prepared and two-voiced` — several calls; each `text` starts with `<|speaker:` and equals `prepareText` of itself; same 2-item `reference_id`; saved `.txt` = chunks joined.
  - `podcast audio: refused when it can't be voiced right` — `s1` → 400 /s1/; missing `voiceId` → 400 /voice/; `Narrator:` turn → 400 naming it and the hosts; no Fish call in these cases.
  - `podcast audio: illustrator told it's a conversation` — art user message contains `conversation` and `not the hosts`.
  - `summary audio request unchanged` — the existing summary check asserts `reference_id` is a string and `meta.mode` is absent.
- [ ] **Step 2:** fail. **Step 3:** implement (Task 0's outcome decides one request vs per turn); meta `words: dialogueWords`, `speakers` strings sliced to 120, `source` sliced to 20000. **Step 4:** green.

### Task 4: Podcast credits in files and the library

**Files:** `server.js` (`episodeLyrics`, `narratorName`, `listEpisodes`), `test/smoke.js`.

- [ ] **Step 1: Failing check** `podcast files: tag credits both hosts, lyrics name speakers` — after `/api/cover`: `TPE1` = `Adrian & Sarah`; `USLT` has `Adrian: `, `Sarah: `, no `<|speaker`; `/api/episodes` gives `mode:'podcast'` / `'summary'`; `.m4a` `©lyr` has `Sarah: ` when ffmpeg exists (existing skip rule).
- [ ] **Steps 2–4:** fail → implement → green.

### Task 5: Two tabs, per-tab drafts, per-tab prompts and libraries

**Files:** `public/index.html`, `public/styles.css`, `public/app.js`, `test/smoke.js`.

**Interfaces (app.js):** `state.mode`; `state.drafts = { summary: Draft, podcast: Draft }`, `Draft = { brief, minutes, title, script, reviewOpen, engine }`; pure `swapDraft(drafts, from, to, current)` (defined in app.js inside a `// pure` block the test evaluates like `narratorCredit`); `switchMode(mode)` saves → loads → toggles `[data-mode-only]` → re-renders library → `localStorage['podcastStudio.mode']`. Tabs are disabled while `state.busy`; `writeNarrative`/Approve capture `const mode = state.mode` at start and write results into `state.drafts[mode]` (and the DOM only if still on that mode). Busy labels come from the button's mode-specific text, not `dataset.label` from another mode.
**Markup:** `<nav class="modes" role="tablist">` with `#tabSummary` ("Audio Summary") and `#tabPodcast` ("Podcast"), counts shown as "Podcast (2)"; two system-prompt textareas: existing `#systemPrompt` (`data-mode-only="summary"`, key `podcastStudio.systemPrompt`, its Reset) and new `#podcastPrompt` (`data-mode-only="podcast"`, key `podcastStudio.podcastPrompt`, its Reset). `renderRules()` uses the active mode's rules and wpm. The player stays loaded across tab switches.

- [ ] **Step 1: Failing checks:** page has `id="tabPodcast"` and `id="podcastPrompt"`; `swapDraft` eval test: switching keeps each tab's brief/script/engine; `refreshLibrary` still passes **all** episodes to `embedMissingCovers`; summary request-body builder (`buildNarrativeBody`/`buildAudioBody`, pure) produces no `mode`/`hosts`/`speakers` keys for the summary mode.
- [ ] **Step 2:** fail. **Step 3:** implement; Summary tab text, ids and behaviour unchanged. **Step 4:** green; Playwright on a temp server: switch tabs with typed briefs → each kept; tabs disabled during a (mocked or real) write; Summary writes/approves as before.

### Task 6: Podcast tab controls

**Files:** `public/index.html`, `public/styles.css`, `public/app.js`, `test/smoke.js`.

**Interfaces:** `state.hosts = { male: { name, voice }, female: { name, voice } }`; `state.voiceTarget: 'narrator'|'male'|'female'`; `selectVoice(v)` writes to the target's slot; `loadDefaultVoice` writes only the narrator slot; the picker highlight reads the target's voice; pinned rows: narrator default + *Engine voice* on Summary; on Podcast the active host's current voice pinned, no *Engine voice*.

- [ ] **Step 1: Failing checks:** page has `#hostMaleName`, `#hostFemaleName`, `#startFromEpisode`; `buildAudioBody('podcast', …)` includes `mode`, `speakers` (2, voiceIds) and `source`; `buildNarrativeBody('podcast', …)` includes `hosts`.
- [ ] **Step 2:** fail.
- [ ] **Step 3:** Podcast-only UI:
  - Brief: podcast lede; `#podcastPrompt` + note that `{{male}}`/`{{female}}` become the host names; host name inputs (Adrian/Sarah); renaming calls `renameLabels` on the current script; "Start from an episode" `<select>` of summary episodes, preselecting the newest, filling the user prompt with `stripTags(script)` (falls back to `DEFAULT_PODCAST_BRIEF`); Write reads "Write the podcast"; wait note "up to a few minutes".
  - Review: preview colours turns (`.turn.male`/`.turn.female`, bold label); stats show turns and ~minutes at 150 wpm.
  - Production: engine list without `s1` (per-tab choice kept); two host cards (name, voice, its gender tag from `voice.tags` when known, *Choose voice* sets `voiceTarget`); a hint when both hosts share a voice; Approve sends `buildAudioBody('podcast', …)`.
- [ ] **Step 4:** green; Playwright: female host voice change updates only her card; Summary still shows the single narrator picker and Engine voice.

### Task 7: Player, library and transcript credits

**Files:** `public/app.js`, `test/smoke.js`.

- [ ] `narratorCredit(ep)` (podcast branch entirely inside the function): `Hosted by Adrian and Sarah (voices by Fish Official, IDs <full> and <full>)`; a renamed host credits the voice, e.g. `Maya (voice “Sarah” by Fish Official, ID …)`. Transcript dialog note for podcasts: `Speaker 0 is Adrian, speaker 1 is Sarah.` Library rows for podcasts show a small "Podcast" label. Test: extend the `narratorCredit` eval check with both cases. Fail → implement → green.

### Task 8: Live verification, docs, review

- [ ] Temp server on 3301: from *The Orange Cord* (Start from an episode), write a 3-minute podcast; check opening that previews the topic, real disagreements about choices, humour from the story, "our storyteller" (no hosts claiming the jump), two or three takeaways, an unanswered listener question, goodbye, no `(laughs)`; voice it on `s2.1-pro-free`; pitch-check turns as in Task 0; confirm illustration, transcript, tag (ffprobe artist `Adrian & Sarah`, lyrics with names), `.m4a`; screenshots of both tabs. Ask the user before deleting the test episode.
- [ ] README (tabs, Podcast section, prompts, voices, s1 unsupported, screenshots) and CLAUDE.md (two-speaker mode → Decisions/Status).
- [ ] Final whole-branch review by a fresh Opus reviewer (superpowers:requesting-code-review); fix findings; `npm test` green; report; ask before commit/push.

## Changes from review (v1 → v2)
- Must 1 → Task 0 voicing gate with pitch measurement + per-turn fallback.
- Must 2 → tabs disabled while busy; results go to the starting mode's draft; mode-specific busy labels.
- Must 3 → separate podcast prompt textarea, key and Reset; mode-aware `renderRules`.
- Must 4 → `voiceTarget` slots; default narrator writes only its slot; target-aware highlight; mode-aware pinned rows.
- Must 5 → "Whose story it is" section in the prompt.
- Must 6 → no parentheses/asterisk actions in rules; `checkDialogue` flags them.
- Must 7 → Podcast input defaults to the newest summary's narration; "go deeper, never add events" instruction.
- Should → label detection limited to host names + denylist, preamble stripped, same-host turns merged; host renames rewrite labels; correction passes chained, podcast-specific length wording, "up to a few minutes"; chunks prepared; prompt wording (2–3 takeaways, story thread, disagreements about choices, ≤3 interruptions, ~4 laughs, open-ended unanswered question, roles traded); `embedMissingCovers` gets all episodes, tab counts, player persists; per-tab engine; tests target `#tabPodcast`, pure draft/body builders tested, summary bodies regression-tested.
- Consider → adopted: renamed-host credits, gender tags + same-voice hint, one remembered-tab store (localStorage), `meta.source`. Kept as planned: large chunks, split only on errors.
