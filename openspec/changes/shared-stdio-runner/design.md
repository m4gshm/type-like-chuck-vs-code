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

### Discovery: one file per live runner in `<engineDir>/runners/`
The spawner writes `runners/<kind>-<key>.json` (`{ pid, transport, endpoint, port?, token, options }`) after the runner reports ready; the key is a digest of the match fields. The `token` field carries the per-instance random secret handed to the runner at spawn (`--token`) and required from every client as the first (`auth`) message — without it, plain localhost TCP would let any local process generate completions. A connecting window scans the directory, filters files by option match, validates PID and connects with the token. Multiple mismatched instances coexist naturally as separate files: for `ovgenai` the match fields are model+device+context length — the NPU graph is compiled per ctx (`MAX_PROMPT_LEN`), so two windows with qwen 3B NPU ctx=4096 and ctx=8192 get two runners and two compilations; for `mlx` the match field is the model only — MLX compiles once (dynamic KV cache) and serves any context, so ctx does not split mlx instances. Stale files are ignored and deleted when encountered.

Why not a single state file: one file cannot describe two coexisting runners (same model, different ctx). Why not OS-level enumeration of pipes: not portable and carries no options to match on. Why a token: file permissions already guard the discovery file; the token guards the TCP listener, which any local process can reach.

### Transport: named pipe / unix socket by default, TCP as the boundary workaround
`\\.\pipe\tlc-runner-<key>` on Windows, `<engineDir>/runners/<key>.sock` on Linux/macOS. No TCP port by default. **TCP fallback** for setups where local IPC does not cross the plugin/backend boundary — VS Code remote or WSL, where the extension host and the spawned process live on different sides: the spawner starts the runner with `--listen-tcp 0` (random port), takes the chosen port from the `ready` event and records it in the discovery file; connecting windows use plain TCP on `127.0.0.1`. Chosen by the `tlc.local.sharedRunnerTransport` setting (`pipe` | `tcp` | `auto`: pipe first, TCP when the IPC transport fails to bridge); connecting windows follow the transport recorded in the discovery file, not their own setting. The runner never touches discovery files — the spawning extension writes and reaps them.

### Per-instance token
The spawner generates a random secret per spawn, passes it as `--token <secret>` and records it in the discovery file. The runner requires an `auth` request (`{"type":"auth","token":...}`) as the first message of every client connection in listen mode; anything else — or a wrong token — is rejected with an `error` event and the connection closed. Stdin/stdout mode keeps no authentication (its pipes are private). The token exists to protect the TCP transport, which any local process can reach; the file and pipe transports are protected by filesystem/session ACLs already, but the token applies uniformly in listen mode.

### PID liveness
The connecting window checks the remembered PID with `process.kill(pid, 0)` (ESRCH = dead). A live PID is not proof of identity — PIDs get reused — so liveness is only a fast pre-filter: the authoritative check is connecting and matching the ready handshake's model/device. PID reuse or a foreign process on the endpoint fails the handshake, falls through to spawn, and the stale file is deleted.

### Client reuse of the existing protocol layer
`startStdioRunner` gains a sibling `connectSharedRunner(record)` producing the same `RunningStdioRunner` interface over a `net` pipe/socket/TCP socket instead of the child's pipes — the NDJSON framing, request map, and stream generator are shared. Token routing switches to by-id when the runner supplies token ids, with the oldest-pending fallback for old runners. `onUnexpectedExit` already exists and serves lost-connection recovery unchanged. Shutdown with sharing enabled closes the client socket; it sends `shutdown` only in the private (sharing disabled) mode.

### Setting: `tlc.local.sharedRunner: boolean` (default true)
One toggle, applies to both stdio kinds. When disabled the extension never reads or writes discovery files and spawns private-pipe runners exactly as today.

## Risks / Trade-offs

- [Runner binaries without listen mode] → the extension falls back to private spawn when connect fails or the runner predates listen mode; no version negotiation needed beyond the connect attempt.
- [TCP on localhost without auth] → mitigated by the per-instance token: without a valid `auth` the runner closes the connection before processing anything.
- [Stale `.sock` / state file after a crash] → the PID check plus connect-failure fallback covers it; the spawner recreates both.
- [Two windows racing to spawn] → both spawn, the loser's endpoint key differs or its connect fails next start; worst case one duplicate load for one session, no corruption.
- [Backend changes land later] → this change ships independently; until a runner release with listen mode is imported, the feature is a no-op pass-through.

## Migration Plan

1. Land the runner-side listen mode in the backend repos; release new `RUNNER_VERSION`s (their `shared-stdio-runner` changes).
2. Land this extension change; old bundled runners keep working via the fallback.
3. Rollback = set `tlc.local.sharedRunner: false`; no state to migrate.
