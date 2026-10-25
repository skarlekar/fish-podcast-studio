'use strict';
// Podcast mode: two hosts (male + female) talk a story through. Pure helpers used by server.js.
// Script format: "TITLE: …", a blank line, then one paragraph per turn starting "<Host name>: ".

// Energetic conversational hosts ("young, conversational, confident, brisk" Fish Official voices). The first
// choice, Adrian and Sarah, are calm narration voices (deep/slow, soft/breathy) and made podcasts sound flat.
const PODCAST_DEFAULTS = {
  male: { name: 'Mason', voiceId: '02e950ce577d4f008a2dfb4782789a3a' }, // "Mason" by Fish Official
  female: { name: 'Harper', voiceId: 'c250136a9ec74cc0b799be54664a83f2' }, // "Harper" by Fish Official
};

const PODCAST_WPM = 150; // conversation runs a little faster than documentary narration (135)

// Fish voices each request with both hosts, but over a long request it sometimes gives a short turn to the
// wrong host (8 of 27 two-word reactions in an 8,000-character test). Windows of whole turns up to this size
// got every turn right.
const PODCAST_WINDOW = 700;

const DEFAULT_PODCAST_PROMPT = `You are the head writer of a world-class, two-host narrative podcast. You turn a story into an episode in which two hosts talk it through from beginning to end: the kind of show people binge because the hosts are sharp, warm and genuinely funny together. An expressive text-to-speech engine performs every line, so write for the ear.

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
- High-energy and genuinely engaging, like a top-rated show recorded on a great day: the hosts are delighted to be here and excited to share this story. Use exclamations, quick reactions ("No way!", "Wait, what?"), real laughter and changes of pace; keep the quieter moments for the tense parts of the story so the energy has somewhere to come back from.
- Light-hearted, humorous and professional: quick wit, playful teasing, maybe a running joke; never mean, crude or cheesy. No profanity.
- Sound like two real people: contractions, short reactions, and longer turns when someone retells part of the story. Vary turn length. An interruption, marked by ending a turn with an em dash, at most two or three times in the episode.
- Earn the laughs from the story itself. Avoid canned podcast filler such as "Absolutely!", "Great point!" or "That's so true".
- Stay true to the story: don't invent events, named people, quotes, dates or statistics. Well-established general facts are fine; say "roughly" or "about" when unsure.`;

const PODCAST_RULES = `LENGTH
Write about {{words}} spoken words in total (labels, tags and pauses excluded) so the finished audio runs about {{minutes}} minutes at a natural conversational pace. The last turn must end with a complete goodbye.

SPEAKERS (strict)
- Exactly two speakers, labelled exactly {{male}} and {{female}}. Every turn is its own paragraph and starts with the speaker's label and a colon, for example "{{male}}: ...". No other labels: no narrator, no "Both", no stage directions.
- The hosts take turns; the same host never has two turns in a row.

AUDIO TAGS (Fish Audio S2 syntax: square brackets, inside a turn after the label)
- Give most turns a delivery tag at the start of the sentence it colours, and change it as the mood shifts: [excited] [very excited] [delighted] [amused] [surprised] [teasing] [curious] [skeptical] [warm] [serious].
- Laughter is tagged and spoken: [laughing] Ha! or [chuckling] Heh. About six to eight times in the episode, wherever something is actually funny. [gasping] and [sighing] where they fit. Pauses: [break], and [long-break] at most 4 times.
- At most three tags in one turn.
- Never write actions in parentheses or asterisks, such as (laughs) or *chuckles*; use the bracket tags. Never put tags inside quotation marks.

OUTPUT FORMAT (strict)
Line 1: TITLE: <a short, catchy episode title>
Line 2: blank
Then the turns only, one paragraph each, separated by blank lines. No markdown, no headings, no commentary before or after.`;

const DEFAULT_PODCAST_BRIEF = 'Paste a story here (a narration from the Audio Summary tab works well), or pick one under "Start from an episode".';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fill = (text, values) => Object.entries(values).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, String(v)), text);
const stripTags = (t) => String(t).replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();

/** Trimmed host names, or an Error a person can act on. */
function validHosts(hosts) {
  const male = String(hosts?.male ?? '').trim();
  const female = String(hosts?.female ?? '').trim();
  for (const [who, name] of [['male', male], ['female', female]]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9 '.-]{0,23}$/.test(name)) {
      throw new Error(`Give the ${who} host a name of 1–24 letters or digits (spaces, apostrophes, hyphens and dots are fine).`);
    }
  }
  if (male.toLowerCase() === female.toLowerCase()) throw new Error('The two hosts need different names.');
  return { male, female };
}

function buildPodcastSystemPrompt(minutes, style, hosts) {
  const names = { male: hosts.male, female: hosts.female };
  const head = fill(String(style || '').trim() || DEFAULT_PODCAST_PROMPT, names);
  return `${head}\n\n${fill(PODCAST_RULES, { ...names, words: Math.round(minutes * PODCAST_WPM), minutes })}`;
}

// A turn starts with a host name and a colon, allowing markdown emphasis around it ("**Sarah:**").
const labelRe = (name) => new RegExp(`^\\s*[*_]{0,2}\\s*(${escapeRe(name)})\\s*[*_]{0,2}\\s*:\\s*[*_]{0,2}\\s*`, 'i');
// Labels that are never a host: known roles, or a name-like label (one to three Capitalised words) before a colon.
// Ordinary sentences with a colon ("So here's the thing: …") have lower-case words and stay part of the turn.
const OTHER_LABEL = /^\s*[*_]{0,2}\s*(narrator|both|all|host|guest|announcer|speaker\s*\d+|host\s*\d+)\s*[*_]{0,2}\s*:/i;
const NAME_LABEL = /^\s*[*_]{0,2}\s*([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,2})\s*[*_]{0,2}\s*:/;

