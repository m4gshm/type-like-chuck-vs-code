# Spec Delta

## Purpose

Lets the user choose between the external OpenAI-compatible server (remote mode) and the TLC-managed local engine (local mode), and governs how the rest of the extension behaves in each mode.

## ADDED Requirements

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
In local mode the extension SHALL send completion requests to the locally started engine's OpenAI-compatible endpoint, so prompt templates, single-line truncation, caching, and error handling behave identically to remote mode.

#### Scenario: Completion in local mode
- **WHEN** the local engine is running and the user types in an editor
- **THEN** a ghost-text completion is produced through the same FIM pipeline used in remote mode

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
