# Tasks

Runner-side work (listen mode, refcount, token ids, PID) lives in the backend repositories — see `shared-stdio-runner` in `type-like-chuck-backed-openvino` and `type-like-chuck-backed-mlx`; this change depends on their releases being imported via `RUNNER_VERSION`.

## 1. Shared runner client

- [x] 1.1 Add `connectSharedRunner(endpoint, options, deps)` in `stdio_runner.ts` producing the same `RunningStdioRunner` over a `net` pipe/socket, sharing the existing NDJSON handling; route `token` events by id with fallback to oldest-pending for old runners; verified with unit tests against a real local TCP fake server (auth, token routing, close-on-lost-connection)
- [x] 1.2 Implement the discovery directory (`<engineDir>/runners/`): file naming (`<kind>-<key>.json`), read/write/reap (`{ pid, transport, endpoint, port?, token, options }`), directory scan with option matching (ovgenai: model+device+ctx; mlx: model); verified shapes and match/no-match branches in `runner_discovery.test.ts`
- [x] 1.3 Implement PID liveness check (`process.kill(pid, 0)` + ready-handshake model/device match) used before connecting; verified stale-PID (reap+skip), live-PID and option-mismatch branches in unit tests
- [x] 1.4 Implement TCP transport fallback: spawner passes `--listen-tcp 0`, records the ready-reported port in the discovery file; `connectSharedRunner` connects over `127.0.0.1:<port>` when `transport` is `tcp`; verified with the fake TCP server in a unit test
- [x] 1.5 Implement the per-instance token: generate on spawn, pass `--token`, record in the discovery file, send `auth` as the first message on connect; verified reject-without-token with the fake server in a unit test
- [x] 1.6 Add `tlc.local.sharedRunnerTransport` (`pipe` | `tcp` | `auto`, default `pipe`) to `config.ts` and `package.json`; connecting windows follow the discovery-file transport; verified the setting plumbs through with a unit test

## 2. Engine manager lifecycle

- [x] 2.1 Add connect-or-spawn to `engine_manager.ts`: scan the discovery directory → option match → PID check → connect (handshake) → fallback to private spawn; multiple-instance matching (same model, different ovgenai ctx; same model, different mlx ctx) covered by the discovery unit tests
- [x] 2.2 Handle lost connection via the existing `onUnexpectedExit` path: report, then rerun connect-or-spawn; verified with a unit test that closes the fake server and asserts the exit callback
- [x] 2.3 Change shutdown with sharing enabled: close the client socket instead of sending `shutdown`; verified by the shared spawn path (`stop()` disconnects, the runner self-terminates via its refcount)

## 3. Settings, status, docs

- [x] 3.1 Add `tlc.local.sharedRunner` (boolean, default true) and `tlc.local.sharedRunnerTransport` (`pipe` | `tcp` | `auto`, default `pipe`) to `config.ts` and `package.json` contributes; verified `npm run check-types`; disabling spawns a private runner (sharedRunner:false branch skips startSharedRunner)
- [x] 3.2 Show "shared, pid N" in `local_mode_status.ts` / status bar and log endpoint+PID to the output channel; unit-testable via the status text
- [x] 3.3 Update `README.md` (local engine section) to describe sharing, the transport setting, the per-instance token, and the self-termination behavior; README matches `package.json` descriptions

## 4. Integration verification

- [x] 4.1 Import new runner binaries (`task runner:import` / `runner:fetch` with the released `RUNNER_VERSION`) and verify `--listen` support via `--version`/smoke
- [x] 4.2 Two-window integration check on Windows (F5 or packaged vsix): first window spawns the shared runner, second connects with no second model load; close first window → runner stays; close second → runner self-exits; record results in the TLC output channel
- [x] 4.3 Run `npm run build` (unit + integration + lint) and fix any regressions
