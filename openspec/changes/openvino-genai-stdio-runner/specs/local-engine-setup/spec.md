# Spec Delta

## MODIFIED Requirements

### Requirement: Platform-matched llama.cpp download
The extension SHALL resolve a llama.cpp GitHub release asset matching the current platform and architecture (Windows/Linux/macOS × x64/arm64; on Windows x64 and Linux x64 the OpenVINO variant is preferred so NPU/GPU devices are available; OpenVINO assets do not exist for arm64). The user SHALL be able to override the release tag via a setting; a sensible default pinned tag SHALL be used otherwise. For the `ovgenai` engine kind the engine binary SHALL NOT be downloaded (it ships inside the extension package); only the OpenVINO runtime library archive SHALL be downloaded, resolved per platform with a pinned version overridable via `tlc.local.openvinoUrl`.

#### Scenario: Windows x64
- **WHEN** setup runs on Windows x64 for the first time
- **THEN** the OpenVINO Windows x64 llama.cpp release zip is downloaded and unpacked into the extension's global storage

#### Scenario: Unsupported platform
- **WHEN** setup runs on a platform/architecture for which no known release asset exists
- **THEN** the user sees a non-blocking error naming the missing platform, completions stay in the "engine unavailable" state, and remote mode remains usable

#### Scenario: Already downloaded
- **WHEN** the engine for the pinned (or configured) release is already unpacked in global storage
- **THEN** no download happens and setup completes immediately

#### Scenario: GenAI kind skips engine download
- **WHEN** setup runs for the `ovgenai` kind
- **THEN** only the OpenVINO runtime archive is downloaded; the runner binary itself comes from the extension package

### Requirement: Model download with choice of size
The extension SHALL offer the Qwen2.5-Coder GGUF models 0.5B, 1.5B and 3B via `TLC: Select Local Model`, download the chosen model file into global storage if missing, and remember the choice in `tlc.local.model` (default 1.5B). For the `ovgenai` kind the catalog SHALL offer the same sizes as native IR models (`.xml` + `.bin` pairs, int4), downloaded as a pair with pair-existence validation, and `tlc.local.modelPath` SHALL accept a local IR `.xml` file as an offline alternative.

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
- **WHEN** `tlc.local.modelPath` points to an existing IR `.xml` file with its `.bin` alongside
- **THEN** the `ovgenai` runner starts with that model and no download happens
