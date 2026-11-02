# local-engine Specification

## Purpose

Covers the TLC-managed local completion engine end to end: the user chooses
between the external OpenAI-compatible server (remote mode) and the local
engine (local mode, the default); local mode acquires an engine runtime and a
model on demand, runs the engine as a managed child process, routes
completions through the same FIM pipeline as remote mode, and reports the
lifecycle in the UI. Three engine kinds are supported: `llama.cpp` (a
downloaded llama-server speaking HTTP, GGUF models), `ovgenai` (the bundled
OpenVINO GenAI stdio runner built by the backend repository
`m4gshm/type-like-chuck-backed-openvino`, native IR models, OpenVINO runtime
libraries downloaded on demand) and `mlx` (the bundled macOS MLX stdio runner
built by `m4gshm/type-like-chuck-backed-mlx`, mlx-community 4-bit models, no
downloads beyond the model). The stdio runners' own behavior specs live in
their backend repositories.

## Requirements

### Requirement: Mode selection
The extension SHALL support two completion modes selected by the `tlc.mode` setting (`remote` or `local`) and via a `TLC: Select Mode` command showing a QuickPick. The default SHALL be `local`: a fresh install prepares the local engine (download with progress) on first startup. `remote` is an explicit opt-in for users with an external OpenAI-compatible server.

#### Scenario: Default is local
- **WHEN** the extension activates with no `tlc.mode` setting
- **THEN** the extension prepares the local engine (downloads the engine and model with progress reporting) instead of contacting `tlc.openai.baseUrl`

#### Scenario: Switch to local mode
- **WHEN** the user selects "Local engine" in the `TLC: Select Mode` QuickPick
- **THEN** `tlc.mode` is set to `local` and the extension prepares the local engine instead of contacting `tlc.openai.baseUrl`

#### Scenario: Switch back to remote mode
- **WHEN** the user selects "Remote server" after using local mode
- **THEN** the local server process is stopped and completions resume against `tlc.openai.baseUrl` with the previously configured remote model

### Requirement: Local mode uses the same completion client
In local mode the extension SHALL send completion requests to the locally started engine's OpenAI-compatible endpoint, so prompt templates, single-line truncation, caching, and error handling behave identically to remote mode. For the `ovgenai` engine kind, which has no HTTP endpoint, the extension SHALL route the same rendered FIM prompts through the runner's stdio transport and apply the identical post-processing (stop-token cut, single-line truncation, loop detection) to the streamed tokens, so completions are indistinguishable between engine kinds.

#### Scenario: Completion in local mode
- **WHEN** the local engine is running and the user types in an editor
- **THEN** a ghost-text completion is produced through the same FIM pipeline used in remote mode

#### Scenario: Completion via the stdio runner
- **WHEN** local mode runs the `ovgenai` engine and the user types in an editor
- **THEN** the rendered FIM prompt is sent as a request on the runner's stdin and the streamed tokens are assembled into the same single-line ghost-text suggestion as with the HTTP engines

### Requirement: First-run fallback offer
When the extension starts in remote mode and the configured server is unreachable, the extension SHALL offer to set up the local engine (download llama.cpp and the model and switch to local mode). Accepting SHALL switch `tlc.mode` to `local` and start the normal local-engine setup; "Don't Ask Again" SHALL suppress the offer permanently; "Not Now" SHALL keep asking on the next startup. No offer SHALL be shown when local mode is already active or the user has dismissed it permanently.

#### Scenario: Server unreachable at startup
- **WHEN** the extension starts in remote mode and the configured server does not respond
- **THEN** a notification offers to set up the built-in local engine

#### Scenario: Offer accepted
- **WHEN** the user accepts the offer
- **THEN** the mode switches to `local` and the engine/model download starts with the usual progress reporting

#### Scenario: Offer suppressed
- **WHEN** the user chose "Don't Ask Again" earlier
- **THEN** the startup offer is not shown again; the user can still switch modes manually

### Requirement: Remote-only features suspended in local mode
In local mode the extension SHALL NOT poll or apply the remote `/v1/models` list (auto model pick, model polling) and SHALL NOT send the stored API key; in remote mode none of the local-engine machinery (download, spawn) SHALL run.

