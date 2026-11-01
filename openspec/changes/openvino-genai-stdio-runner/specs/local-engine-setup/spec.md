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
The extension SHALL offer the Qwen2.5-Coder GGUF models 0.5B, 1.5B and 3B via `TLC: Select Local Model`, download the chosen model file into global storage if missing, and remember the choice in `tlc.local.model` (default 1.5B). For the `ovgenai` kind the catalog SHALL offer the same sizes as native IR models (`.xml` + `.bin` pairs, nf4 quantization from the m4gshm Hugging Face repos), downloaded as a pair with pair-existence validation, and `tlc.local.modelPath` SHALL accept a local IR `.xml` file as an offline alternative. The picker SHALL offer a "From disk…" entry (GGUF for llama.cpp, IR `.xml` for ovgenai) that sets `tlc.local.modelPath` and downloads nothing. When the resolved model is not a Qwen2.5-Coder catalog entry, the extension SHALL warn on engine start that the model was not validated for FIM completions; completions continue.

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

#### Scenario: Engine reset chooses the engine kind first
- **WHEN** the user runs `TLC: Reset Local Engine` → "Re-download engine"
- **THEN** a quick pick offers the engine kinds available on the platform (current marked) and the chosen kind is stored in `tlc.local.engineKind` before the download-or-folder question

#### Scenario: Model picked from disk
- **WHEN** the user picks the "From disk…" entry in `TLC: Select Local Model` and chooses a model file
- **THEN** `tlc.local.modelPath` is set to that file, no download starts, and the engine restarts with it; selecting a catalog model again clears the setting

#### Scenario: Non-Qwen2.5-Coder model selected
- **WHEN** the resolved model (catalog selection or `tlc.local.modelPath`) is not a Qwen2.5-Coder catalog entry
- **THEN** the engine starts and the user is warned that the model was not validated for FIM completions
