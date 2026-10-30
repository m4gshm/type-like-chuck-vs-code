# Tasks

## 1. Engine kind and wiring

- [x] 1.1 Add `engineKind: "mlx"` to config/`package.json` settings; availability guard: darwin + arm64 only, otherwise the engine reports unavailable with a clear message; platform default — `mlx` on macOS arm64 when the setting is untouched (artifact: config + unit tests; verified by `npm run unit`)
- [x] 1.2 Branch `engine_manager.ts` for `mlx`: ensure (binary presence check, no runtime download), start/restart via `stdio_runner.ts` with `--model`/`--ctx`, device fixed to `gpu`; unit tests for each transition (artifact: tests; verified by `npm run unit`)

## 2. Import and packaging

- [x] 2.1 Add the `darwin-arm64` mlx target to `scripts/fetch-runner-binaries.mjs` (asset `tlc-mlx-runner-macos-arm64` from the backend repo release → `binaries/mlx/darwin-arm64/tlc-mlx-runner`) and to `tasks.yaml` `runner:import` (local copy from the backend `build/`); `package.yml` launch-verification covers the mlx binary (artifact: script/tasks; verified locally / in CI)

## 3. Models and docs

- [x] 3.1 Add the `mlx` model catalog format (directory download: `config.json`, `*.safetensors`, tokenizer files from `mlx-community/Qwen2.5-Coder-*-4bit`) reusing the multi-file downloader; model picker shows mlx entries only for the mlx kind (artifact: catalog + tests; verified by `npm run unit`)
- [x] 3.2 Update `README.md` and `package.json` descriptions (mlx kind, platform matrix, self-contained binary — no runtime downloads on mac) (artifact: docs; verified by reading both side by side)

## 4. Verification

- [ ] 4.1 F5 smoke on a mac dev host: mlx start → FIM completion → engine-kind switch llama.cpp ↔ mlx; logs show `mlx:` lines, no HTTP port (artifact: smoke notes; verified by running the extension dev host)
- [ ] 4.2 `npm run build` green (artifact: CI-style build; verified locally)