#### Scenario: No remote polling in local mode
- **WHEN** `tlc.mode` is `local` and the model-list poll interval elapses
- **THEN** no request is made to `tlc.openai.baseUrl`

#### Scenario: Template follows local model
- **WHEN** the local model is Qwen2.5-Coder
- **THEN** the FIM template is the qwen2 built-in (unless the user chose `custom`), matching remote-mode behavior

### Requirement: First-run engine recommendation
On the first local-mode entry (before `tlc.local.engineKind` or `tlc.local.device` is touched) the extension SHALL probe the platform, CPU vendor and NPU hardware and recommend an engine kind and device: Windows/Linux Intel x64 with an Intel NPU (generation 4 or later) → `ovgenai` with NPU; Windows/Linux Intel x64 with an older NPU or none → `ovgenai` with `auto` (GPU→CPU resolved at start); Linux arm64 with an Intel CPU → `ovgenai` with `auto`; macOS arm64 → `mlx`; macOS x64 and other supported platforms → llama.cpp with `auto`; unsupported → remote. The user SHALL be able to accept (applying engineKind and device to settings) or dismiss the recommendation; a dismissal is remembered permanently. GPU presence is not probed at extension level — the engine's start-fallback chain resolves GPU→CPU.

#### Scenario: Intel NPU detected
- **WHEN** the first-run recommendation runs on Windows/Linux Intel x64 with an Intel NPU of generation 4 or later present
- **THEN** the recommendation is `ovgenai` with NPU, and accepting it applies both engineKind and device

#### Scenario: Intel without NPU
- **WHEN** the first-run recommendation runs on Windows/Linux Intel x64 without an NPU
- **THEN** the recommendation is `ovgenai` with `auto` (the runner resolves GPU→CPU at start)

#### Scenario: Older Intel NPU
- **WHEN** the first-run recommendation runs on Windows/Linux Intel x64 with an Intel NPU older than generation 4 (Core Ultra 100 class)
- **THEN** the recommendation is `ovgenai` with `auto` (GPU→CPU), the NPU is not offered as the priority device

#### Scenario: macOS arm64
- **WHEN** the first-run recommendation runs on macOS arm64
- **THEN** the recommendation is `mlx`

#### Scenario: Non-Intel platform
- **WHEN** the first-run recommendation runs on Windows/Linux AMD x64 (or any other non-Intel platform)
- **THEN** the recommendation is llama.cpp with `auto`

#### Scenario: Recommendation accepted
- **WHEN** the user accepts the recommendation
- **THEN** `tlc.local.engineKind` and `tlc.local.device` are updated to the recommended values and the engine starts with them

#### Scenario: Recommendation dismissed
- **WHEN** the user dismisses the recommendation
- **THEN** no settings change and the notification is not shown again

### Requirement: Engine kind selection
The local engine kind SHALL be selectable via `tlc.local.engineKind` (`llama.cpp`, `ovgenai` or `mlx`); an unknown kind SHALL be reported as an engine error without downloading anything. While the setting has never been set explicitly, the effective default SHALL follow the platform capability matrix: `mlx` on macOS arm64, `ovgenai` on Windows/Linux x64 with an Intel CPU, and `llama.cpp` elsewhere. User-facing messages SHALL name the engine precisely (e.g. "llama.cpp", "OpenVINO GenAI", "MLX"), keeping "local engine" as the generic term. Selecting a kind on a platform without its bundled runner binary SHALL report the engine as unavailable for the platform.

#### Scenario: Unknown engine kind
- **WHEN** `tlc.local.engineKind` is set to a value the extension does not implement
- **THEN** local mode reports an engine error and no downloads start

#### Scenario: OpenVINO GenAI kind selected
- **WHEN** `tlc.local.engineKind` is set to `ovgenai` on Windows x64 or Linux x64
- **THEN** the local engine runs as the bundled OpenVINO GenAI stdio runner with a native IR model

#### Scenario: Fresh install on macOS arm64
- **WHEN** local mode starts on macOS arm64 with `tlc.local.engineKind` never set explicitly
- **THEN** the effective engine kind is `mlx`

