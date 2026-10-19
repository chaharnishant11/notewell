import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Root directory for downloaded model weights (Whisper, Silero VAD). */
export function defaultModelDir(): string {
  return process.env.NOTEWELL_MODEL_DIR ?? join(homedir(), ".notewell", "models");
}

export interface ModelFileOptions {
  cacheDir?: string;
  revision?: string;
  /** Hugging Face endpoint; override with HF_ENDPOINT for mirrors. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Return a local path for `file` from Hugging Face repo `repo`, downloading it
 * once into the cache. Writes go to a temp file first so an interrupted
 * download never leaves a truncated model behind.
 */
export async function resolveModelFile(repo: string, file: string, options: ModelFileOptions = {}): Promise<string> {
  const cacheDir = options.cacheDir ?? defaultModelDir();
  const revision = options.revision ?? "main";
  const target = join(cacheDir, repo, revision, file);
  try {
    if ((await stat(target)).size > 0) return target;
  } catch {
    // not cached yet
  }
  const endpoint = options.endpoint ?? process.env.HF_ENDPOINT ?? "https://huggingface.co";
  const url = `${endpoint}/${repo}/resolve/${encodeURIComponent(revision)}/${file}`;
  const response = await (options.fetchImpl ?? fetch)(url);
  if (!response.ok) throw new Error(`model download failed: ${response.status} ${response.statusText} for ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.partial-${process.pid}`;
  await writeFile(partial, bytes);
  await rename(partial, target);
  return target;
}
