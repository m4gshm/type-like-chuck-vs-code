# Tasks

## 1. Reconnaissance

- [x] 1.1 List the real assets of `tlc.local.ovmsVersion's target release (OpenVINO Model Server v2026.4.1) on GitHub and record the exact filenames/format for Windows and Ubuntu tarballs; adjust `release_assets` if the assumed pattern differs (artifact: asset table recorded in design notes; verified by an `Invoke-WebRequest` against `api.github.com/repos/openvinotoolkit/model_server/releases/latest)
- [ ] 1.2 Fetch the OVMS GenAI deployment docs/config schema for a file-based OV IR model (mediapipe config example) and pin it in the sep arranged (artifact: example JSON in the module docstring; verified by producing a config that `ovms --config_path` accepts in a local run)

## 2. Core modules

- [x] 2.1 Add `tlc.local.engineKind` (`llama.cpp` | `ovms`, default `llama.cpp`) and `tlc.local.ovmsVersion` (`v2026.4.1`) to `config.ts` and `package.json` (both setting descriptions synced; verify with `npm run check-types` and reading `package.json` descriptions)
- [x] 2.2 Add OVMS asset resolution to `release_assets.ts`: Windows x64 zip, Ubuntu 22/24 tar.gz by glibc version, `python_off` only (unit test with a synthetic asset list; verify with `npm run unit`)
- [x] 2.3 Add OV IR model URL pairs to `model_catalog.ts` and extend the downloader for `.xml` + `.bin` pairs with resume and pair-existence checks (unit tests for pair validation and resume; verify with `npm run unit`)
- [x] 2.4 Add the ovms start-arg assembly: model files path/start args (`--source_model` or `--model_path`, `--model_repository_path`, `--rest_port`) and the `plugin_config` device-properties JSON (per the amended decision in design.md — no mediapipe graph file needed) (unit test asserting the assembled args/config; verify with `npm run unit`)
- [x] 2.5 Add the ovms adapter to `engine_runner`: cmdline (`--config_path`, `--rest_port`), endpoint base `/v3`, ready check against the OVMS readiness endpoint, stdout/stderr forwarding as `ovms: ...` lines (unit tests; verify `npm run unit`)
- [x] 2.6 Extend `engine_manager`: engine-kind switch stops the running engine and boots the selected one; readiness line includes engine kind and base path; engine-kind switch is surfaced to the progress display with stage labels while no bytes, byte counts per phase, no `0B` (unit tests; verify `npm run unit`)

## 3. Device fallback and llama.cpp simplification

- [x] 3.1 Apply device fallback to the ovms engine path: NPU start failure → GPU before CPU, matching the chain fixed for llama.cpp (unit test on the fallback order; verify `npm run unit`)
- [x] 3.2 Add the platform capability probe (NPU present? → ovms+NPU; else GPU probe → llama.cpp+gpu; else propose remote `tlc.openai.*`) and surface the recommended path with its reason (unit tests on the probe matrix; verify `npm run unit`)
- [x] 3.3 Remove the `GGML_OPENVINO_*` env logic, the OpenVINO llama.cpp release asset, and the OpenVINO IR/compiled-model cache wiring from `device.ts`/`release_assets.ts`/`paths.ts` (verify with `npm run unit` — no OpenVINO branches for the llama.cpp engine)
- [x] 3.4 Remove `tlc.local.npuCompileConfig` from `package.json` and `config.ts` (verify `openspec validate` unaffected and `npm run check-types` clean)

## 4. Commands and extension wiring

- [x] 4.1 Add/verify `TLC: Select Local Engine` command wiring through `ModelConfig`/engine-manager host callbacks (unit test on the command path; verify `npm run unit`)
- [x] 4.2 Startup validation accounts for the ovms engine (missing build/model offer the download like llama.cpp; verify via the existing startup flow unit tests)
- [x] 4.3 `tlc.local.apiKeyEnabled` toggle triggers engine restart for the ovms engine too, ready line shows `key=...` or `(none — key authentication disabled)` when key enforcement is unsupported by OVMS (unit tests; verify `npm run unit`)

## 5. Integration

- [x] 5.1 Integration test: start the ovms engine against the stub server's OVMS analogue (readiness endpoint + `/v3/completions`), confirm single-line completion and cache behavior (verify `npm run test` passes end-to-end)
- [ ] 5.2 Manual smoke test with a real OVMS start on the dev host: confirm NPU engagement (ovms log lines in the output channel) and request latency compared to llama.cpp CPU (artifact: smoke-test notes; verified by running the extension dev host and inspecting TLC output)

## 6. Docs

- [x] 6.1 Sync `README.md`: engine selection section, OVMS weight/first-run notes, debugging/curl examples, key enforcement caveat (verify README statements match `package.json` descriptions)
- [x] 6.2 `openspec validate local-engine-ovms` and `npm run build` pass (verify with the commands)
