# Podcast Studio (repo: fish-podcast-studio)

One-page web app. Claude (Sonnet, `claude-sonnet-5-5`) writes a Nat-Geo-style narrative with Fish Audio tags; user reviews/approves; Fish Audio voices it; podcast-style player + download. Zero npm dependencies, Node 18+.

## Layout
- `server.js` — Node server: static files, Claude + Fish Audio proxy, key handling, range-served audio, episode library
- `public/` — `index.html`, `styles.css`, `app.js` (the one-page app)
- `test/smoke.js` — `npm test`; runs the real server against mock Claude/Fish upstreams (22 checks, all passing)
- `start.sh` (npm start + open browser), `start-docker.sh` + `Dockerfile` (build, run container, open browser), `start-common.sh` (shared: busy-port prompt to stop + restart; stops a Docker-held port via `docker stop`, never by killing Docker's backend process)
- `docs/` — README screenshots (`brief.png`, `player.png`); `LICENSE` — MIT
- `output/` — generated .mp3 + .json (git-ignored)

## Decisions already made (don't relitigate)
- Default audio engine `s2.1-pro-free`; selectable: s2.1-pro, s2-pro, drama-3, s1. Claude is Sonnet only (no picker; override via `CLAUDE_MODEL`).
- S2-family tags use [brackets]; `s1` uses (parentheses) with a fixed set, so the server converts and drops unknown tags.
- Keys: from `.env` / env vars, else the browser prompts on launch (held in server memory only; optional "save to .env" at mode 600). Never returned to the browser, never committed (`.env` and `output/` are git-ignored; `.env.example` has blank values).
- Server binds 127.0.0.1, rejects non-localhost Host headers and cross-origin POSTs, redacts keys from errors.
- Fish TTS: `POST https://api.fish.audio/v1/tts`, `Authorization: Bearer`, `model` header = engine. Voice search: `GET /model`.
- Prompts: the system prompt (style, `DEFAULT_SYSTEM_PROMPT`) and user prompt (brief) are both editable in the UI. The server always appends `PROMPT_RULES` (length, tag syntax, output format, complete final sentence) after the style, so edits can't break parsing.
- Claude call uses `max_tokens: 16000`: Sonnet 5.5 thinks by default and thinking counts against it (a 3000 cap truncated scripts mid-sentence). `stop_reason` `max_tokens`/`refusal` is an error, never a script.
- Fish API credit is billed separately from a fish.audio web subscription; a 402 means no API credit. Audio errors show next to the Approve button.
- Docker: container listens on 0.0.0.0, published on host 127.0.0.1 only; runs as the host uid; `.env` and `output/` are bind-mounted (never in the image).

## Status
- Live runs work against the real Claude and Fish Audio APIs (s2.1-pro-free and drama-3).
- GitHub: PUBLIC repo https://github.com/skarlekar/fish-podcast-studio (MIT) (`origin`, tracking `main`). No `.env` or real keys tracked; `test/smoke.js` holds only fake `sk-ant-test-…` fixture keys.

## Ideas (not started)
- Fixed default narrator voice for consistency across runs; progress for chunked synthesis.
