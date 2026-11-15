# Proposal

## Why

Each VS Code window spawns its own stdio runner (ovgenai/mlx) and loads its own copy of the model, so two windows double the NPU/GPU/CPU memory footprint for exactly the same model on the same machine. The runner speaks NDJSON over private stdin/stdout pipes, so there is no way to share one instance today.

## What Changes

- The extension **connects to an existing shared runner** when one is alive and matches the configured model/device/context; otherwise it spawns a new one in listen mode and records the runner's PID and endpoint in a state file.
- The extension validates a remembered runner PID before connecting: if the process is gone (crashed, killed, machine reboot), it treats the backend as dead and spawns a new one instead of failing to connect.
- If the shared runner dies while the extension is connected, the extension detects the lost connection and follows its existing crash-restart path (spawn or connect to a new shared runner).
- New setting `tlc.local.sharedRunner` (default enabled on stdio engine kinds) to fall back to today's per-window private runner.
- Status bar / output channel distinguish a connected shared runner ("shared, pid N") from a privately spawned one.
- Runner-side capabilities (listen mode, client refcount with self-exit, per-request token routing, PID exposure) are specified in the backend repositories: `type-like-chuck-backed-openvino` and `type-like-chuck-backed-mlx`, each with a `shared-stdio-runner` change carrying the identical contract. Until a new runner release is imported (`RUNNER_VERSION`), the extension falls back to private spawns.

## Capabilities

### New Capabilities

- `local-engine/stdio-runner-sharing`: the extension-side shared-runner lifecycle — connect-or-spawn decision, PID liveness validation, lost-connection recovery, and the opt-out setting.

### Modified Capabilities

- `local-engine`: the "Engine process lifecycle" requirement currently mandates that a stdio runner's stdin/stdout pipes are private to one extension instance and the process is terminated by the extension on deactivate/mode switch; sharing relaxes this to a connect-or-spawn model where the extension only disconnects and the runner self-terminates (backend-side contract).

## Impact

- `src/local_engine/stdio_runner.ts` (connect in addition to spawn; PID validation), `src/local_engine/engine_manager.ts` (connect-or-spawn decision, model/device match check), `src/config.ts` + `package.json` (`tlc.local.sharedRunner` setting), `src/local_mode_status.ts` (status shows "shared"/"own" runner), README.
- Backend repositories (out of scope here): listen mode, refcount, token ids, PID — see their `shared-stdio-runner` changes.
- **Compatibility**: old runners without listen mode keep working — the extension falls back to private spawn when connect fails or the runner does not advertise a listen endpoint. Two windows with mismatched model/device settings do not share; each spawns its own runner keyed by its effective start options.
