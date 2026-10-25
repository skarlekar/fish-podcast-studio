# Podcast Studio (repo: fish-podcast-studio)

One-page web app that makes **audio summaries**: Claude (Sonnet, `claude-sonnet-5-5`) writes a National Geographic-style, single-narrator story with Fish Audio tags; the user reviews/approves; Fish Audio voices it while Claude draws a cover illustration; podcast-style player, library, transcript, download (MP3 with embedded cover). Zero npm dependencies, Node 18+. Local folder is still named `FishAudioTrial`; the GitHub repo is `fish-podcast-studio`.

## Things to do (next session starts here)

### 1. Two-speaker podcast mode — ADDITIONAL feature, planned, not started
The user wants to create real podcasts: two speakers in conversation, each with a different Fish Audio voice. This is a **second mode next to the existing audio summaries, not a replacement**. The single-narrator flow, its prompts, tests and samples must keep working unchanged.

Before building, run the brainstorming step with the user (superpowers:brainstorming): it is a project-sized change. Open questions to ask, not assume:
- What the two speakers are: two co-hosts, or host + guest/expert? Named characters? Who sets their personalities?
- What the show is like: chatty and conversational, or still documentary-toned? How long? Is the user's brief still a story (e.g. "my skydive"), or a topic to discuss?
- How the mode is chosen in the UI (toggle on the Brief panel?), and whether each mode keeps its own editable system prompt.

Starting design notes (my analysis, not decisions; confirm with the user):
- **Script format.** Claude writes dialogue with speaker labels, e.g. one turn per paragraph starting `HOST:` / `GUEST:`, with Fish tags inside the turns. Today `PROMPT_RULES` (server.js) forbids speaker labels, so podcast mode needs its own default system prompt and its own fixed rules block, plus a parser that splits the script into ordered turns and rejects unknown labels. `parseNarrative` and the length correction (`spokenWords`, ~135 wpm) need a podcast-aware path.
- **Voicing.** Fish `POST /v1/tts` takes one `reference_id` (voice) per request, so voice each turn with its speaker's voice and join the MP3 buffers in order. `handleAudio` already concatenates chunk buffers (`Buffer.concat`); keep identical `format`/`mp3_bitrate`/sample settings so the frames join cleanly. Short pauses between turns: try a `[break]` at the turn edges first. **Check first** whether Fish/S2 supports multi-speaker in a single request, which would be simpler; this is unverified.
- **Cost and time.** One TTS call per turn (maybe 30–80 calls). Add limited concurrency, retries with backoff on 429/503, and a progress display. This also covers the old idea "progress for chunked synthesis". Use `s2.1-pro-free` for live tests (free); Claude calls cost cents.
- **UI.** Two voice pickers (Speaker 1 / Speaker 2) reusing the existing picker (official voices first, ID/link lookup, More by), each with a display name. The script editor/preview shows turns colour-coded by speaker. The transcript keeps the labels.
- **Metadata and credits.** The episode JSON gets `mode: "podcast"` and `speakers: [{ label, name, voiceId, voiceTitle, voiceAuthor }]`. Footnote "Hosted by X and Y (IDs …)" instead of `narratorCredit`; ID3 `TPE1` = both names (`narratorName` currently returns one). Saved `.txt` transcript = the labelled dialogue actually voiced.
- **Unchanged.** Illustration (`drawArt`), cover tagging (`/api/cover`), delete, library, samples, Docker.
- **Tests.** `test/smoke.js` mocks Fish TTS: assert one request per turn, the right `reference_id` per speaker, order preserved, joined audio, podcast metadata and footnote. Keep every existing audio-summary check passing.

### 2. Smaller ideas
- Rebuild a transcript for the user's own older episode "The Long Climb to the Clouds" in `output/` (its sample copy in `samples/` already has one; offered, not requested).

