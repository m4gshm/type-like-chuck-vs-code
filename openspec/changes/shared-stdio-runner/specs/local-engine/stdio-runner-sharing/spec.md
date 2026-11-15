# Spec Delta

## ADDED Requirements

### Requirement: Shared runner connect-or-spawn
When local mode starts a stdio engine (ovgenai, mlx) with sharing enabled (`tlc.local.sharedRunner`), the extension SHALL first try to connect to an existing shared runner for the same effective start options (model path, device, context length); only when no such runner is alive SHALL it spawn a new one in listen mode. Two windows with different effective start options SHALL NOT share a runner — each starts its own. Sharing is per stdio engine kind; HTTP engines (llama.cpp) are out of scope.

#### Scenario: Second window reuses the runner
- **WHEN** a second VS Code window enters local mode with the same model, device and context length while a shared runner is already alive
- **THEN** the extension connects to the existing runner and no second model load happens

#### Scenario: Mismatched options do not share
- **WHEN** a second window uses a different model or device than the running shared runner
- **THEN** the second window spawns its own runner with its own options instead of connecting

#### Scenario: Sharing disabled
- **WHEN** `tlc.local.sharedRunner` is set to `disabled`
- **THEN** each window spawns a private stdin/stdout runner as before

### Requirement: Runner liveness via PID
The extension SHALL persist the shared runner's PID and endpoint address where a connecting window can find them (a state file in the shared engine directory). Before connecting, the extension SHALL check that a process with the remembered PID exists and identifies a TLC runner; a stale PID (dead process, reused PID of a different process, or unreachable endpoint) SHALL be treated as "no shared runner" and lead to spawning a new one.

#### Scenario: Stale PID after a crash
- **WHEN** the extension starts and the remembered PID belongs to no live process
- **THEN** the extension treats the backend as gone and spawns a new shared runner

#### Scenario: PID reused by another process
- **WHEN** the remembered PID exists but the process is not a TLC runner, or the endpoint does not answer
- **THEN** the extension treats the backend as gone and spawns a new shared runner

### Requirement: Lost connection recovery
When the extension loses the connection to a shared runner while local mode is active (runner crash, kill, self-exit after the last client left), the extension SHALL detect the loss, report it like an unexpected engine exit, and start a new shared runner (spawn or connect) following the same connect-or-spawn rules; completions resume once the new runner is ready.

#### Scenario: Shared runner killed externally
- **WHEN** the shared runner process is killed while a window is connected
- **THEN** the window reports the engine failure and restarts a shared runner automatically

#### Scenario: New client races a dying runner
- **WHEN** a window tries to connect while the runner exits before the handshake completes
- **THEN** the connection attempt is treated as failed and the window spawns a new shared runner

### Requirement: Status for a shared runner
The status bar and TLC output channel SHALL distinguish a connected shared runner from a privately spawned one (e.g. "ovgenai runner (shared, pid 1234)"), and log the endpoint and PID.

#### Scenario: Shared runner connected
- **WHEN** the extension connects to an existing shared runner that becomes ready
- **THEN** the status bar shows the ready state with a shared marker and the output channel logs the endpoint and PID
