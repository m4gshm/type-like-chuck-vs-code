# Design

## Context

TLC today is a thin client over an external OpenAI-compatible server: `CompletionsClient` (OpenAI SDK, streaming `/v1/completions`), `ModelConfig` (model list from `/v1/models`), `ConnectionWatchdog`, `CompletionProvider`, `StatusBar`. All core logic is dependency-injected and unit-testable without `vscode`; `extension.ts` is the only wiring point. Local mode must reuse that pipeline, adding: release resolution, download with progress, process management, and device selection. Target example release: `llama-b11935-bin-win-openvino-2026.4.1-x64.zip` (ggml-org/llama.cpp). Key constraint: llama.cpp OpenVINO builds load **GGUF** models; the device is selected with the `GGML_OPENVINO_DEVICE` env var (e.g. `NPU`, `GPU`, `CPU`), not with OpenVINO IR models.

## Goals / Non-Goals

**Goals:**
- One-click local mode: engine + model downloaded on demand with progress, then completions work with no external server.
- Reuse `CompletionsClient`/`CompletionProvider` unchanged; local mode is a different `baseUrl` plus lifecycle management.
- Host-interface pattern for all new logic (unit-testable with vitest, no `vscode` imports).
- Cross-platform release resolution with an explicit, overridable mapping; Windows-x64 OpenVINO variant preferred.

**Non-Goals:**
- OpenVINO IR (`.xml`) model support (llama.cpp cannot load them).
- Bundling llama.cpp inside the VSIX (size, licensing per-platform binaries).
- Chat/multi-turn, embeddings endpoints, non-Qwen local models.
- Auto-tuning context size / quantization choices beyond one curated GGUF per model size.

## Decisions

- **Local engine = `llama-server` (OpenAI-compatible), proxied through the existing client.**
  Alternative considered: driving `llama-cli` per request or embedding `llama.cpp` as a native module — rejected (process startup cost per completion; native module packaging/build matrix complexity). `llama-server` gives `/v1/completions` streaming, so zero client changes.

- **New modules under `src/local_engine/`, each behind a host interface:**
  - `release_assets.ts` — pure mapping `(platform, arch) → asset filename pattern`; returns the OpenVINO variant for `win32/x64` and `linux/x64` (ubuntu build, e.g. `llama-b11935-bin-ubuntu-openvino-*.tar.gz`) and standard builds otherwise (no OpenVINO asset exists for arm64). Unit-testable table.
  - `downloader.ts` — HTTPS download with byte-progress callback to a temp file + atomic rename; unzip via `yauzl` (new, small dependency; alternative `adm-zip` is simpler but loads whole archives in memory — models are ~1–2 GB zips, engine zips are smaller so either works; final pick in implementation).
  - `engine_manager.ts` — orchestrates: ensure engine → ensure model → start server; owns state (`not-installed | downloading | starting | ready | error`) exposed via a callback port.
  - `engine_runner.ts` — spawns `llama-server` (`--host 127.0.0.1 --port <free> -m <gguf> -c <ctx>`) plus a **random per-session API key** passed as `--api-key` and injected into the client's requests, and `GGML_OPENVINO_DEVICE` env for device selection; waits for `/health`, kills on dispose. Free port via `net.createServer({ port: 0 })` then close before spawn (small race, accepted). Rationale: llama-server has no Unix-socket/named-pipe transport and a loopback TCP socket is reachable by any local process, so a generated key is the practical "parent-only" isolation; the key is never persisted.
  - `model_catalog.ts` — static list: `qwen2.5-coder:0.5b|1.5b|3b → HuggingFace GGUF url + size`. Mirrors `model_selection.ts` style.

- **Mode is a setting (`tlc.mode`), commands write settings.**
- **First-run fallback**: at startup in remote mode an unreachable server triggers an offer to switch to the local engine; permanent dismissal persists in `context.globalState` (per-machine, not synced). All switching flows through the existing `onDidChangeConfiguration` handler in `extension.ts`, consistent with how `baseUrl`/template changes are handled. `TLC: Select Mode` just updates the setting.

