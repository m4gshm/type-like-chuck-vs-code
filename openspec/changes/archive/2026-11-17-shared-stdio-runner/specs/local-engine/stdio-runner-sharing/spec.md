# Spec Delta

## ADDED Requirements

### Requirement: Shared runner connect-or-spawn
When local mode starts a stdio engine (ovgenai, mlx) with sharing enabled (`tlc.local.sharedRunner`), the extension SHALL scan the runner discovery directory and connect to a runner whose recorded start options match its own effective options; only when no such runner is alive SHALL it spawn a new one in listen mode and record it. The match fields are engine-specific: for `ovgenai` — model path, device and context length (the NPU graph is compiled per context length, so different context lengths are different instances); for `mlx` — model path only (MLX compiles once and serves any context length). Distinct options therefore yield distinct coexisting runner instances, each with its own discovery file; identical options share one runner. Sharing is per stdio engine kind; HTTP engines (llama.cpp) are out of scope.

#### Scenario: Second window reuses the runner
- **WHEN** a second VS Code window enters local mode with the same model, device and context length while a matching shared runner is already alive
- **THEN** the extension connects to the existing runner and no second model load happens

#### Scenario: Mismatched context length does not share on ovgenai
- **WHEN** a second window uses the same model and device but a different context length than the running shared ovgenai runner
- **THEN** the second window spawns its own runner (its own NPU graph compilation) and both runners coexist, each with its own discovery file

#### Scenario: Context length does not split mlx runners
- **WHEN** a second window uses the same model with a different context length while a shared mlx runner is alive
- **THEN** the extension connects to the existing mlx runner instead of spawning a second model load

#### Scenario: Sharing disabled
- **WHEN** `tlc.local.sharedRunner` is set to `disabled`
- **THEN** each window spawns a private stdin/stdout runner as before

### Requirement: Runner discovery and transport selection
Shared runners SHALL be discovered through discovery files in the runner discovery directory (`<engineDir>/runners/`), one file per live runner, written by the spawning extension after the runner reports ready. A file records the runner PID, the transport (`pipe`, `socket` or `tcp`), the endpoint (pipe name / socket path / localhost port) and the start options used for matching. A starting window SHALL pick the file whose options match (see connect-or-spawn), validate it (see PID liveness), and connect over the recorded transport. TCP (`127.0.0.1:<port>`) SHALL be used when the plugin host and the runner process may live on different sides of a local IPC boundary (VS Code remote/WSL setups); otherwise the platform pipe/socket is used. Stale files (dead PID, failed connection) SHALL be ignored for matching and removed when encountered.

#### Scenario: Discovery file picked and validated
- **WHEN** a window starts and the discovery directory contains files for two runners with different context lengths
- **THEN** the window connects only to the runner whose options match its own, after the PID check passes

#### Scenario: Stale discovery file ignored and reaped
- **WHEN** the discovery directory contains a file whose PID belongs to no live process
- **THEN** the file is ignored for matching and deleted, and the window spawns its own runner

#### Scenario: TCP transport across a WSL boundary
- **WHEN** sharing is active in a VS Code remote/WSL setup where a named pipe cannot connect the two sides
- **THEN** the spawner starts the runner with a TCP listener on a random localhost port, records the port in the discovery file, and other windows connect over `127.0.0.1:<port>`

### Requirement: Runner liveness via PID
Before connecting, the extension SHALL check that a process with the remembered PID exists and identifies a TLC runner; a stale PID (dead process, reused PID of a different process, or unreachable endpoint) SHALL be treated as "no shared runner" and lead to spawning a new one.

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

### Requirement: Per-instance token authentication
Every shared runner SHALL require a per-instance random token: the spawner generates one, passes it to the runner at start and records it in the discovery file; a connecting client SHALL authenticate by sending an `auth` request with the token as the first message on its connection. The runner SHALL close the connection (or reject it) on a missing or wrong token without processing any request. The token SHALL NOT be persisted anywhere besides the discovery file and the runner's command line, and SHALL be regenerated on every spawn. Stdin/stdout (private pipe) mode SHALL NOT require authentication.

#### Scenario: Client authenticates with the token
- **WHEN** a window connects to a shared runner using the token from its discovery file
- **THEN** the runner accepts the `auth` request and serves generate requests normally

#### Scenario: Wrong or missing token rejected
- **WHEN** a local process connects and sends a generate request without a valid `auth` first
- **THEN** the runner rejects it with an `error` event and closes the connection

#### Scenario: Token rotates per spawn
- **WHEN** a shared runner is spawned
- **THEN** a new random token is generated and the previous token no longer authenticates

### Requirement: Transport selection setting
The extension SHALL let the user choose the shared-runner transport via `tlc.local.sharedRunnerTransport`: `pipe` (platform pipe/socket, the default), `tcp` (localhost TCP), or `auto` — pipe/socket first, with automatic fallback to TCP when the IPC transport cannot connect plugin and backend (VS Code remote/WSL setups). The chosen transport is recorded in the discovery file, and connecting windows use the transport recorded there rather than their own setting, so clients of one runner always agree on its transport.

#### Scenario: TCP selected explicitly
- **WHEN** `tlc.local.sharedRunnerTransport` is `tcp` and a window spawns a shared runner
- **THEN** the runner starts with a localhost TCP listener (random port) and the discovery file records `transport: tcp` with the port

#### Scenario: Clients follow the recorded transport
- **WHEN** a runner was spawned with the TCP transport and a second window connects to it
- **THEN** the second window connects over `127.0.0.1:<port>` from the discovery file even if its own setting is `pipe`

### Requirement: Status for a shared runner
The status bar and TLC output channel SHALL distinguish a connected shared runner from a privately spawned one (e.g. "ovgenai runner (shared, pid 1234)"), and log the endpoint and PID.

#### Scenario: Shared runner connected
- **WHEN** the extension connects to an existing shared runner that becomes ready
- **THEN** the status bar shows the ready state with a shared marker and the output channel logs the endpoint and PID
