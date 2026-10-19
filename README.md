# granola-rea

How does [Granola](https://www.granola.ai/) transcribe meetings without a bot, and how does it turn
a few rough notes into polished meeting notes? This repository answers both questions with a
static teardown of the Granola desktop app (v7.663.2, macOS), produced with
[REA](https://github.com/morluto/rea), and an original open-source re-implementation,
**[notewell](notewell/)**.

## The teardown

| Doc | What it covers |
|---|---|
| [00 · Method](docs/00-method.md) | How the build was obtained and analyzed, evidence conventions, limits, how to reproduce |
| [01 · Architecture](docs/01-architecture.md) | Process model, preload bridge, native modules, API surface, auth, storage, sync, data model |
| [02 · Transcription](docs/02-transcription.md) | Audio capture, provider selection, token broker, streaming protocols, reliability, on-device ASR, diarization |
| [03 · AI enhancement](docs/03-ai-enhancement.md) | Triggers, prompt variables, server-side prompts, templates, streaming, gray/black provenance |
| [04 · notewell design](docs/04-notewell-design.md) | How the re-implementation maps to Granola's design and where it differs |

### Highlights

- **No bot, two streams.** The renderer captures the microphone with Chromium echo cancellation
  and system audio via `getDisplayMedia`, which the main process answers with a loopback source
  (a Core Audio tap on macOS 14+, ScreenCaptureKit on 13). Mic audio becomes "Me" and system audio
  becomes "Them", each on its own transcription stream.
- **Cloud ASR behind a token broker.** Deepgram nova-3 is the default, with AssemblyAI, Meta and a
  Granola relay selectable by flag. The client fetches short-lived provider tokens from Granola's
  API; no vendor keys ship in the app.
- **On-device options exist but are opt-in.** Parakeet (sherpa-onnx) or whisper.cpp for English
  local ASR, and a FluidAudio/CoreML diarizer for matching voice prints.
- **Prompts live on the server.** The client sends a prompt slug plus about 40 variables: notes as
  Markdown, a speaker-labelled transcript, attendees, date and time, and template sections. Results
  stream back as JSON events.
- **Gray vs black text** comes from server-computed `generated_lines` matches against your notes.

## notewell

A local-first meeting notepad built from those lessons. It transcribes mic and meeting audio
**locally with Whisper**, keeps a live Me/Them transcript, and enhances your notes with an OpenAI
model using templates. See [notewell/README.md](notewell/README.md).

```bash
cd notewell && npm install && npm run build
OPENAI_API_KEY=sk-... npm start      # http://localhost:4747
```

## Scope and disclaimer

This is static analysis of a publicly distributed client for research and interoperability. No
Granola code or binaries are included here, no secrets are published, and nothing was sent to
Granola's API. Granola's terms of service may restrict reverse engineering, so check them and your
local law before reusing these findings. This project is not affiliated with or endorsed by Granola.