## How we work (the user's preferences, learned over the first session)
- The user gives direct requests and expects them built, **verified live**, and then reported plainly: what changed, how it was checked, anything they must do (usually: restart).
- **Test-first.** Add failing checks to `test/smoke.js`, implement, run `npm test`, then verify against the real APIs.
- **Live checks.** Start a temporary server on a spare port (`PORT=3301 node server.js` in the background), drive it with Playwright (screenshots land in `.playwright-mcp/`, git-ignored, delete it afterwards), then stop it.
- **Never kill processes by name or pattern** (a `pkill -f` once stopped the user's server, and killing a port's listener once killed Docker Desktop's `com.docker.backend`). Stop only exact PIDs verified as `node server.js`, or use `docker stop <container>`.
- Back up `output/` (to the scratchpad) before anything that rewrites the user's MP3s or episode files.
- **Commit and push only when the user asks.** Before every commit: `npm test`, scan the staged diff for keys, confirm no `.env`, `output/` or `.playwright-mcp/` is tracked. Commit messages end with the Co-Authored-By line. The repo is PUBLIC.
- After `server.js` changes the user must restart: `./start.sh` (answer **y** to the busy-port prompt) or `./start-docker.sh`. Changes to `public/` only need a page reload.
- The user usually runs the Docker container `podcast-studio` on port 3000; it bind-mounts this folder's `output/` and `.env`.
- Keep README.md (with screenshots in `docs/`) and this file current with every feature.

## Layout
- `server.js` — Node server: static files, Claude + Fish Audio proxy, key handling, range-served audio, episode library, illustrations, transcripts, ID3 cover tagging, sample seeding
- `public/` — `index.html`, `styles.css`, `app.js` (the one-page app), `default-art.svg` (series cover), `favicon.svg`
- `test/smoke.js` — `npm test`; runs the real server against mock Claude/Fish upstreams (38 checks, all passing)
- `start.sh` (npm start + open browser), `start-docker.sh` + `Dockerfile` (build, run container, open browser), `start-common.sh` (shared: busy-port prompt to stop + restart; stops a Docker-held port via `docker stop`, never by killing Docker's backend process; `FORCE=1`, `OPEN_BROWSER=0`, `PORT`)
- `samples/` — two finished episodes (mp3/json/txt/svg) copied into an empty `output/` on first start by `seedSamples()` (marker `output/.samples-added`; `SAMPLES_DIR` env for tests); included in the Docker image; `samples/README.md` notes Fish Audio's terms apply to the recordings
- `docs/` — README screenshots (`brief.png`, `player.png`); `LICENSE` — MIT
- `output/` — per episode: `.mp3`, `.json`, `.txt`, `.svg` (git-ignored)

## Decisions already made (don't relitigate)
- Default audio engine `s2.1-pro-free`; selectable: s2.1-pro, s2-pro, drama-3, s1. Claude is Sonnet only (no picker; override via `CLAUDE_MODEL`).
- S2-family tags use [brackets]; `s1` uses (parentheses) with a fixed set, so the server converts and drops unknown tags.
- Keys: from `.env` / env vars, else the browser prompts on launch (held in server memory only; optional "save to .env" at mode 600). Never returned to the browser, never committed (`.env` and `output/` are git-ignored; `.env.example` has blank values).
- Server binds 127.0.0.1, rejects non-localhost Host headers and cross-origin POSTs, redacts keys from errors.
- Fish TTS: `POST https://api.fish.audio/v1/tts`, `Authorization: Bearer`, `model` header = engine. Voice search: `GET /model`. Fish MP3s arrive untagged.
- Prompts: the system prompt (style, `DEFAULT_SYSTEM_PROMPT`) and user prompt (brief) are both editable in the UI (system prompt remembered in localStorage). The server always appends `PROMPT_RULES` (length, tag syntax, output format, complete final sentence, no speaker labels) after the style, so edits can't break parsing.
- Claude call uses `max_tokens: 16000`: Sonnet 5.5 thinks by default and thinking counts against it (a 3000 cap truncated scripts mid-sentence). `stop_reason` `max_tokens`/`refusal` is an error, never a script. Scripts end with a goodbye.
- Fish API credit is billed separately from a fish.audio web subscription; a 402 means no API credit. Audio errors show next to the Approve button.
- Voices: default narrator `DEFAULT_VOICE_ID` = 933563129e564b19a115bedd57b7406a ("Sarah" by Fish Official; was Rogen Darell Aban's "Narrator" 785ee418…), override `FISH_VOICE_ID`. Fish `GET /model` searches titles only; `/api/voices` also takes a voice ID/fish.audio link in `q` (→ `GET /model/{id}`) and `author=<creator id>` (→ `author_id`). Official voices = author `FISH_OFFICIAL_ID` d8b0991f96b44e489422ca2ddf0bd31d ("Fish Official"); `/api/voices` with no query lists them (English, 24/page), title searches merge official matches first; items carry `official: true` and the UI shows an Official badge. Footnotes: `narratorCredit` → "Narrated by <voice name, or creator when the title is generic like 'Narrator'> (…, ID …)".
- Illustrations: one static cover per episode. `drawArt` asks Claude (ART_PROMPT, with `public/default-art.svg` as style reference) for an SVG while Fish voices the script; failure never blocks audio. `sanitizeSvg` strips scripts/handlers/foreign content/external refs; `/art/*.svg` served with a no-script CSP; shown only via `<img>`. `POST /api/illustrate {file}` draws one for an existing episode. Episodes without art show the default (mountains + auto road).
- Audio transcripts: `handleAudio` saves the exact text sent to Fish (after `prepareText`; chunks joined by blank lines) as `<episode>.txt`, `meta.transcript`; served at `/transcript/*.txt` (text/plain, no-script CSP, `?download=1`). Older episodes without one show no Transcript button. `prepareText` is unchanged since the first commit, so an old transcript can be rebuilt exactly from `meta.script` (done for the sample).
- MP3 cover tag: players need PNG/JPEG, so the browser renders the SVG (or `default-art.svg`) to a 600×600 PNG with the label (`renderCoverPng`, via a data: URL because the page CSP blocks blob: images) and `POST /api/cover {file, png}` writes an ID3v2.3 tag (TIT2, TPE1 = narrator, TALB = Podcast Studio, APIC) in front of the audio, replacing an earlier tag, via temp file + rename. `meta.coverOf` records which picture is embedded; `needsCover` in the episode list drives automatic backfill on library load; illustrate resets it.
- Delete: `POST /api/delete {file}` removes the .mp3 + .json + .svg + .txt (bare `*.mp3` names only); the UI uses a two-click confirm, no modal.
- Docker: container listens on 0.0.0.0, published on host 127.0.0.1 only; runs as the host uid with `--init`; `.env` and `output/` are bind-mounted (never in the image).
- Git: this repo has `http.postBuffer=157286400` in `.git/config` (pushes with the sample MP3s failed with HTTP 400 at the default).

## Status (end of first session, 2026-10-24)
- All features above work live against the real Claude and Fish Audio APIs. 38 tests pass.
- GitHub: PUBLIC repo https://github.com/skarlekar/fish-podcast-studio (MIT), `origin`, tracking `main`; local and GitHub in sync at `3a87e6f` before this file's latest edit. No `.env` or real keys tracked; `test/smoke.js` holds only fake `sk-ant-test-…` fixture keys. Commit author email is public.
- The user's library (`output/`) has "The Orange Cord" (Adrian) and "The Long Climb to the Clouds" (Rogen Darell Aban), the same two episodes as `samples/`.

- iPhone sharing: Messages cannot play `.mp3` attachments (same file plays via AirDrop/WhatsApp; verified on iPhone 13 Pro Max + iPhone 18 Pro Max, incl. a tag-free file), but plays AAC. `GET /audio/<episode>.m4a` converts on demand with ffmpeg (needs ffmpeg; 501 with install hint otherwise), caches `<episode>.m4a` beside the MP3, and is removed on delete. Downloads (`?download=1`) always ignore Range so iOS never saves a partial file. The .m4a carries the title/artist tags and cover art (verified: plays in Messages on iPhone and in Apple Music/QuickTime on Mac). ffmpeg is installed in the Docker image (`apk add ffmpeg`); a brew-installed ffmpeg only helps `./start.sh`, not the container. Ruled out: MP3 stream inside an MP4 container (Apple players won't open it); `afconvert` was never needed. The .m4a cache has no version invalidation: delete `output/*.m4a` after changing the ffmpeg arguments. Lyrics: the MP3 carries the narration without `[audio tags]` in an ID3 `USLT` frame (`lyricsOf`/`episodeLyrics`), set whenever the cover is embedded; `meta.lyricsIn` marks episodes tagged that way and older ones report `needsCover` so the browser re-tags them on next load. ffmpeg reads USLT as `lyrics-eng`, which the MP4 writer drops, so `ensureM4a` passes `-metadata lyrics=` explicitly (becomes `©lyr`). The two repo samples were re-tagged with lyrics. Verified by the user: Apple Music's Lyrics button shows them. `<a download>` saves any response, so the client fetches first and never saves an error body as a file.
