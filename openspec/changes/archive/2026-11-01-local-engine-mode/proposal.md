# Proposal

## Why

TLC currently requires an external OpenAI-compatible completion server (LM Studio, llama-server, …). Users without a running server get no completions at all. An embedded local engine mode lets TLC download and run its own backend (a llama.cpp build + a Qwen2.5-Coder model) so completions work out of the box, including on Intel NPU via the llama.cpp OpenVINO builds.

## What Changes

- New **local engine mode** (`tlc.mode: remote | local`), switchable via a setting and a `TLC: Select Mode` command. In `local` mode TLC does not use `tlc.openai.baseUrl`; instead it downloads, manages and proxies to its own `llama-server` process which serves the same OpenAI-compatible `/v1/completions` API - the existing `CompletionsClient` is reused unchanged. The remote settings are grouped under the `tlc.openai.*` namespace (`baseUrl`, `model`, `apiKey`), with automatic migration from the legacy flat names.
- New **engine manager** that downloads the llama.cpp release zip matching the current platform (win/linux/darwin × x64/arm64; the OpenVINO variant on Windows x64 and Linux x64 where NPU/GPU devices are available), unpacks it into the engine directory, and reports progress via `vscode.window.withProgress` (download → unpack → ready).
- **Configurable local directories**: engine directory, model directory, and model cache directory (OpenVINO IR compilation cache) via settings; defaults live in extension global storage. Changing a directory migrates the existing content, and resolved paths are written to the TLC output channel.
- **Reset actions** (`TLC: Reset Local Engine…`): re-download the engine, re-download the model, or delete the model cache.
- New **model manager** that downloads one of the supported GGUF models (Qwen2.5-Coder 0.5B / 1.5B / 3B) with the same progress reporting, and lets the user switch between them (`TLC: Select Local Model`). A model change restarts the server.
- New **device selection** (`TLC: Select Local Device`): CPU (always), GPU or NPU when supported. On OpenVINO builds the device is passed to the server via the `GGML_OPENVINO_DEVICE` environment variable; NPU/GPU availability is detected from llama.cpp build variant plus a runtime probe.
- Status bar reflects the local engine state (downloading / starting / ready / error).
- In `local` mode the server model list, `/v1/models` polling and remote-model picker are bypassed; switching back to `remote` restores the current behavior.
- README and `package.json` setting descriptions updated (repo rule: keep docs in sync).

Note: the OpenVINO llama.cpp builds load GGUF models (OpenVINO is used as the inference backend; the device is chosen with `GGML_OPENVINO_DEVICE`). OpenVINO IR (`.xml`) models cannot be loaded by llama.cpp.

## Capabilities

### New Capabilities

- `local-engine-mode`: mode switcher — how `remote`/`local` is selected, what each mode uses, and how the rest of the extension behaves in each mode.
- `local-engine-setup`: acquiring the engine — platform-matched llama.cpp release download, GGUF model download, progress notification with progress bar, caching/skip-if-present, and cancelation.
- `local-engine-runtime`: running the engine — spawning/stopping `llama-server`, port allocation, device selection (CPU/GPU/NPU), model switching with server restart, and health reporting to the status bar/watchdog.

### Modified Capabilities

- (none — local is the default mode; users who explicitly chose remote keep their current behavior)

## Impact

- New modules: `src/local_engine/*` (mode config, release resolver, downloader, runner) — dependency-injected, no direct `vscode` imports, unit-testable per repo conventions.
- `src/extension.ts`: wiring, new commands (`tlc.selectMode`, `tlc.selectLocalModel`, `tlc.selectLocalDevice`), settings-change handling, lifecycle disposal (kill child process on deactivate).
- `package.json`: new settings (`tlc.mode`, `tlc.local.model`, `tlc.local.device`, `tlc.local.llamaCppRelease`, …) and command contributions.
- `src/completions_client.ts`, `completion_provider.ts`: unchanged; local mode only swaps the base URL and disables remote model-list polling.
- New downloads happen at runtime (GitHub releases + Hugging Face); network access and ~1–2 GB disk in global storage are required. No new npm dependencies required for download/unpack (Node `https` + unzip via bundled tool or `yauzl`-style dependency — decided in design).
