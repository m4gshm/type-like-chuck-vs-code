# Tasks

Runner-side work (listen mode, refcount, token ids, PID) lives in the backend repositories — see `shared-stdio-runner` in `type-like-chuck-backed-openvino` and `type-like-chuck-backed-mlx`; this change depends on their releases being imported via `RUNNER_VERSION`.

## 1. Shared runner client

- [ ] 1.1 Add `connectSharedRunner(endpoint, options, deps)` in `stdio_runner.ts` producing the same `RunningStdioRunner` over a `net` pipe/socket, sharing the existing NDJSON handling; route `token` events by id with fallback to oldest-pending for old runners; verify with a unit test against a fake socket speaking the protocol
- [ ] 1.2 Implement the discovery directory (`<engineDir>/runners/`): file naming (`<kind>-<key>.json`), read/write/reap (`{ pid, transport, endpoint, port?, options }`), directory scan with option matching (ovgenai: model+device+ctx; mlx: model); verify shapes and match/no-match branches with unit tests
- [ ] 1.3 Implement PID liveness check (`process.kill(pid, 0)` + ready-handshake model/device match) used before connecting; verify stale-PID, PID-reuse, and dead-endpoint branches in unit tests
- [ ] 1.4 Implement TCP transport fallback: spawner passes `--listen-tcp 0`, records the ready-reported port in the discovery file; `connectSharedRunner` connects over `127.0.0.1:<port>` when `transport` is `tcp`; verify with a fake TCP server in a unit test

## 2. Engine manager lifecycle

- [ ] 2.1 Add connect-or-spawn to `engine_manager.ts`: scan the discovery directory → option match → PID check → connect (handshake) → fallback to private spawn; verify multiple-instance matching (same model, different ovgenai ctx; same model, different mlx ctx) with unit tests
- [ ] 2.2 Handle lost connection via the existing `onUnexpectedExit` path: report, then rerun connect-or-spawn; verify with a unit test that kills the fake server and asserts restart
- [ ] 2.3 Change shutdown with sharing enabled: close the client socket instead of sending `shutdown`; verify deactivate/mode-switch does not terminate the process (unit test with fake runner)

## 3. Settings, status, docs

- [ ] 3.1 Add `tlc.local.sharedRunner` (boolean, default true) to `config.ts` and `package.json` contributes; verify `npm run check-types` and that disabling spawns a private runner (unit test)
- [ ] 3.2 Show "shared, pid N" in `local_mode_status.ts` / status bar and log endpoint+PID to the output channel; verify via unit test on the status text
- [ ] 3.3 Update `README.md` (local engine section) to describe sharing, the setting, the self-termination behavior, and the dependency on new runner releases; verify README matches `package.json` descriptions

## 4. Integration verification

- [ ] 4.1 Import new runner binaries (`task runner:import` / `runner:fetch` with the released `RUNNER_VERSION`) and verify `--listen` support via `--version`/smoke
- [ ] 4.2 Two-window integration check on Windows (F5 or packaged vsix): first window spawns the shared runner, second connects with no second model load; close first window → runner stays; close second → runner self-exits; record results in the TLC output channel
- [ ] 4.3 Run `npm run build` (unit + integration + lint) and fix any regressions
