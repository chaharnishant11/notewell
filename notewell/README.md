# notewell

A local-first meeting notepad. Write rough notes while you listen; notewell transcribes your
microphone and the meeting audio **on your machine with Whisper**, then turns your notes and the
transcript into structured notes with an OpenAI model. Your own lines stay in ink and AI additions
show in gray.

It's an original implementation inspired by the [Granola teardown](../docs/) in this repository.

## Requirements

- Node.js 22.12 or newer
- A Chromium-based browser (Chrome, Edge, Arc, Brave) for capturing meeting audio. Firefox and
  Safari can transcribe the microphone but can't share tab or system audio.
- About 85 MB of disk for the models (downloaded from Hugging Face on first run)
- An OpenAI API key for enhancement (transcription needs no key)

## Quick start

```bash
cd notewell
npm install
npm run build
export OPENAI_API_KEY=sk-...          # PowerShell: $env:OPENAI_API_KEY="sk-..."
npm start                            # → http://localhost:4747
```

1. Click **New meeting**, give it a title, and optionally add context (attendees, agenda).
2. Click **Start transcribing**. Allow the microphone, then pick the meeting's tab or window in the
   share dialog and **turn on "Share tab audio" / "Share system audio"**.
3. Jot short notes as the meeting goes. The live transcript fills the right-hand panel (Me / Them).
4. Click **Stop**. If the meeting was substantial, notes are enhanced automatically; otherwise
   pick a template and click **Enhance notes**.

### Where meeting audio comes from

| You're in | Share this | Notes |
|---|---|---|
| Google Meet, Teams or Zoom in the browser | That **tab**, with "Share tab audio" on | Works on every OS |
| A desktop meeting app on Windows or ChromeOS | **Entire screen**, with "Share system audio" on | |
| A desktop meeting app on macOS | Use the web version of the meeting in a tab | Browsers can't capture macOS system audio from other apps; a native shell is on the roadmap |

Turn off **Meeting audio** to transcribe only your microphone, which is handy for in-person
meetings.

## CLI

```bash
node dist/cli.js serve --port 4747                 # same as npm start
node dist/cli.js transcribe meeting.wav            # prints a timestamped transcript
node dist/cli.js transcribe meeting.wav --json     # segments as JSON
node dist/cli.js enhance meeting.wav --notes my-notes.md --template one-on-one
```

Run `npm link` once to get a global `notewell` command. During development, use `npm run dev`
(compiles the browser code, runs the server with `tsx`).

## Configuration

| Setting | Flag | Environment | Default |
|---|---|---|---|
| Port | `--port` | `NOTEWELL_PORT` | `4747` |
| Whisper model | `--whisper-model` | `NOTEWELL_WHISPER_MODEL` | `onnx-community/whisper-base` |
| Language | `--language` | `NOTEWELL_LANGUAGE` | auto-detect (Whisper defaults to English) |
| VAD | `--energy-vad` | | Silero VAD v5 |
| LLM model | `--llm-model` | `NOTEWELL_OPENAI_MODEL` | `gpt-5-mini` |
| LLM endpoint | | `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| API key | | `OPENAI_API_KEY` | |
| Data directory | | `NOTEWELL_DATA_DIR` | `~/.notewell` |
| Model cache | | `NOTEWELL_MODEL_DIR` | `~/.notewell/models` |
| Hugging Face mirror | | `HF_ENDPOINT` | `https://huggingface.co` |

For better accuracy try `--whisper-model onnx-community/whisper-small` (about 250 MB, slower).
`OPENAI_BASE_URL` can point at any OpenAI-compatible server, for example
`http://localhost:11434/v1` for Ollama.

Behind a corporate proxy, start Node with `NODE_USE_ENV_PROXY=1` so model downloads honour
`HTTPS_PROXY`.

## Templates

Templates live in [`src/core/enhance/templates.ts`](src/core/enhance/templates.ts): General
meeting, 1:1, Stand-up, Customer call and Candidate interview. Each template is a list of sections,
each with a heading and guidance for the model. Add your own by appending to the list.

## How it works

```
browser: mic (getUserMedia) + tab/system audio (getDisplayMedia)
   └─ AudioWorklet → mono PCM16, 100 ms batches → WebSocket (tagged per source)
server: per source → resample 16 kHz → 32 ms frames → Silero VAD → utterance segmenter
   └─ Whisper (local, serialized) → hallucination filter → transcript segments (Me / Them)
   └─ interim results every ~2 s, final text when the utterance ends → saved to ~/.notewell
enhance: notes + context + speaker-labelled transcript + template → OpenAI (streamed via SSE)
```

Details and design rationale are in [docs/04-notewell-design.md](../docs/04-notewell-design.md).

## Privacy and security

- Audio and transcripts stay on your computer. Only enhancement sends your notes, context and
  transcript text to the LLM endpoint you configure.
- The server listens on `127.0.0.1` only and rejects requests whose `Host` or `Origin` isn't
  loopback, so other web pages can't drive it.

## Tests

```bash
npm test             # unit and integration tests (no models, no network)
npm run test:live    # downloads Silero and Whisper and transcribes a public-domain clip
npm run typecheck
```

## Layout

```
src/core/audio      WAV codec, resampler, framer, PCM helpers
src/core/vad        Silero and energy VADs, utterance segmenter
src/core/asr        Whisper transcriber, hallucination filter
src/core/pipeline   per-source capture → transcript pipeline
src/core/transcript transcript model and store (Me / Them turns)
src/core/enhance    templates, prompt builder, enhancer
src/core/llm        provider interface, OpenAI streaming client
src/core/store      meeting persistence
src/server          HTTP + WebSocket server, live sessions, model engine
src/shared          wire protocol, SSE parser, provenance matcher (browser + server)
src/web             browser app and AudioWorklet
public              HTML and CSS
```
