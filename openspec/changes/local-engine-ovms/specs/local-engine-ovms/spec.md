# Spec Delta

## Purpose

Adds a second local engine backed by OpenVINO Model Server (OVMS) as a standalone, Docker-free process. Covers delivery of official OVMS builds per platform, downloading the OV IR model, generating the OVMS mediapipe config, running the server on loopback, and the observable behavior users rely on for readiness, progress, device fallback, and debugging.

## ADDED Requirements

### Requirement: Platform capability probe and engine recommendation
The system SHALL detect whether the current CPU supports NPU (Intel Core Ultra class: NPU present via the OpenVINO NPU plugin / driver) before choosing the local engine. The resolution order SHALL be: (1) OVMS engine with NPU when NPU is available, (2) llama.cpp engine with GPU when NPU is absent or the OVMS/NPU path cannot start, (3) remote mode (OpenAI-compatible API via `tlc.openai.*`) when local acceleration is unavailable or local engines fail. TLC SHALL surface the chosen path and the reason (e.g. "NPU not detected → llama.cpp + GPU") to the user.

#### Scenario: Intel Core Ultra detected
- **WHEN** the platform probe finds an NPU (Intel Core Ultra CPU, NPU driver/plugin working)
- **THEN** TLC defaults to the ovms engine on NPU

#### Scenario: No NPU on the platform
- **WHEN** the probe does not detect an NPU (older Intel/AMD CPU, no driver)
- **THEN** TLC offers llama.cpp with GPU as the local path and explains why NPU was skipped

#### Scenario: No local acceleration usable
- **WHEN** neither NPU nor GPU is usable (no driver/hardware) or engine starts keep failing
- **THEN** TLC proposes switching to remote mode (`tlc.openai.*` settings) and keeps local mode available as an explicit opt-in
The system SHALL allow the user to select the local engine kind (`llama.cpp` or `ovms`) and persist the choice; TLC SHALL use the `openai.*` request path (same `/v1/completions` API surface) for the OVMS engine. Switching engine kind SHALL stop the currently running engine.

#### Scenario: Switch engine kind
- **WHEN** the user selects `ovms` in `TLC: Select Local Engine` while the llama.cpp engine is running
- **THEN** the llama-server process is stopped and the OVMS engine downloads its assets and starts

#### Scenario: Unknown engine kind persisted in settings
- **WHEN** a saved engine kind value is not a supported kind
- **THEN** TLC falls back to `llama.cpp` and logs a warning

### Requirement: OVMS build delivery
The system SHALL download the official standalone OVMS build from the OpenVINO Model Server GitHub Releases for the current platform: Windows x64 zip or Linux x64 tar.gz (Ubuntu 22 vs 24 variant chosen by glibc version) with the `python_off` variant, pinned by `tlc.local.ovmsVersion`; the download SHALL honor the existing mirror settings (`tlc.local.githubUrl`) and cache/order directories like the llama.cpp engine asset.

#### Scenario: First use on Windows
- **WHEN** the ovms engine starts and no build is cached under the engine directory
- **THEN** TLC downloads `ovms_windows_<version>_python_off.zip`, extracts it, and reuses the cache on subsequent starts

#### Scenario: Linux glibc variant
- **WHEN** the ovms engine starts on Linux x64 with glibc older than 2.39
- **THEN** the Ubuntu 22 tar.gz asset is downloaded; with glibc >= 2.39 the Ubuntu 24 asset is downloaded

#### Scenario: Unsupported platform
- **WHEN** the user selects the ovms engine on a platform/system without an official standalone build (e.g. macOS, Windows ARM)
- **THEN** TLC shows an error and does not start the engine

### Requirement: OV IR model download
The system SHALL download the Qwen2.5-Coder OV IR model files (`.xml` + `.bin`) for the selected model size into the models directory when the ovms engine is used, honoring `tlc.local.huggingfaceUrl` and per-model URL overrides, and SHALL reuse already-downloaded model files.

#### Scenario: Model files already present
- **WHEN** the OV IR model files for the selected size exist in the models directory
- **THEN** no new download is performed and the model starts directly

#### Scenario: Interrupted download
- **WHEN** a model download is interrupted and restarted
- **THEN** partially downloaded files are completed (resolved) without corrupting an existing complete model and without showing `0B` progress entries

### Requirement: OVMS server start
The system SHALL generate the OVMS mediapipe configuration JSON for the model (model files path, inference device, generation properties derived from TLC generation settings) and start the `ovms` process with the local REST port and the device property matching the selected device; server stdout/stderr SHALL be forwarded to the TLC output channel as `ovms: ...` lines.

#### Scenario: Ready state
- **WHEN** the OVMS server responds successfully on its readiness endpoint
- **THEN** TLC marks the engine ready and reports the endpoint and device in the standard local-engine readiness log line

#### Scenario: Server failure surfaces
- **WHEN** the OVMS process exits before becoming ready
- **THEN** TLC surfaces the failure like the llama.cpp engine (warning, device fallback or error) and llama.cpp-style retracing applies via the same engine-manager logic

### Requirement: llama.cpp engine drops OpenVINO-build specifics
The llama.cpp engine SHALL no longer depend on OpenVINO-specific behavior: the `GGML_OPENVINO_*` environment variables, the `tlc.local.npuCompileConfig` setting, the OpenVINO llama.cpp release asset, and the OpenVINO compiled-model/IR cache directory wiring SHALL be removed; NPU support now lives exclusively in the ovms engine. The llama.cpp engine SHALL use a standard build and run on CPU or GPU.

#### Scenario: llama.cpp start after the removal
- **WHEN** the llama.cpp engine starts
- **THEN** no `GGML_OPENVINO_*` variables are passed to the process and no OpenVINO cache directory is prepared

#### Scenario: Legacy settings leftover
- **WHEN** `tlc.local.npuCompileConfig` is present in a user's saved settings
- **THEN** it is ignored (and the setting disappears from the Settings UI)

### Requirement: Device fallback applies to the ovms engine
The system SHALL apply the same device preference chain (`auto`: NPU → GPU → CPU) for the ovms engine: an accelerated start failure SHALL be retried on the next device in the chain (NPU failure → GPU before CPU), with the device reported in the readiness line as for llama.cpp.

#### Scenario: NPU start fails on the ovms engine
- **WHEN** the ovms engine cannot start with device NPU
- **THEN** the retry uses GPU (when available) before CPU, and the device in the ready note reflects the successful one

### Requirement: Loopback and debugging parity
The system SHALL, as with the llama.cpp engine, keep the OVMS server reachable only from the local machine where OVMS supports such restriction, require the same per-session key (`tlc.local.apiKeyEnabled`) when supported by OVMS, and expose the ready log with `model=<model file>` so clients can be debugged with curl.

#### Scenario: Key disabled for curl debugging
- **WHEN** `tlc.local.apiKeyEnabled` is false with the ovms engine
- **THEN** the ready line shows `(none — key authentication disabled)` and curl on the REST endpoint works without a key header

#### Scenario: Key enabled
- **WHEN** `tlc.local.apiKeyEnabled` is true with the ovms engine
- **THEN** the ready line includes `key=...` and unauthenticated completion requests are rejected
