# Spec Delta

## Purpose

Integrates the native OpenVINO GenAI runner (built by the backend repository
`m4gshm/type-like-chuck-backed-openvino`, which owns the NDJSON protocol and
inference contract) into the extension package: per-platform binary selection,
on-demand runtime library download, and stdio transport wiring. The runner's
own behavior spec lives in the backend repository.

## ADDED Requirements

### Requirement: Bundled per-platform runner binary
The extension package SHALL include a prebuilt runner binary for each supported platform variant (Windows x64, Linux x64), imported from the backend repository's `build/` directory locally or its GitHub release in CI (pinnable via `RUNNER_VERSION`). The extension SHALL select the binary matching the current platform and architecture; on an unsupported platform the `ovgenai` engine kind SHALL be reported as unavailable without starting anything.

#### Scenario: Windows x64 selection
- **WHEN** local mode starts with `tlc.local.engineKind` set to `ovgenai` on Windows x64
- **THEN** the bundled Windows x64 runner binary is used

#### Scenario: Unsupported platform
- **WHEN** the `ovgenai` kind is selected on a platform with no bundled binary
- **THEN** the extension reports an engine error naming the platform and does not download or start anything

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

### Requirement: Runner crash handling
The extension SHALL detect an unexpected runner process exit while local mode is active, surface a non-blocking error, and restart the runner on the next completion attempt.

#### Scenario: Runner crash
- **WHEN** the runner process exits unexpectedly while local mode is active
- **THEN** the extension surfaces a non-blocking error and restarts the runner on the next completion attempt
