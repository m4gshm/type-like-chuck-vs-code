# Design

## Context

`src/local_engine/stdio_runner.ts` spawns the runner with `stdio: ['pipe','pipe','pipe']` and speaks NDJSON over stdin/stdout; `engine_manager.ts` owns the lifecycle. Token events carry no request id — the client routes them to the oldest pending request, which is only correct for a single client. The runner-side capabilities (listen mode, refcount, token ids, PID) are specified and implemented in the backend repos (`type-like-chuck-backed-openvino`, `type-like-chuck-backed-mlx`, change `shared-stdio-runner` in each); this repo ships the binaries and owns the client side.

## Goals / Non-Goals

**Goals:**
- One runner process per (model, device, context) tuple across VS Code windows.
- Window deactivation never kills a runner other windows still use.
- Graceful degradation: old runners keep working via private pipes.

**Non-Goals:**
- Sharing with non-VS-Code clients or remote machines (loopback-local IPC only).
- Concurrent generation inside the runner (it stays one generation at a time).
- Changing the NDJSON request/response schema beyond what multi-client routing needs.
- HTTP engines (llama.cpp) — llama-server already binds a TCP port; a different, later change if wanted.

## Decisions

### Transport and endpoint key: named pipe / unix socket keyed by start options
`\\.\pipe\tlc-runner-<key>` on Windows, `<engineDir>/runner-<key>.sock` on Linux/macOS, where `<key>` is a digest of the effective start options (runner path, model path, device, context length). No TCP port, no auth surface, fits the "no network port" invariant. The key makes mismatched options trivially unable to connect: a different model hashes to a different endpoint. The runner treats the endpoint as opaque (`--listen`), so the scheme lives entirely in this repo.

### Discovery: state file next to the endpoint
The spawner writes `<engineDir>/runner-<kind>-shared.json` containing `{ pid, endpoint, options }` after the runner reports ready (the PID comes from the runner's ready event). A connecting window:
1. reads the state file for its computed key;
2. checks PID liveness (see below);
3. connects and expects a ready handshake echoing the expected model/device; on mismatch or timeout, treats it as absent and spawns its own.

Alternative considered: scanning the pipe/socket directory — rejected; the state file is one read and carries the PID.

### PID liveness
The connecting window checks the remembered PID with `process.kill(pid, 0)` (ESRCH = dead). A live PID is not proof of identity — PIDs get reused — so liveness is only a fast pre-filter: the authoritative check is connecting and matching the ready handshake's model/device. PID reuse or a foreign process on the endpoint fails the handshake and falls through to spawn. The PID is also displayed ("shared, pid 1234").

### Client reuse of the existing protocol layer
`startStdioRunner` gains a sibling `connectSharedRunner(endpoint)` producing the same `RunningStdioRunner` interface over a `net.Socket` instead of the child's pipes — the NDJSON framing, request map, and stream generator are shared. Token routing switches to by-id when the runner supplies token ids, with the oldest-pending fallback for old runners. `onUnexpectedExit` already exists and serves lost-connection recovery unchanged. Shutdown with sharing enabled closes the client socket; it sends `shutdown` only in the private (sharing disabled) mode.

### Setting: `tlc.local.sharedRunner: boolean` (default true)
One toggle, applies to both stdio kinds. When disabled the extension never reads or writes the state file and spawns private-pipe runners exactly as today.

## Risks / Trade-offs

- [Runner binaries without listen mode] → the extension falls back to private spawn when connect fails or the runner predates listen mode; no version negotiation needed beyond the connect attempt.
- [Windows named pipe permissions] → default pipe ACL is creator-only per session; two windows of the same user are covered, no ACL work.
- [Stale `.sock` / state file after a crash] → the PID check plus connect-failure fallback covers it; the spawner recreates both.
- [Two windows racing to spawn] → both spawn, the loser's endpoint key differs or its connect fails next start; worst case one duplicate load for one session, no corruption.
- [Backend changes land later] → this change ships independently; until a runner release with listen mode is imported, the feature is a no-op pass-through.

## Migration Plan

1. Land the runner-side listen mode in the backend repos; release new `RUNNER_VERSION`s (their `shared-stdio-runner` changes).
2. Land this extension change; old bundled runners keep working via the fallback.
3. Rollback = set `tlc.local.sharedRunner: false`; no state to migrate.
