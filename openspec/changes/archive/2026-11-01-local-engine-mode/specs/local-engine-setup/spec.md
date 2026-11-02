# Spec Delta

## Purpose

Acquires the local engine on demand: downloads the llama.cpp build matching the current platform and the selected GGUF model, with visible progress and without re-downloading what is already present.

## ADDED Requirements

### Requirement: Platform-matched llama.cpp download
The extension SHALL resolve a llama.cpp GitHub release asset matching the current platform and architecture (Windows/Linux/macOS × x64/arm64; on Windows x64 and Linux x64 the OpenVINO variant is preferred so NPU/GPU devices are available; OpenVINO assets do not exist for arm64). The user SHALL be able to override the release tag via a setting; a sensible default pinned tag SHALL be used otherwise.

#### Scenario: Windows x64
- **WHEN** setup runs on Windows x64 for the first time
- **THEN** the OpenVINO Windows x64 llama.cpp release zip is downloaded and unpacked into the extension's global storage

#### Scenario: Unsupported platform
- **WHEN** setup runs on a platform/architecture for which no known release asset exists
- **THEN** the user sees a non-blocking error naming the missing platform, completions stay in the "engine unavailable" state, and remote mode remains usable

#### Scenario: Already downloaded
- **WHEN** the engine for the pinned (or configured) release is already unpacked in global storage
- **THEN** no download happens and setup completes immediately

### Requirement: Model download with choice of size
The extension SHALL offer the Qwen2.5-Coder GGUF models 0.5B, 1.5B and 3B via `TLC: Select Local Model`, download the chosen model file into global storage if missing, and remember the choice in `tlc.local.model` (default 1.5B).

#### Scenario: First model download
- **WHEN** local mode is entered for the first time with no model present
- **THEN** the configured default model is downloaded automatically before the engine starts

#### Scenario: Switch model
- **WHEN** the user selects a different local model
- **THEN** the new model is downloaded if missing and the engine restarts with it; the previously downloaded model file is kept for reuse

### Requirement: Download progress notification
Every download (engine or model) SHALL show a VS Code progress notification with a determinate progress bar, byte counts, and the current stage (download, unpack/verify). The user SHALL be able to cancel, which leaves no partially-extracted engine in place and returns the engine to the "not installed" state.

#### Scenario: Progress shown during model download
- **WHEN** a 1 GB model file is being downloaded
- **THEN** a progress notification shows increasing percentage and downloaded/total bytes until it completes

#### Scenario: Cancel download
- **WHEN** the user cancels the progress notification
- **THEN** the download is aborted, partial files are discarded, and local mode reports that the engine/model is not ready

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

### Requirement: Custom download sources and offline model
The download sources SHALL be overridable: `tlc.local.huggingfaceUrl` and `tlc.local.githubUrl` SHALL replace the base URLs of model and engine downloads (e.g. for mirrors), and `tlc.local.modelUrls` SHALL override the full URL per model id (for moved repositories). When a standard proxy environment variable (`HTTPS_PROXY` / `HTTP_PROXY`) is set, downloads SHALL go through it. The user SHALL be able to skip downloads entirely by providing a local GGUF file via `tlc.local.customModelPath`; the extension SHALL use that file as-is.

#### Scenario: Mirror endpoint
- **WHEN** the user sets `tlc.local.huggingfaceUrl` to an alternative endpoint
- **THEN** model downloads are fetched from that endpoint instead of huggingface.co

#### Scenario: Moved repository
- **WHEN** the user sets a `tlc.local.modelUrls` entry for the selected model
- **THEN** that exact URL is downloaded instead of the catalog entry

#### Scenario: Local model copy
- **WHEN** `tlc.local.customModelPath` points to an existing GGUF file
- **THEN** the engine starts with that file and no download happens

#### Scenario: Proxy environment
- **WHEN** `HTTPS_PROXY` is set in the environment
- **THEN** engine and model downloads go through the proxy

### Requirement: Download failure handling
If a download or unpack fails (network error, checksum mismatch, disk error), the extension SHALL report the failure non-intrusively, keep remote mode unaffected, and allow retry (including automatically on the next attempt to enter local mode).

#### Scenario: Network failure mid-download
- **WHEN** the connection drops during model download
- **THEN** the user sees a warning with a Retry action and no corrupt model is started
