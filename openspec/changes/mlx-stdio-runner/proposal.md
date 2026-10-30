# Proposal

## Why

The `ovgenai` engine kind explicitly excludes macOS, and macOS (Apple Silicon) is the primary dev platform for the plugin. Local FIM completions on mac need a native engine: MLX. The runner itself is developed in the separate backend repository `m4gshm/type-like-chuck-backed-mlx` (Swift, MLX Swift LM, same NDJSON protocol as the ovgenai runner) — this change only integrates it into the extension.

## What Changes

- Add a third local engine kind `tlc.local.engineKind: "mlx"` — **macOS arm64 only**; on other platforms the kind is reported as unavailable (same pattern as `ovgenai` on unsupported platforms).
- Import the runner binary `tlc-mlx-runner-macos-arm64` into `binaries/mlx/darwin-arm64/`: locally from the backend repo's `build/`, in CI from the backend repo's GitHub release (`RUNNER_VERSION` pin) — same import machinery as the ovgenai binaries. No runtime library downloads: the MLX binary is self-contained.
- Extend the model catalog with the `mlx` model format (model directory: `config.json`, safetensors weights, tokenizer — `mlx-community` 4-bit, e.g. `mlx-community/Qwen2.5-Coder-*-4bit`) reusing the existing multi-file download machinery.
- Branch `engine_manager.ts` for the `mlx` kind: spawn the bundled binary via the existing `stdio_runner.ts` transport (identical NDJSON protocol), device is always `gpu` (Metal), no runtime-download step.
- README + `package.json` setting descriptions.

## Capabilities

### New Capabilities

- `mlx-engine`: extension-side integration of the macOS MLX runner — engine kind availability guard, binary import, mlx model catalog format, stdio lifecycle. The runner's own behavior (protocol, inference contract) is specified in the backend repository.

## Impact

- Extension: `engineKind: "mlx"` value, platform/arch guard, import script target, catalog format, manager branch (mostly a thin variation of the ovgenai branch).
- Package: `.vsix` grows by the macOS arm64 runner binary (~5–15 MB); no runtime downloads on mac.
- Platform matrix: `mlx` on macOS arm64; `ovgenai` stays Windows x64 + Linux x64; `llama.cpp` unchanged as default.
