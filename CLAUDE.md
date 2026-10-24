# Podcast Studio (repo: FishAudioTrial)

One-page web app. Claude (Sonnet, `claude-sonnet-5-5`) writes a Nat-Geo-style narrative with Fish Audio tags; user reviews/approves; Fish Audio voices it; podcast-style player + download. Zero npm dependencies, Node 18+.

## Layout
- `server.js` — Node server: static files, Claude + Fish Audio proxy, key handling, range-served audio, episode library
- `public/` — `index.html`, `styles.css`, `app.js` (the one-page app)
- `test/smoke.js` — `npm test`; runs the real server against mock Claude/Fish upstreams (16 checks, all passing)
- `output/` — generated .mp3 + .json (git-ignored)

## Decisions already made (don't relitigate)
- Default audio engine `s2.1-pro-free`; selectable: s2.1-pro, s2-pro, drama-3, s1. Claude is Sonnet only (no picker; override via `CLAUDE_MODEL`).
- S2-family tags use [brackets]; `s1` uses (parentheses) with a fixed set, so the server converts and drops unknown tags.
- Keys: from `.env` / env vars, else the browser prompts on launch (held in server memory only; optional "save to .env" at mode 600). Never returned to the browser, never committed (`.env` and `output/` are git-ignored; `.env.example` has blank values).
- Server binds 127.0.0.1, rejects non-localhost Host headers and cross-origin POSTs, redacts keys from errors.
- Fish TTS: `POST https://api.fish.audio/v1/tts`, `Authorization: Bearer`, `model` header = engine. Voice search: `GET /model`.

## Status
- Built and tested against mocks only. NO live Claude/Fish Audio call has been made yet (no keys were available in the build session).
- Pushed to private GitHub repo https://github.com/skarlekar/FishAudioTrial (`origin`, tracking `main`). No `.env` or real keys tracked; `test/smoke.js` holds only fake `sk-ant-test-…` fixture keys.

## PENDING (delete this section when done)
1. Help the user put keys in `.env` (copy `.env.example`; `ANTHROPIC_API_KEY`, `FISH_AUDIO_API_KEY`), run `npm start`, open http://localhost:3000, and do the first LIVE run with the default Mount Washington brief. Fix anything that breaks against the real APIs (unverified: exact Fish response/streaming behavior, whether a ~5-min script works in one TTS request or needs the paragraph-chunk fallback, voice-search response fields, Anthropic /v1/models key check).
2. Optional ideas: fixed default narrator voice for consistency across runs, progress for chunked synthesis.