#### Scenario: Fresh install on an Intel machine
- **WHEN** local mode starts on Windows or Linux x64 with an Intel CPU and `tlc.local.engineKind` never set explicitly
- **THEN** the effective engine kind is `ovgenai`

### Requirement: Platform-matched llama.cpp download
The extension SHALL resolve a llama.cpp GitHub release asset matching the current platform and architecture (Windows/Linux/macOS × x64/arm64; Windows and Linux use the vulkan build with Vulkan GPU support, macOS uses the CPU build). The user SHALL be able to override the release tag via a setting; a sensible default pinned tag SHALL be used otherwise. For the `ovgenai` engine kind the engine binary SHALL NOT be downloaded (it ships inside the extension package); only the OpenVINO runtime library archive SHALL be downloaded, resolved per platform with a pinned version overridable via `tlc.local.openvinoUrl`.

#### Scenario: Windows x64
- **WHEN** setup runs on Windows x64 for the first time
- **THEN** the Windows x64 llama.cpp vulkan release zip is downloaded and unpacked into the extension's global storage

#### Scenario: Unsupported platform
- **WHEN** setup runs on a platform/architecture for which no known release asset exists
- **THEN** the user sees a non-blocking error naming the missing platform, completions stay in the "engine unavailable" state, and remote mode remains usable

#### Scenario: Already downloaded
- **WHEN** the engine for the pinned (or configured) release is already unpacked in global storage
- **THEN** no download happens and setup completes immediately

#### Scenario: GenAI kind skips engine download
- **WHEN** setup runs for the `ovgenai` kind
- **THEN** only the OpenVINO runtime archive is downloaded; the runner binary itself comes from the extension package

### Requirement: Bundled ovgenai runner binary
The extension package SHALL include a prebuilt runner binary for each supported platform variant (Windows x64, Linux x64), imported from the backend repository's `build/` directory locally or its GitHub release in CI (pinnable via `RUNNER_VERSION`). The extension SHALL select the binary matching the current platform and architecture; on an unsupported platform the `ovgenai` engine kind SHALL be reported as unavailable without starting anything.

#### Scenario: Windows x64 selection
- **WHEN** local mode starts with `tlc.local.engineKind` set to `ovgenai` on Windows x64
- **THEN** the bundled Windows x64 runner binary is used

#### Scenario: Unsupported platform
- **WHEN** the `ovgenai` kind is selected on a platform with no bundled binary
- **THEN** the extension reports an engine error naming the platform and does not download or start anything

### Requirement: Bundled mlx runner binary
The extension package SHALL include the macOS arm64 runner binary under `binaries/mlx/darwin-arm64/`, imported from the backend repository's `build/` directory locally or its GitHub release in CI (pinnable via `RUNNER_VERSION`). The `mlx` kind SHALL require no runtime library downloads and SHALL be reported as unavailable on any platform other than macOS arm64, without downloading or starting anything.

#### Scenario: Package contains the binary
- **WHEN** the `.vsix` is built
- **THEN** it includes `binaries/mlx/darwin-arm64/tlc-mlx-runner` and the packaged binary starts (emits an `error` event when run without arguments)

#### Scenario: No runtime download
- **WHEN** the `mlx` engine starts for the first time
- **THEN** no runtime archive is downloaded and the runner starts immediately

#### Scenario: Unavailable elsewhere
- **WHEN** the `mlx` kind is selected on Windows, Linux, or Intel macOS
- **THEN** the extension reports an engine error naming the unsupported platform and does not start anything

### Requirement: OpenVINO runtime library acquisition
The OpenVINO Runtime/GenAI shared libraries SHALL NOT be part of the extension package; they SHALL be downloaded on first use into the engine directory (honoring `tlc.local.engineDir` and the dedicated `tlc.local.openvinoUrl` overrides, proxy environment, and the same progress/cancel semantics as other engine downloads) and reused from disk afterwards. The extension SHALL put the library directory on the runner's platform library path (`PATH` on Windows, `LD_LIBRARY_PATH` on Linux) before spawning. Before the first download, when no runtime is present and `tlc.local.distroDir` is unset, the extension SHALL offer a choice between downloading and picking an existing unpacked distribution folder (saved to `tlc.local.distroDir`); dismissing the choice cancels the preparation without a partial download.

