# Sample episodes

Two finished episodes, so a fresh install has something in its library to play:

| Episode | Narrator | Engine | Length |
| --- | --- | --- | --- |
| **The Orange Cord** — a first skydive | Adrian (Fish Audio official voice) | `s2.1-pro-free` | 8:14 |
| **The Long Climb to the Clouds** — the Mount Washington Auto Road in peak foliage | "Narrator" by Rogen Darell Aban (Fish Audio community voice) | `s2.1-pro-free` | 3:40 |

Each episode is the set of files Podcast Studio writes to `output/`:

- `.mp3` — the audio, with its cover art, title, narrator and album in the ID3 tag
- `.json` — the record shown in the library (title, script, engine, voice, word count)
- `.txt` — the audio transcript: the exact text sent to Fish Audio. *The Long Climb to the Clouds* predates saved transcripts; its transcript was rebuilt from the saved script with the same text preparation the server used when it was voiced.
- `.svg` — the cover illustration Claude drew from the story. *The Long Climb to the Clouds* uses the series' default art.

## How they reach the library

When the server starts with an empty library, it copies these files into `output/` once and leaves a `.samples-added` marker there. Samples you delete stay deleted. An existing library is never changed. To get the samples again, delete `output/.samples-added` and empty `output/`.

## Terms

The scripts were written by Claude and the audio was generated with Fish Audio. The MIT license covers this project's code; these sample recordings are included for demonstration, and their use is subject to [Fish Audio's terms](https://fish.audio/terms/).
