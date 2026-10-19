// Quick smoke test: transcribe a WAV with local Whisper via transformers.js.
// usage: NODE_USE_ENV_PROXY=1 node scripts/smoke-asr.mjs <file.wav> [model]
import { readFileSync } from "node:fs";
import { pipeline, env } from "@huggingface/transformers";

const [file, model = "onnx-community/whisper-base"] = process.argv.slice(2);
if (process.env.NOTEWELL_MODEL_DIR) env.cacheDir = process.env.NOTEWELL_MODEL_DIR;

const buf = readFileSync(file);
// Minimal PCM16 mono WAV reader for the smoke test.
const dataStart = buf.indexOf("data") + 8;
const pcm = new Int16Array(buf.buffer, buf.byteOffset + dataStart, (buf.length - dataStart) >> 1);
const audio = Float32Array.from(pcm, (s) => s / 32768);

let t = performance.now();
const asr = await pipeline("automatic-speech-recognition", model, { dtype: "q8" });
console.log(`model loaded in ${((performance.now() - t) / 1000).toFixed(1)}s`);
t = performance.now();
const out = await asr(audio, { return_timestamps: true, chunk_length_s: 30 });
console.log(`transcribed ${(audio.length / 16000).toFixed(1)}s audio in ${((performance.now() - t) / 1000).toFixed(1)}s`);
console.log(JSON.stringify(out, null, 1));