#### Scenario: First run downloads runtime
- **WHEN** the `ovgenai` engine starts for the first time and the user picks "Download"
- **THEN** the OpenVINO runtime archive for the platform is downloaded with a progress notification, unpacked into the engine directory, and the runner starts against it

#### Scenario: First run uses an existing distribution folder
- **WHEN** the `ovgenai` engine starts for the first time and the user picks an unpacked runtime folder
- **THEN** no download happens, the folder is stored in `tlc.local.distroDir`, and the runner starts against it

#### Scenario: Distro question dismissed
- **WHEN** the runtime is missing and the user dismisses the download-or-folder question
- **THEN** the preparation is canceled silently (same semantics as a canceled download) and no partial state is left

#### Scenario: Runtime already present
- **WHEN** the runtime library directory already contains the pinned version
- **THEN** no question and no download happen and the runner starts immediately

### Requirement: Local distribution folder
The user SHALL be able to point the extension at a locally unpacked engine distribution via `tlc.local.distroDir` (empty by default). For the `ovgenai` kind the folder is an OpenVINO GenAI runtime archive directory; for llama.cpp it is an unpacked llama.cpp build. When set, the engine/runtime download for that kind SHALL be skipped and the folder used in place; the resolved path SHALL be written to the TLC output channel. A folder that does not match the expected layout SHALL fail engine start with a non-blocking error naming the missing layout; clearing the setting restores the standard download path. Before the first engine/runtime download, when the distribution is missing on disk and `tlc.local.distroDir` is unset, the extension SHALL offer a choice between downloading and picking an existing unpacked distribution folder (saved to `tlc.local.distroDir`); dismissing the choice cancels the preparation without a partial download.

#### Scenario: Local distribution folder used
- **WHEN** `tlc.local.distroDir` is set and local mode starts with the matching engine kind
- **THEN** no engine/runtime download happens and the engine starts from the folder in place

#### Scenario: Local distribution folder mismatched
- **WHEN** `tlc.local.distroDir` is set but the folder does not contain the expected engine layout
- **THEN** engine start fails with a non-blocking error naming the missing layout

#### Scenario: Distribution question dismissed
- **WHEN** the engine/runtime distribution is missing and the user dismisses the download-or-folder question
- **THEN** the preparation is canceled silently (same semantics as a canceled download) and no partial state is left

### Requirement: Model catalog and download
The extension SHALL offer per-kind model catalogs via `TLC: Select Local Model`, download the chosen model into global storage if missing, and remember the choice in `tlc.local.model` (default 1.5B): Qwen2.5-Coder GGUF files 0.5B/1.5B/3B for `llama.cpp`; the same sizes as native OpenVINO IR models (`.xml` + `.bin` pairs, nf4 quantization from the m4gshm Hugging Face repos) downloaded as a pair with pair-existence validation for `ovgenai`; mlx-community 4-bit model directories (`config.json`, safetensors weights, tokenizer files) downloaded with the multi-file machinery for `mlx`. The picker SHALL offer entries only for the active engine kind, with downloaded marks, plus a "From disk…" entry that sets `tlc.local.customModelPath` (a GGUF file for llama.cpp, an IR model directory for ovgenai, an mlx model directory for mlx) with `tlc.local.model` set to `custom` and downloads nothing; selecting a catalog model again clears the setting. When the resolved model is a `custom` path whose model family cannot be matched to a built-in FIM template, the extension SHALL warn on engine start that the model was not validated for FIM completions; completions continue.

#### Scenario: First model download
- **WHEN** local mode is entered for the first time with no model present
- **THEN** the configured default model is downloaded automatically before the engine starts

#### Scenario: Switch model
- **WHEN** the user selects a different local model
- **THEN** the new model is downloaded if missing and the engine restarts with it; the previously downloaded model file is kept for reuse

#### Scenario: IR pair download
- **WHEN** the `ovgenai` kind downloads a model
- **THEN** both the `.xml` and `.bin` files are fetched and verified present before the model counts as installed

#### Scenario: Offline IR model
- **WHEN** `tlc.local.customModelPath` points to an existing IR model directory containing the `.xml`/`.bin` pairs
- **THEN** the `ovgenai` runner starts with that model and no download happens

