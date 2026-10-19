# 00 · Method: how this teardown was produced

This repository documents how the Granola desktop app captures and transcribes meetings and how it
turns rough notes into enhanced notes, and it contains an original, open re-implementation of
those ideas ([notewell](../notewell/)). This page explains how the analysis was done, what the
evidence references mean, and where the analysis stops.

## Target

| | |
|---|---|
| Product | Granola desktop (`com.granola.app`), macOS universal build |
| Version | 7.663.2 (release date in the update feed: 2026-10-15) |
| Obtained from | Granola's public update feed `api.granola.ai/v1/check-for-update/latest-mac.yml`, which points at `Granola-7.663.2-mac-universal.zip` on Granola's CloudFront distribution |
| Archive check | SHA-512 of the zip matched the value published in the update feed |
| `app.asar` SHA-256 | `17046e95777b85a211b1e6676ac86bd5835c30b51928051411a796017a1302b9` |
| Electron | Fuses read with REA: `RunAsNode` and `EnableNodeCliInspectArguments` disabled, `OnlyLoadAppFromAsar` and embedded ASAR integrity validation enabled |

The ASAR's declared integrity (in `Info.plist`) covers the archive header. Eight unpacked native
`.node` files differ from the hashes recorded in the archive, which is expected because macOS code
signing rewrites them after packing. REA flagged this and the analysis continued with
`--integrity-policy record-and-continue`, which keeps those bytes marked as untrusted.

## Tooling

- **[REA](https://github.com/morluto/rea) 6.7.0** (`rea-agents` on npm), used through its CLI:
  - `analyze-javascript-application` on `app.asar`, restricted to the 67 main-process, preload and
    utility-process files plus `package.json`. It reconstructs modules, Electron boundaries
    (BrowserWindow preferences, preload/contextBridge, IPC, utility processes, native add-ons) and
    returns an Evidence record. Evidence id:
    `ev_237a71f8490441393fa8f87afca8d558bd680bc02fe3557c0d80dae4cd71068b`.
  - `inspect-electron-fuses` on the app bundle.
- **Binary inspection without a decompiler:** `llvm-nm`, `llvm-objdump` and `strings` on the Mach-O
  add-ons and helper executables (imported frameworks and symbols, Objective-C/Swift metadata and
  string tables). No Hopper, Ghidra or IDA was available, so there is no pseudocode for native code.
- **Targeted reading of the minified bundles.** Granola's JavaScript ships without source maps and
  is minified, so most findings come from searching the bundles for literals (hosts, endpoint
  paths, flag names, message types) and reading the surrounding code.
- **Parallel research.** Four research passes ran in parallel, one each for cloud transcription,
  on-device audio/ASR/diarization, AI enhancement, and API/data model. Each pass wrote notes in which
  every claim cites its evidence. The topic documents in this folder are edited syntheses of
  those notes.

## Ground rules

- **Static only.** No Granola executable or script was run, and nothing was sent to Granola's API.
  The only network requests to Granola were downloading the public update manifest and installer.
- **No secrets.** Values such as identity-pool IDs, telemetry DSNs and embedded tokens are redacted
  wherever they appear in the notes. Nothing here helps anyone authenticate as someone else or bypass
  access controls.
- **No Granola code in this repository.** The documents name identifiers, endpoint paths, flag names,
  constants and short literals where the literal itself is the finding, and describe logic in prose
  or pseudocode. The re-implementation was written from scratch.

## Reading the evidence

Each claim is labelled:

- **Observed**: the fact appears literally in the shipped code or binary (a URL, a constant, a
  parameter name, a branch).
- **Inferred**: a conclusion drawn from observed code, such as what a server must do with a request
  it receives.
- **Unknown**: the question could not be answered from the client, usually because the behavior is
  server-side or behind a remote feature flag.

References look like `main/index.js@4973046`: a bundle file inside `app.asar` (paths under
`dist-electron/` are abbreviated, renderer chunks live under `dist-app/assets/`) and a **character
offset** into that file, the JavaScript string index you get from `indexOf`. The minified files are
mostly a single line, so offsets work better than line numbers. Native references read like
`granola-diarizer: <symbol or string>`.

## Limits

- **Remote configuration decides a lot.** Many behaviors (transcription provider, on-device ASR,
  live diarization, durable streams) are behind feature flags whose bundle defaults are often
  "off". Which users get which variant is decided server-side and is not visible here.
- **Prompts and model routing are server-side.** The client sends a prompt slug and variables. The
  actual prompt text and the model for each slug are not in the app.
- **Static analysis cannot prove runtime reachability.** A code path being present doesn't mean it
  runs for a given user. REA's graph coverage is also partial: its semantic graph hit the
  100,000-node limit, and IPC channel names that Sentry builds at runtime stay unresolved.
- **One version, one platform.** Everything describes macOS build 7.663.2. Windows code paths are
  mentioned only where the shared JavaScript reveals them.

## Reproducing

```bash
# 1. Find the current version and download the public build
curl -sL https://api.granola.ai/v1/check-for-update/latest-mac.yml
curl -LO https://dr2v7l5emb758.cloudfront.net/<version>/Granola-<version>-mac-universal.zip
# verify the sha512 from the manifest, then
unzip -q Granola-<version>-mac-universal.zip -d granola

# 2. Static Electron analysis with REA
npx -y rea-agents@latest analyze-javascript-application \
  granola/Granola.app/Contents/Resources/app.asar \
  --integrity-policy record-and-continue --format json --full-output > app-evidence.json
npx -y rea-agents@latest inspect-electron-fuses granola/Granola.app --format json

# 3. Extract for reading, and inspect native modules
npx -y @electron/asar extract granola/Granola.app/Contents/Resources/app.asar app
llvm-nm -m granola/Granola.app/Contents/Resources/native/macos_audio_capture.node | less
```

On Linux, REA's JavaScript analysis needs a procps-compatible `ps`. The archive is about 300 MB
and the analysis evidence about 200 MB.

## Legal and ethical note

This is interoperability and education research on a publicly distributed desktop client, done
with static analysis only. Granola's terms of service may restrict reverse engineering, so check
them and your local law before reusing these findings. "Granola" is a trademark of its owner; this
project is not affiliated with or endorsed by Granola.
