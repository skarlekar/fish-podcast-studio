# Podcast tab — design

## The request (user's words, 2026-10-25)
"In spite of the project being called a podcast-studio, it was only creating audio summaries. I want to move what has been built so far into an 'Audio Summary' tab. I also want you to create a 'Podcast' tab in which you will recreate the same process but use a different prompt to break the given narrative into a two people podcast. There should be a male and female host debating and bantering about the narrative from start to end. Shape the system prompt and other prompts to create world class podcast with clear starting where the host explaining what they are going to talk about, talk with each other about the subject and then finish the podcast with clear takeaways and finally giving a question to the listener to ponder about. Keep the podcast light hearted, humorous but professional."

Earlier, recorded in CLAUDE.md: the podcast is an **additional** mode; the audio-summary flow, its prompts, tests and samples keep working unchanged.

## Goals
- Two tabs: **Audio Summary** (today's app, behaviour unchanged) and **Podcast**.
- Podcast tab repeats the same process — brief → Claude writes → review/revise/edit → approve → Fish voices it (+ illustration) → player, library, transcript, downloads (MP3 with cover/lyrics, iPhone .m4a).
- The podcast script turns the given narrative into a conversation between a **male and a female host** who debate and banter through the story from start to end.
- Structure: clear opening (hosts say what the episode is about and what they'll dig into) → conversation → clear takeaways → one question for the listener to ponder → sign-off.
- Tone: light-hearted, humorous, professional. "World class."

## Non-goals
- More than two speakers; guests; live/interactive recording; music beds or sound effects.
- Changing the audio-summary prompts, output or files.
- Converting existing summary episodes in place (a podcast is a new episode; a summary's narrative can be used as the podcast's input).

## Anti-goals (would be a failure even if it technically works)
- The summary tab behaves differently than before, or its tests change meaning.
- A line voiced by the wrong host, or narrator-style text voiced with no host.
- Hosts that sound like a canned AI podcast: constant agreement, "Absolutely! Great point!", no real disagreement, jokes unrelated to the story.
- Inventing events or facts that are not in the narrative.

## Decisions (mine unless marked; the user approved the process, not these specifics)
- **Both voices per Fish request, in short windows** (Fish docs + live tests, 2026-10-25): `reference_id: [maleVoiceId, femaleVoiceId]` and `<|speaker:0|>` / `<|speaker:1|>` before each turn. Not available on `s1`. `drama-3` accepted the two-voice request but voiced Adrian's opening turn in a female voice (pitch check, 2026-10-25), so the Podcast tab offered the S2 engines only at first. *(Later, at the user's request: all five engines; Drama 3 and S1 voice each turn as its own request with that host's voice, so the mapping is right by construction.)* Measured on a 58-turn, 8,000-character dialogue (pitch per phrase + Fish ASR word timings): **one request for the whole episode put 8 of 27 short reactions in the wrong voice**; **windows of whole turns ≤ 700 characters put 28 of 28 in the right voice** and were faster (104 s vs 242 s with 3 requests at a time). So podcasts are always voiced in ≤ 700-character windows of whole turns, 3 concurrent, joined in order. The user's listening test is still the final check.
- **Default hosts (revised after the user heard the first episode as dull):** male = Fish Official "Mason" (`02e950ce577d4f008a2dfb4782789a3a`), female = Fish Official "Harper" (`c250136a9ec74cc0b799be54664a83f2`), both young/conversational/confident/brisk. The first defaults, Adrian and Sarah, are narration voices (deep/slow; soft/breathy). Host names are editable (default to the voice names) and are the speaker labels in the script (`Adrian: …`).
- **Script format:** `TITLE:` line, blank line, then one paragraph per turn starting `<Name>: `; S2 bracket tags inside turns.
- **Prompts:** an editable podcast system prompt (placeholders `{{male}}`, `{{female}}` for the host names) plus fixed podcast rules appended by the server (length, speaker labels, tags, output format) — mirroring the summary tab's design.
- **Pace:** 150 spoken words per minute for conversation (summary stays at 135).
- **Input:** the user prompt is the narrative. A "Start from an episode" picker fills it with the plain narration of an existing audio summary.
- **Library:** one library on disk; each tab lists its own kind (`meta.mode`: `"summary"` default, `"podcast"`). Player, voice search and keys are shared.
- **Transcript:** saved exactly as sent to Fish (with `<|speaker:N|>` markers); the dialog names which speaker is which. Lyrics (MP3 USLT, .m4a ©lyr) replace markers with `Name:`.
- **Credits:** footnote "Hosted by Adrian and Sarah (voices by Fish Official, IDs …)"; ID3 artist "Adrian & Sarah".
- **Illustration:** same as summaries; the art prompt is told the episode is a conversation about the story and to draw the story's subject, not the hosts.
- **Code:** podcast logic in a new `podcast.js` module (pure functions) used by `server.js`.