#### Scenario: Catalog entries per kind
- **WHEN** the model picker is shown while the `mlx` engine is active
- **THEN** only mlx-format entries are offered, with downloaded marks

#### Scenario: Model directory download
- **WHEN** an mlx model entry is selected for download
- **THEN** the model directory files are downloaded into the engine directory and the model is usable offline

#### Scenario: Model picked from disk
- **WHEN** the user picks the "From disk…" entry in `TLC: Select Local Model` and chooses a model
- **THEN** `tlc.local.customModelPath` is set to it, no download starts, and the engine restarts with it

#### Scenario: Non-Qwen2.5-Coder model selected
- **WHEN** the resolved model (`tlc.local.customModelPath`) names no supported model family
- **THEN** the engine starts and the user is warned that the model was not validated for FIM completions

### Requirement: Download progress notification
Every download (engine or model) SHALL show a cancellable progress notification with the current stage (downloading the engine / downloading the model / starting the engine) and, once bytes flow, downloaded and total byte counts. The user SHALL be able to cancel, which leaves no partially-extracted engine in place and returns the engine to the "not installed" state.

#### Scenario: Progress shown during model download
- **WHEN** a 1 GB model file is being downloaded
- **THEN** a progress notification shows the stage and increasing downloaded/total byte counts until it completes

#### Scenario: Cancel download
- **WHEN** the user cancels the progress notification
- **THEN** the download is aborted, partial files are discarded, and local mode reports that the engine/model is not ready

### Requirement: Download failure handling
If a download or unpack fails (network error, checksum mismatch, disk error), the extension SHALL report the failure non-intrusively, keep remote mode unaffected, and allow retry (including automatically on the next attempt to enter local mode).

#### Scenario: Network failure mid-download
- **WHEN** the connection drops during model download
- **THEN** the user sees a warning with a Retry action and no corrupt model is started

### Requirement: Custom download sources and offline model
The download sources SHALL be overridable: `tlc.local.huggingfaceUrl` and `tlc.local.githubUrl` SHALL replace the base URLs of model and engine downloads (e.g. for mirrors), and `tlc.local.modelDownloadUrls` SHALL override the full URL per model id (for moved repositories): a bare model id key applies to the llama.cpp GGUF download, per-file keys (`model id/file`) to the individual ovgenai IR and mlx model files, so entries do not collide across engine kinds. When a standard proxy environment variable (`HTTPS_PROXY` / `HTTP_PROXY`) is set, downloads SHALL go through it. The user SHALL be able to skip downloads entirely by providing a local GGUF file via `tlc.local.customModelPath`; the extension SHALL use that file as-is.

#### Scenario: Mirror endpoint
- **WHEN** the user sets `tlc.local.huggingfaceUrl` to an alternative endpoint
- **THEN** model downloads are fetched from that endpoint instead of huggingface.co

#### Scenario: Moved repository
- **WHEN** the user sets a `tlc.local.modelDownloadUrls` entry for the selected model
- **THEN** that exact URL is downloaded instead of the catalog entry

#### Scenario: Local model copy
- **WHEN** `tlc.local.customModelPath` points to an existing GGUF file
- **THEN** the engine starts with that file and no download happens

#### Scenario: Proxy environment
- **WHEN** `HTTPS_PROXY` is set in the environment
- **THEN** engine and model downloads go through the proxy

### Requirement: Configurable local directories
The engine directory, model directory, and model cache directory SHALL be configurable via settings (`tlc.local.engineDir`, `tlc.local.downloadedModelsDir`, `tlc.local.modelCacheDir`); an empty value SHALL resolve to a default location inside the extension's global storage. The resolved directories SHALL be written to the TLC output channel. When a directory setting changes, the existing content SHALL be moved to the new location (if the new location is empty) so nothing is re-downloaded unnecessarily.

#### Scenario: Custom model directory
- **WHEN** the user sets `tlc.local.downloadedModelsDir` to a folder on another drive
- **THEN** the previously downloaded model file is moved there, the output channel logs the new path, and no re-download happens

#### Scenario: New location already populated
- **WHEN** the user points a directory setting at an existing non-empty folder
- **THEN** the engine uses the content in place and the old location is left untouched