- **Local server startup replaces remote polling, not the watchdog.** In local mode: `checkServerModels` polls the local endpoint (which doubles as readiness), the remote auto-picker/auto-apply is skipped, API key is not sent. The engine sets status through `StatusBar`/`CompletionState` ports already used by the watchdog.

- **Device selection**: setting `tlc.local.device: auto|cpu|gpu|npu` (default `auto`); `auto` prefers NPU → GPU → CPU on OpenVINO builds, plain CPU elsewhere. QuickPick lists only what the resolved engine variant supports. Unsupported selection → warn + fall back to cpu (spec scenario). When an accelerated device fails at engine start, the manager retries once on CPU with a warning; NPU presence is not probed deeply.

- **Release pinning**: default tag constant in `release_assets.ts` (e.g. `b11935`), override via `tlc.local.llamaCppRelease`. Engine stored under the engine directory in a per-tag subfolder, models under the model directory. Presence check = marker file written after successful unpack (protects against partial installs).
- **Engine kind**: `tlc.local.engineKind` (single value `llama.cpp` for now) names the engine precisely and prepares swappability for future kinds (OpenVINO GenAI, MLX — tracked in the `local-engine-openvino-genai` backlog change); the manager rejects unknown kinds before any download. User-facing strings say "llama.cpp"/"llama-server", not just "engine".
- **Directories**: `tlc.local.engineDir` / `tlc.local.modelDir` / `tlc.local.modelCacheDir`, all defaulting to `""` → resolved under `<globalStorage>/engine|models|ov-cache`. Resolution and migration live in `src/local_engine/paths.ts` (pure, unit-tested): empty → default; migration = rename old → new when the new path does not exist, otherwise keep the new content in place. Resolved paths are logged to the TLC output channel at activation and on change. The OpenVINO model cache is wired to the server via the `GGML_OPENVINO_CACHE_DIR` environment variable.
- **Reset**: one command (`TLC: Reset Local Engine…`) with a QuickPick (engine / model / model cache) — deletes the target and re-runs the normal ensure-and-start path, so progress reporting and fallback logic are reused.
- **Download sources are data, not constants**: base URLs (Hugging Face / GitHub) and per-model URLs are settings (mirrors, proxies, moved repos); a local GGUF path (`tlc.local.modelPath`) skips downloads entirely. Proxy support comes from standard `HTTPS_PROXY`/`HTTP_PROXY` environment variables honored by the downloader.

- **Progress**: all long work wrapped in `vscode.window.withProgress({ location: Notification, cancellable: true })` in `extension.ts` adapters; the core `downloader.ts`/`engine_manager.ts` only emit progress callbacks (keeps `vscode` out of the unit-tested code).

## Risks / Trade-offs

- [1–2 GB download on first local-mode use] → explicit progress + cancelation; remote mode untouched; skip when files present.
- [GitHub/HuggingFace URL rot] → tag overridable by setting; asset table is data, easy to patch; download failures are retryable.
- [Child process outlives the extension on crash] → kill on deactivate + orphan detection by port ownership at next start; document that a crashed VS Code may leave `llama-server` running until next start reuses/kills it.
- [Windows zip unpack of a running DLL set] → always stop the server before unpacking a new engine version.
- [NPU support varies by driver/OpenVINO version] → fallback-to-CPU retry; NPU marked "requires Intel NPU driver" in the picker detail.
- [Free-port race between check and spawn] → `llama-server` fails fast on a taken port; runner retries once with a new port.

## Migration Plan

Purely additive settings-wise: no settings are removed or renamed. `local` is now the default mode — a fresh install downloads the engine on first startup (users on machines without NPU/GPU or preferring an external server flip `tlc.mode` to `remote`). Rollback = ship without the commands/settings or flip the default back to `remote`.

## Open Questions

None blocking; exact default release tag, GGUF repo/quant per model size, and the unzip dependency are finalized at implementation start against current release listings.