// Stage directions in parentheses, which TTS would read aloud; "(clearly a mistake)" is ordinary speech.
const PAREN_ACTION = /\((?:[a-z]+\s+)?(?:laugh(?:s|ing)?|chuckl(?:e|es|ing)|giggl(?:e|es|ing)|sigh(?:s|ing)?|paus(?:e|es|ing)|gasp(?:s|ing)?|whisper(?:s|ing)?|snort(?:s|ing)?|cough(?:s|ing)?|clears?\s+(?:(?:his|her|their)\s+)?throat|grin(?:s|ning)?|smil(?:e|es|ing))(?:\s+[a-z]+)*\)/i;

function parseTurns(script, hosts) {
  const res = [labelRe(hosts.male), labelRe(hosts.female)];
  const turns = [];
  const unknown = [];
  const preamble = [];
  // Every line is checked, so a turn that starts after a single line break still gets its own host.
  for (const para of String(script).replace(/\r\n/g, '\n').split(/\n+/)) {
    const p = para.trim();
    if (!p) continue;
    const speaker = res.findIndex((re) => re.test(p));
    if (speaker >= 0) {
      const text = p.replace(res[speaker], '').trim();
      const last = turns[turns.length - 1];
      if (last && last.speaker === speaker) last.text += ` ${text}`;
      else turns.push({ speaker, name: speaker ? hosts.female : hosts.male, text });
    } else if (OTHER_LABEL.test(p) || NAME_LABEL.test(p)) {
      unknown.push((p.match(OTHER_LABEL) || p.match(NAME_LABEL))[1]);
    } else if (turns.length) {
      turns[turns.length - 1].text += ` ${p}`;
    } else {
      preamble.push(p);
    }
  }
  return { turns, unknown, preamble: preamble.join('\n\n') };
}

/** Null when the dialogue can be voiced; otherwise the problem in plain words. */
function checkDialogue(script, hosts) {
  const { turns, unknown } = parseTurns(script, hosts);
  const both = `${hosts.male} and ${hosts.female}`;
  if (unknown.length) return `it has lines for “${[...new Set(unknown)].join('”, “')}”, who isn't one of the hosts (${both})`;
  const all = turns.map((t) => t.text).join('\n');
  if (/\*[^*\n]+\*/.test(all)) return 'it describes actions in asterisks (like *laughs*) instead of bracket tags';
  if (PAREN_ACTION.test(all)) return 'it describes actions in parentheses (like (laughs)) instead of bracket tags';
  if (!turns.length) return `it has no lines for ${both}`;
  for (const [i, name] of [hosts.male, hosts.female].entries()) {
    if (!turns.some((t) => t.speaker === i)) return `${name} has no lines`;
  }
  if (turns.length < 6) return `it has only ${turns.length} turns; a podcast needs a real back-and-forth (at least 6)`;
  return null;
}

function dialogueWords(script, hosts) {
  return parseTurns(script, hosts).turns.reduce((n, t) => n + (stripTags(t.text) ? stripTags(t.text).split(' ').length : 0), 0);
}

const marker = (speaker) => `<|speaker:${speaker}|>`;

function fishDialogueText(turns) {
  return turns.map((t) => marker(t.speaker) + t.text).join('\n\n');
}

/** Whole turns, in order, grouped into Fish requests of at most maxLen characters; a too-long turn is split at sentence ends. */
function chunkDialogue(turns, maxLen = PODCAST_WINDOW) {
  const pieces = [];
  for (const t of turns) {
    const one = marker(t.speaker) + t.text;
    if (one.length <= maxLen) {
      pieces.push(one);
      continue;
    }
    let cur = '';
    for (const sentence of t.text.split(/(?<=[.!?])\s+/)) {
      if (cur && (marker(t.speaker) + cur + ' ' + sentence).length > maxLen) {
        pieces.push(marker(t.speaker) + cur);
        cur = '';
      }
      cur += (cur ? ' ' : '') + sentence;
    }
    if (cur) pieces.push(marker(t.speaker) + cur);
  }
  const chunks = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && (cur + '\n\n' + p).length > maxLen) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n\n' : '') + p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Speaker markers → "Name: ", for lyrics. */
function dialogueLyrics(text, names) {
  return String(text).replace(/<\|speaker:(\d+)\|>/g, (m, n) => (names[Number(n)] ? `${names[Number(n)]}: ` : ''));
}

/** Rename a host's label at the start of lines only. */
function renameLabels(script, oldName, newName) {
  const re = new RegExp(`(^|\\n)([ \\t]*[*_]{0,2}[ \\t]*)${escapeRe(oldName)}([ \\t]*[*_]{0,2}[ \\t]*:)`, 'gi');
  return String(script).replace(re, (m, start, pre, post) => `${start}${pre}${newName}${post}`);
}

/** Turns back to the editable script form: one "Name: text" paragraph per turn. */
const turnsToScript = (turns) => turns.map((t) => `${t.name}: ${t.text}`).join('\n\n');

const hostedBy = (speakers) => speakers.map((s) => s.name).join(' & ');

module.exports = {
  PODCAST_DEFAULTS,
  PODCAST_WPM,
  PODCAST_WINDOW,
  DEFAULT_PODCAST_PROMPT,
  PODCAST_RULES,
  DEFAULT_PODCAST_BRIEF,
  validHosts,
  buildPodcastSystemPrompt,
  parseTurns,
  checkDialogue,
  dialogueWords,
  fishDialogueText,
  chunkDialogue,
  dialogueLyrics,
  renameLabels,
  hostedBy,
  turnsToScript,
};