### Requirement: Reset actions
A `TLC: Reset Local Engine…` command SHALL let the user re-download the engine, re-download the selected model, or delete the model cache. Each action removes the corresponding content, reports progress like the initial download, and restarts the engine when it was running.

#### Scenario: Re-download the engine
- **WHEN** the user chooses to reset the engine
- **THEN** the engine directory is deleted and the release is downloaded and unpacked again before the server restarts

#### Scenario: Clear the model cache
- **WHEN** the user chooses to clear the model cache
- **THEN** the model cache directory is emptied and the engine (if running) is restarted so the cache is rebuilt

#### Scenario: Engine reset chooses the engine kind first
- **WHEN** the user runs `TLC: Reset Local Engine` → "Re-download engine"
- **THEN** a quick pick offers the engine kinds available on the platform (current marked) and the chosen kind is stored in `tlc.local.engineKind` before the download-or-folder question

### Requirement: Engine process lifecycle
The extension SHALL run the local engine as a managed child process and terminate it when the extension deactivates or the mode switches to remote. HTTP-speaking engines (llama.cpp) start as a llama-server bound to a free localhost port, and the extension waits until the OpenAI-compatible endpoint responds. stdio engines (ovgenai, mlx) are spawned with the model path and are ready when they report readiness on stdout; the stdio runner SHALL NOT open any network port and SHALL NOT require an API key (its stdin/stdout pipes are private to the extension).

#### Scenario: Start and become ready
- **WHEN** local mode is entered with engine and model present
- **THEN** the engine process starts and completions become available once the engine is ready; the status bar shows the engine state (starting → ready)

#### Scenario: Shutdown
- **WHEN** VS Code closes or the window reloads
- **THEN** the engine process is terminated and does not keep the model loaded in memory

#### Scenario: Stdio runner starts without a port or key
- **WHEN** the `ovgenai` runner starts
- **THEN** it listens on no TCP port, no API key is generated or logged, and readiness is taken from the runner's stdout handshake

### Requirement: Crash detection and restart
The extension SHALL detect an unexpected engine process exit (llama-server or a stdio runner) while local mode is active, surface a non-blocking error, and restart the engine automatically. An engine that keeps crashing SHALL stop being restarted automatically: after more than three crashes within a minute the extension reports an engine error and waits for a manual restart via `TLC: Reset Local Engine`.

#### Scenario: Engine crash
- **WHEN** the engine process exits unexpectedly while local mode is active
- **THEN** the user sees a non-blocking error, the status bar shows the failure, and the engine restarts automatically

#### Scenario: Crash loop
- **WHEN** the engine process crashes more than three times within a minute
- **THEN** the automatic restart stops and the engine error tells the user to restart manually via `TLC: Reset Local Engine`

### Requirement: Device selection
The extension SHALL let the user choose the inference device via `TLC: Select Local Device` and the `tlc.local.device` setting: `auto` (default), CPU, GPU or NPU. `auto` SHALL start from GPU and fall back to CPU for both downloading kinds, except the `ovgenai` kind on a platform with an Intel NPU generation 4 or later, where `auto` SHALL start on the NPU and fall back GPU→CPU with the NPU context cap and the nf4 model format applied from the first chain hop. For the `llama.cpp` vulkan build the device chain is GPU→CPU; a selected NPU SHALL be warned about and resolved to GPU (the NPU is supported only by the OpenVINO GenAI runner). For the `ovgenai` kind an explicitly selected device SHALL be passed to the runner at spawn as the OpenVINO GenAI device string mapped from the same setting, with the chain NPU→GPU→CPU for NPU. The `mlx` kind always runs on the Metal GPU: the device setting is not applied to it and `TLC: Select Local Device` offers only GPU. When a device fails at engine start, the engine SHALL retry on the next device of its chain and warn; a canceled start SHALL NOT trigger the fallback chain.

#### Scenario: Default device
- **WHEN** local mode starts with no `tlc.local.device` setting
- **THEN** the engine starts from GPU and falls back to CPU (llama.cpp vulkan build, ovgenai without an NPU 4+, mlx ignored alike)

