# Podcast Studio

A one-page web app that turns an idea into a produced audio narrative:

1. **Brief** — two editable prompts: the **system prompt** (how Claude writes — a National Geographic-style nature-documentary narrator by default) and the **user prompt** (the story — a dramatic drive up Mount Washington's Auto Road is pre-filled).
2. **Claude writes it** — a nature-documentary-style voice-over, about 5 minutes long, with [Fish Audio expressive tags](https://docs.fish.audio/developer-guide/core-features/emotions) such as `[whispering]`, `[nervous]` and `[long-break]`.
3. **You review** — edit the script, preview the tags, or ask Claude to revise it. Nothing is voiced until you approve.
4. **Fish Audio voices it** — pick an audio engine (default `s2.1-pro-free`) and a voice.
5. **Listen** — podcast-style player (seek, ±15/30 s, speed), transcript, download, and a library of past episodes. Every episode is also saved to `./output/`.

## Run it

Requires Node 18+. No `npm install` needed — there are zero dependencies.

```bash
cp .env.example .env     # optional — see below
./start.sh               # runs npm start and opens http://localhost:3000 when it's ready
```

`npm start` works too (then open <http://localhost:3000> yourself). Use `PORT=3001 ./start.sh` for another port, or `OPEN_BROWSER=0` to skip the browser. Stop with Ctrl-C.

### With Docker

```bash
./start-docker.sh        # builds the image, (re)starts the container, opens http://localhost:3000
docker logs -f podcast-studio
docker stop podcast-studio
```

The image holds only the app. Your `.env` and `output/` are mounted from this folder, so keys and episodes stay on your machine and survive rebuilds. The container is published on `127.0.0.1` only. `PORT` and `OPEN_BROWSER` work as above. Don't run `./start.sh` and `./start-docker.sh` on the same port.

## Prompts

The system prompt and the user prompt are both editable in the Brief panel. Your system prompt is remembered in the browser; *Reset to default* restores the National Geographic-style one. The app always appends fixed rules after it — the length target (from the Length slider), Fish Audio's tag syntax and the output format — so an edit can't break parsing or voicing. Expand *Always added after your system prompt* to see them.

## API keys

| Key | Used for | Get one |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Claude Sonnet writes the script | <https://console.anthropic.com/settings/keys> |
| `FISH_AUDIO_API_KEY` | Fish Audio voices it | <https://fish.audio/go-api/> |

Put them in `.env` **or** leave them out — if either is missing, the app asks for it in the browser when it launches. Keys entered in the browser are held in the server's memory only; tick *Also save to a local .env* if you want them remembered.

### How keys are protected

- `.env` and `output/` are in `.gitignore`; only `.env.example` (blank values) is committed.
- All Claude and Fish Audio calls are made by the local Node server. Keys are never sent to the browser, and no endpoint returns them.
- The server binds to `127.0.0.1`, rejects non-localhost `Host` headers and cross-origin POSTs, and redacts keys from any error text.
- A saved `.env` is written with owner-only (`600`) permissions.

## Audio engines

Selectable in the Production panel. The default is `s2.1-pro-free`; set `FISH_MODEL` in `.env` to change it.

| Engine | Notes |
| --- | --- |
| `s2.1-pro-free` | Same model as S2.1 Pro, free for testing (no latency guarantees) |
| `s2.1-pro` | Fish Audio's recommended production model |
| `s2-pro` | Previous generation |
| `drama-3` | Expressive drama model |
| `s1` | Legacy, retires Dec 31 2026. Tags are auto-converted from `[brackets]` to `(parentheses)` and unsupported ones are dropped |

Claude always uses Sonnet (`claude-sonnet-5-5`; override with `CLAUDE_MODEL`).

## Test

```bash
npm test
```

Runs the server against mock Claude and Fish Audio endpoints (no keys or network needed) and checks the full flow, range requests, key handling and origin protection.

## Project layout

```
server.js        Node server: static files, Claude + Fish Audio proxy, key handling
public/          index.html, styles.css, app.js (the one-page app)
test/smoke.js    End-to-end test with mock upstreams
start.sh         npm start + open the browser
start-docker.sh  Build + run the Docker container + open the browser
Dockerfile       Node 22 alpine image (no keys or audio inside)
output/          Generated .mp3 + .json (git-ignored)
```
