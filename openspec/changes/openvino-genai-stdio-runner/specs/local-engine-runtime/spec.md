# Spec Delta

## MODIFIED Requirements

### Requirement: Engine kind selection
The local engine kind SHALL be selectable via `tlc.local.engineKind` (`llama.cpp` or `ovgenai`, default `llama.cpp`); an unknown kind SHALL be reported as an engine error without downloading anything. User-facing messages SHALL name the engine precisely (e.g. "llama.cpp", "OpenVINO GenAI"), keeping "local engine" as the generic term. Selecting `ovgenai` on a platform without a bundled runner binary SHALL report the engine as unavailable for the platform.

#### Scenario: Unknown engine kind
- **WHEN** `tlc.local.engineKind` is set to a value the extension does not implement
- **THEN** local mode reports an engine error and no downloads start

#### Scenario: OpenVINO GenAI kind selected
- **WHEN** `tlc.local.engineKind` is set to `ovgenai` on Windows x64 or Linux x64
- **THEN** the local engine runs as the bundled OpenVINO GenAI stdio runner with a native IR model

### Requirement: Engine process lifecycle
The extension SHALL start the downloaded llama.cpp server as a child process bound to a free localhost port, wait until its OpenAI-compatible endpoint responds, and terminate the process when the extension deactivates or the mode switches to remote. For the `ovgenai` engine kind the lifecycle SHALL instead be a private stdio child process: the extension spawns the bundled runner with the model path, treats the runner as ready when it reports readiness on stdout, and terminates the process on the same shutdown triggers. The stdio runner SHALL NOT open any network port and SHALL NOT require an API key (its stdin/stdout pipes are private to the extension).

#### Scenario: Start and become ready
- **WHEN** local mode is entered with engine and model present
- **THEN** the server process starts and completions become available once the endpoint answers; the status bar shows the engine state (starting → ready)

#### Scenario: Shutdown
- **WHEN** VS Code closes or the window reloads
- **THEN** the server process is terminated and does not keep the model loaded in memory

#### Scenario: Engine crash
- **WHEN** the server process exits unexpectedly while local mode is active
- **THEN** the user sees a non-blocking error, the status bar shows the failure, and TLC restarts the engine on the next completion attempt

#### Scenario: Stdio runner starts without a port or key
- **WHEN** the `ovgenai` runner starts
- **THEN** it listens on no TCP port, no API key is generated or logged, and readiness is taken from the runner's stdout handshake

### Requirement: Device selection
The extension SHALL let the user choose the inference device via `TLC: Select Local Device` and the `tlc.local.device` setting: `auto` (default), CPU, GPU or NPU. `auto` SHALL prefer the fastest supported device (NPU, then GPU, then CPU) for the resolved engine build. On OpenVINO builds the device SHALL be passed to the server via the `GGML_OPENVINO_DEVICE` environment variable; when a selected or auto-picked accelerated device fails at engine start, the engine SHALL retry once on CPU and warn. Selecting a device the build does not support SHALL fall back to CPU with a warning. For the `ovgenai` kind the device SHALL be passed to the runner at spawn (as the OpenVINO GenAI device string mapped from the same setting), with the same failure-retry chain and NPU context cap.

#### Scenario: Default device
- **WHEN** local mode starts with no `tlc.local.device` setting
- **THEN** the engine runs on the fastest device available for the build (NPU → GPU → CPU on OpenVINO builds, CPU otherwise)

#### Scenario: Accelerated device fails at start
- **WHEN** the engine fails to start with an NPU or GPU device
- **THEN** the engine is retried once on CPU, the user is warned, and completions continue

#### Scenario: NPU on OpenVINO build
- **WHEN** the user selects NPU and the engine is an OpenVINO build on a machine with an Intel NPU
- **THEN** the server runs with `GGML_OPENVINO_DEVICE=NPU` and the status bar shows the active device

#### Scenario: NPU unavailable
- **WHEN** the user selects NPU but the engine build or hardware does not support it
- **THEN** the engine falls back to CPU, the user is warned, and completions continue

#### Scenario: GPU selection
- **WHEN** the user selects GPU on an OpenVINO build
- **THEN** the server runs with `GGML_OPENVINO_DEVICE=GPU`

#### Scenario: Device string for the GenAI runner
- **WHEN** the `ovgenai` runner starts with a device setting
- **THEN** the device is passed as the OpenVINO GenAI device string (CPU/GPU/NPU) and the status bar shows the active device

### Requirement: Model and device changes restart the engine
Changing the local model or device SHALL stop the running server (if any) and start it again with the new model/device; the choice is persisted in settings. This applies to both engine kinds, including restarting the stdio runner when the IR model or device changes.

#### Scenario: Device switch while running
- **WHEN** the user switches the device from CPU to NPU while the engine is running
- **THEN** the server is restarted with the new device and the status bar reflects the transition

#### Scenario: IR model switch on the GenAI runner
- **WHEN** the user selects a different local model while the `ovgenai` runner is running
- **THEN** the runner is stopped and restarted with the new IR model path

### Requirement: Engine endpoint isolation
The local engine SHALL listen only on the loopback interface with a free port and SHALL require a randomly generated per-session API key (passed to the server at start and used by the extension in its requests) by default. The key SHALL NOT be persisted to settings or disk and SHALL change on every engine start; the resolved key SHALL be written to the TLC output channel for debugging. For direct engine debugging the key check SHALL be disableable via `tlc.local.apiKeyEnabled: false` (the server then accepts unauthenticated local requests). This requirement applies to HTTP-speaking engines (llama.cpp); the `ovgenai` stdio runner has no HTTP endpoint and is exempt — its isolation is the privacy of its stdio pipes.

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
The status bar SHALL reflect the local engine lifecycle (downloading, starting, ready with model and device, error) and clicking it SHALL still toggle completions as in remote mode.

#### Scenario: Status during startup
- **WHEN** the engine is downloading or starting
- **THEN** the status bar shows a busy state instead of the ready icon

#### Scenario: Connection watchdog in local mode
- **WHEN** the local server is ready
- **THEN** the connection watchdog probes the local endpoint and does not disable completions