#### Scenario: Auto device on an NPU 4+ machine
- **WHEN** local mode starts with no `tlc.local.device` setting on a machine with an Intel NPU of generation 4 or later and the `ovgenai` kind
- **THEN** the engine starts on the NPU (nf4 model, NPU context cap) and falls back through GPU to CPU if the NPU start fails

#### Scenario: Accelerated device fails at start
- **WHEN** the engine fails to start with a selected or auto-picked accelerated device
- **THEN** the engine is retried on the next device of the chain with a warning and completions continue

#### Scenario: NPU on the GenAI runner
- **WHEN** the user selects NPU and the `ovgenai` runner runs on a machine with an Intel NPU
- **THEN** the runner is spawned with the NPU device string and the status bar shows the active device

#### Scenario: NPU unavailable
- **WHEN** the user selects NPU with the llama.cpp kind, or the ovgenai runner fails to start on the NPU
- **THEN** llama.cpp resolves to GPU with a warning; the ovgenai runner retries on GPU and then CPU, and completions continue

#### Scenario: GPU selection
- **WHEN** the user selects GPU
- **THEN** the llama.cpp vulkan build runs on GPU and the ovgenai runner is spawned with the GPU device string

#### Scenario: Device string for the GenAI runner
- **WHEN** the `ovgenai` runner starts with a device setting
- **THEN** the device is passed as the OpenVINO GenAI device string (CPU/GPU/NPU) and the status bar shows the active device

#### Scenario: MLX always Metal
- **WHEN** the `mlx` engine starts with any `tlc.local.device` setting
- **THEN** the runner runs on the Metal GPU and the device picker offered only GPU

### Requirement: Model and device changes restart the engine
Changing the local model or device SHALL stop the running engine (if any) and start it again with the new model/device; the choice is persisted in settings. This applies to all engine kinds, including restarting a stdio runner when the IR model or device changes.

#### Scenario: Device switch while running
- **WHEN** the user switches the device from CPU to NPU while the engine is running
- **THEN** the engine is restarted with the new device and the status bar reflects the transition

#### Scenario: IR model switch on the GenAI runner
- **WHEN** the user selects a different local model while the `ovgenai` runner is running
- **THEN** the runner is stopped and restarted with the new IR model path

### Requirement: Engine endpoint isolation
The local engine SHALL listen only on the loopback interface with a free port and SHALL require a randomly generated per-session API key (passed to the server at start and used by the extension in its requests) by default. The key SHALL NOT be persisted to settings or disk and SHALL change on every engine start; the resolved key SHALL be written to the TLC output channel for debugging. For direct engine debugging the key check SHALL be disableable via `tlc.local.apiKeyEnabled: false` (the server then accepts unauthenticated local requests). This requirement applies to HTTP-speaking engines (llama.cpp); the stdio runners (ovgenai, mlx) have no HTTP endpoint and are exempt — their isolation is the privacy of their stdio pipes.

#### Scenario: Request without the session key
- **WHEN** another local process sends a completion request to the engine's endpoint without the key
- **THEN** the server rejects it with an authentication error and no completion is produced

#### Scenario: Key visible for debugging
- **WHEN** the engine becomes ready
- **THEN** the TLC output channel logs the endpoint together with the current session key

#### Scenario: Key check disabled for debugging
- **WHEN** the user sets `tlc.local.apiKeyEnabled` to `false`
- **THEN** the engine starts without key authentication and unauthenticated curl requests to the endpoint succeed

#### Scenario: Key rotates on restart
- **WHEN** the engine is stopped and started again
- **THEN** a new random key is used and the old key no longer authenticates

### Requirement: Local engine status reporting
The status bar SHALL reflect the local engine lifecycle (downloading, starting, ready with model and device, error) and clicking it SHALL still toggle completions as in remote mode. The connection watchdog SHALL be fed by completion results and engine status transitions; the periodic remote model-list poll SHALL NOT run in local mode — engine health is the engine manager's responsibility.

#### Scenario: Status during startup
- **WHEN** the engine is downloading or starting
- **THEN** the status bar shows a busy state instead of the ready icon

#### Scenario: Watchdog in local mode
- **WHEN** local mode is active
- **THEN** the model-list poll is skipped and the watchdog is fed by completion results and engine status transitions
