# Tasks

## 1. Foundations

- [x] 1.1 Add `src/local_engine/release_assets.ts` (platform/arch → llama.cpp release asset mapping, default tag, override support) and a unit test covering win32-x64 → OpenVINO asset, linux/darwin × x64/arm64, and unsupported combos (`npm run unit`)
- [x] 1.2 Add `src/local_engine/model_catalog.ts` with Qwen2.5-Coder 0.5B/1.5B/3B GGUF entries (url, size, context) and a unit test asserting catalog integrity
- [x] 1.3 Add `tlc.mode`, `tlc.local.model`, `tlc.local.device`, `tlc.local.llamaCppRelease` to `package.json` contributes (with descriptions) and to `src/config.ts` (`ExtensionConfig`); verify `npm run check-types` and that defaults keep current behavior

## 2. Downloading

- [x] 2.1 Add `src/local_engine/downloader.ts` (https download to temp file with byte-progress callback, atomic rename, cancelation) and unit tests with a local http server: progress events, cancel mid-stream, failure cleanup
- [x] 2.2 Add unzip/extraction (chosen zip library) with progress and marker-file write on success; unit test: zip unpacked, marker written, canceled install leaves no marker
- [x] 2.3 Wire progress callbacks to `vscode.window.withProgress` (Notification, cancellable) in extension-side adapter code; verify manually that engine and model downloads show percentage and byte counts and are cancellable

## 3. Running the engine

- [x] 3.1 Add `src/local_engine/engine_runner.ts`: spawn `llama-server` with model path, free port, context flag, random per-session API key (`--api-key`, exposed to the client), `GGML_OPENVINO_DEVICE` env for gpu/npu, `/health` readiness wait, kill on dispose, crash callback; unit tests with a stub process/command covering start-ready, kill, crash, and key generation per start
- [x] 3.2 Add `src/local_engine/engine_manager.ts`: state machine (not-installed → downloading → starting → ready → error), ensure-engine/ensure-model/start orchestration, model/device switch restart, unsupported-device fallback to CPU with warning; unit tests for each transition
- [x] 3.3 Map device setting to runner options per engine variant (OpenVINO → env var; generic → `-ngl` when listed); unit test the mapping table

## 4. Mode wiring in extension.ts

- [x] 4.1 Instantiate the engine manager in `extension.ts`; in local mode point `CompletionsClient`'s base URL at the local endpoint (port from manager) and set the per-session API key (remote stored keys are not sent); verify with the integration stub that completions flow unchanged (`npm run test`)
- [x] 4.2 Suppress remote behaviors in local mode: skip `/v1/models` auto-apply and remote polling, route the watchdog/probe at the local endpoint; unit/integration test that no remote request is made when `tlc.mode=local`
- [x] 4.3 Stop the engine on switch to remote mode and on deactivate (kill child process); verify process exit on window reload
- [x] 4.4 Restart engine on `tlc.local.model` / `tlc.local.device` setting changes; verify via unit test of the settings-change handling branch

## 5. Commands and UX

- [x] 5.1 Add `TLC: Select Mode` command (QuickPick remote/local, writes `tlc.mode`); verify setting updates and mode transition
- [x] 5.2 Add `TLC: Select Local Model` command (0.5B/1.5B/3B QuickPick with downloaded marks, downloads if missing, persists `tlc.local.model`); verify model switch restarts the engine
- [x] 5.3 Add `TLC: Select Local Device` command (cpu always; gpu/npu when the engine variant supports them, unsupported choice warns and falls back to cpu); verify picker contents per variant
- [x] 5.4 Surface engine state in `StatusBar` (downloading/starting/ready with model+device/error) via the manager's state port; verify unit tests for status transitions and that click still toggles completions

## 6. Docs and release

- [x] 6.1 Update `README.md` (local mode, commands, settings, platform/NPU notes, download sizes) keeping it consistent with `package.json`
- [x] 6.2 Run `npm run build` (test + lint) and fix any issues; smoke-test local mode end-to-end against the real downloaded engine if available, otherwise with the stub server

## 7. Directories and reset

- [x] 7.1 Add `tlc.local.engineDir` / `tlc.local.modelDir` / `tlc.local.modelCacheDir` settings (default `""`) to `package.json` and `config.ts`; add `src/local_engine/paths.ts` (resolve defaults under global storage, migrate on change: rename old→new when new is empty) with unit tests
- [x] 7.2 Log resolved engine/model/cache directories to the TLC output channel at activation and when a directory setting changes
- [x] 7.3 Pass the model cache directory to the runner (`GGML_OPENVINO_CACHE_DIR`) and unit-test the env mapping
- [x] 7.4 Add `TLC: Reset Local Engine…` command (QuickPick: re-download engine / re-download model / clear model cache) wired through the engine manager; unit tests for each reset path

## 8. First-run fallback offer

- [x] 8.1 At startup in remote mode, when the configured server is unreachable, offer to set up the local engine (accept → `tlc.mode=local` + download flow; "Don't Ask Again" persisted in globalState); verify via integration test or manual F5 run

## 9. Custom download sources and offline model

- [x] 9.1 Make base URLs overridable: `tlc.local.huggingfaceUrl` / `tlc.local.githubUrl` threaded through `model_catalog.ts` and `release_assets.ts`; unit tests for mirror URLs
- [x] 9.2 Add `tlc.local.modelUrls` (per-model full-URL override) and `tlc.local.modelPath` (local GGUF file, no download) with manager wiring and unit tests
- [x] 9.3 Honor `HTTPS_PROXY` / `HTTP_PROXY` in the downloader (undici `EnvHttpProxyAgent`); unit test that the proxy-aware fetch is used when the env var is set
- [x] 9.4 Update README and package.json descriptions for the new settings

