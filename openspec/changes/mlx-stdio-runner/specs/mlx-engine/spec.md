# Spec Delta

## Purpose

Integrates the native macOS MLX runner (built by the backend repository
`m4gshm/type-like-chuck-backed-mlx`, which owns the NDJSON protocol and
inference contract) into the extension as the `mlx` local engine kind:
platform availability guard, binary import, mlx model catalog format, and
stdio lifecycle. The runner's own behavior spec lives in the backend
repository.

## ADDED Requirements

### Requirement: macOS-only engine kind
The extension SHALL accept `tlc.local.engineKind: "mlx"` and SHALL report the kind as unavailable on any platform other than macOS arm64, without downloading or starting anything.

#### Scenario: Available on macOS arm64
- **WHEN** local mode starts with `tlc.local.engineKind` set to `mlx` on macOS arm64
- **THEN** the bundled runner binary is spawned and the engine reaches the ready state

#### Scenario: Unavailable elsewhere
- **WHEN** the `mlx` kind is selected on Windows, Linux, or Intel macOS
- **THEN** the extension reports an engine error naming the unsupported platform and does not start anything

### Requirement: Imported self-contained binary
The extension package SHALL include the macOS arm64 runner binary under `binaries/mlx/darwin-arm64/`, imported from the backend repository's `build/` directory locally or its GitHub release in CI (pinnable via `RUNNER_VERSION`). The `mlx` kind SHALL require no runtime library downloads.

#### Scenario: Package contains the binary
- **WHEN** the `.vsix` is built
- **THEN** it includes `binaries/mlx/darwin-arm64/tlc-mlx-runner` and the packaged binary starts (emits an `error` event when run without arguments)

#### Scenario: No runtime download
- **WHEN** the `mlx` engine starts for the first time
- **THEN** no runtime archive is downloaded and the runner starts immediately

### Requirement: mlx model catalog
The model catalog SHALL support the `mlx` model format — a model directory containing `config.json`, safetensors weights, and tokenizer files (e.g. `mlx-community/Qwen2.5-Coder-*-4bit`) — downloaded with the existing multi-file download machinery and progress/cancel semantics. The model picker SHALL offer mlx entries only for the `mlx` kind.

#### Scenario: Catalog entries per kind
- **WHEN** the model picker is shown while the `mlx` engine is active
- **THEN** only mlx-format entries are offered, with downloaded marks

#### Scenario: Model directory download
- **WHEN** an mlx model entry is selected for download
- **THEN** the model directory files are downloaded into the engine directory and the model is usable offline

### Requirement: Stdio lifecycle
The `mlx` kind SHALL use the same stdio child-process lifecycle as `ovgenai`: readiness handshake, request serialization, crash detection with a non-blocking error, and restart on the next completion attempt.

#### Scenario: Crash and restart
- **WHEN** the runner process exits unexpectedly while local mode is active
- **THEN** the extension surfaces a non-blocking error and restarts the runner on the next completion attempt
