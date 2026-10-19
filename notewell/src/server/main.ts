#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createEnhancer } from "../core/enhance/enhancer.js";
import { OpenAIProvider } from "../core/llm/openai.js";
import { MeetingStore, defaultDataDir } from "../core/store/meetings.js";
import { createApp } from "./app.js";
import { Engine } from "./engine.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env.NOTEWELL_PORT ?? "4747" },
    host: { type: "string", default: "127.0.0.1" },
    "whisper-model": { type: "string" },
    language: { type: "string" },
    "llm-model": { type: "string" },
    "energy-vad": { type: "boolean", default: false },
    "no-warmup": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`notewell — local meeting notes

Usage: notewell [serve] [options]
  --port <n>             HTTP port (default 4747, env NOTEWELL_PORT)
  --host <addr>          Bind address (default 127.0.0.1; keep it on loopback)
  --whisper-model <id>   transformers.js Whisper model (default onnx-community/whisper-base)
  --language <code>      Force transcription language, e.g. en, de
  --llm-model <id>       OpenAI model for enhancement (env NOTEWELL_OPENAI_MODEL)
  --energy-vad           Use the simple energy VAD instead of Silero
  --no-warmup            Do not pre-download/load models at startup

Environment: OPENAI_API_KEY, OPENAI_BASE_URL, NOTEWELL_DATA_DIR, NOTEWELL_MODEL_DIR`);
  process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`invalid --port ${values.port}`);
  process.exit(2);
}

const engine = new Engine({
  ...(values["whisper-model"] ? { whisperModel: values["whisper-model"] } : {}),
  ...(values.language ? { language: values.language } : {}),
  energyVad: values["energy-vad"],
});
const provider = new OpenAIProvider(values["llm-model"] ? { model: values["llm-model"] } : {});
const enhancer = createEnhancer(provider);
const meetings = new MeetingStore();

const server = createApp({ engine, meetings, enhancer });
server.listen(port, values.host, () => {
  console.log(`notewell running at http://localhost:${port}`);
  console.log(`  data:   ${defaultDataDir()}`);
  console.log(`  llm:    ${provider.name} / ${enhancer.describe().model}${process.env.OPENAI_API_KEY ? "" : " (OPENAI_API_KEY not set)"}`);
  if (!values["no-warmup"]) {
    console.log("  models: loading Whisper and VAD (first run downloads ~85 MB)…");
    engine.warmUp().then(
      () => console.log("  models: ready"),
      (err: Error) => console.error(`  models: failed to load — ${err.message}`),
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
