# Tasks

## 1. Reconnaissance

- [x] 1.1 Verify exact HuggingFace repos/paths of `OpenVINO/Qwen2.5-Coder-0.5B/1.5B/3B` int4-ov IR models (filenames of `.xml`/`.bin` pairs, sizes, license); record the asset table in design notes (artifact: table in `design.md` appendix; verified by fetching the repo file listings)

## 2. C++ runner — moved to the backend repository

The runner implementation, its build automation and CI live in
`m4gshm/type-like-chuck-backed-openvino` (openspec change `openvino-genai-stdio-runner`
there); the plugin only imports its binaries (tasks 4.x).


## 3. Extension: transport and manager wiring

- [x] 3.1 Add `src/local_engine/stdio_runner.ts`: spawn bundled binary, readiness handshake, request-id bookkeeping, token-event async iterator, stderr forwarding to the log, crash callback, kill on dispose; unit tests with a stub child process covering ready, token stream, done, crash, and dispose-kill (artifact: module + `stdio_runner.test.ts`; verified by `npm run unit`)
- [x] 3.2 Add the bundled-binary path resolution (per platform/arch under the installed extension) and the `ovgenai` unavailability error for unsupported platforms; unit test the resolution matrix (artifact: unit tests; verified by `npm run unit`)
- [x] 3.3 Add the OpenVINO runtime library download step to the manager (pinned version, `tlc.local.githubUrl` override, extract via existing `extract.ts`, skip when present, progress notification reuse); unit tests for the already-present and download paths (artifact: manager branch + tests; verified by `npm run unit`)
- [x] 3.4 Add `engineKind: "ovgenai"` to config/settings and branch `engine_manager.ts` ensure/start/restart per kind (stdio runner vs HTTP engine), including device-chain mapping to the GenAI device string and NPU context cap; unit tests for each transition and the fallback chain (artifact: tests; verified by `npm run unit`)
- [x] 3.5 Add `stdio_completions_client.ts` (or provider transport abstraction) exposing the same surface the completion provider consumes, applying stop-token cut and single-line truncation to streamed tokens; unit tests for truncation and loop detection parity with the HTTP client (artifact: module + tests; verified by `npm run unit`)
- [x] 3.6 Add IR `.xml`+`.bin` pair download to the downloader/model catalog (carried over from the abandoned OVMS work) with pair-existence validation and `tlc.local.modelPath` accepting an `.xml`; unit tests for pair validation, offline model, and catalog integrity (artifact: tests; verified by `npm run unit`)

## 4. Packaging and UX

- [ ] 4.1 Wire the CI-produced runner binaries into packaging (`npm run package` fetches missing binaries from the repo release; `.vscodeignore`/files config includes `binaries/`); verify a packaged `.vsix` contains both platform binaries and installs (artifact: packaged vsix; verified by `vsce ls` / install test). *Wiring done (`scripts/fetch-runner-binaries.mjs` + `package` script); blocked on the first CI Runner run producing artifacts and on a network without a MITM cert for local verification.*
- [x] 4.2 Surface engine-kind-aware status and model picker (IR model entries with downloaded marks, device picker per GenAI devices) reusing existing commands; unit tests for picker contents per kind (artifact: tests; verified by `npm run unit`)
- [x] 4.3 Update `README.md` and `package.json` setting descriptions (engineKind values, ovgenai behavior, runtime download, IR models) keeping docs consistent with `contributes` (artifact: docs; verified by reading both side by side)

## 5. Integration verification

- [ ] 5.1 End-to-end smoke test on a dev host with real OpenVINO libs: ovgenai start → FIM completion → device switch → engine-kind switch llama.cpp ↔ ovgenai; confirm no HTTP port is opened and logs show `ovgenai:` lines (artifact: smoke-test notes; verified by running the extension dev host)
- [x] 5.2 Run `npm run build` (test + lint) and fix any issues (artifact: green CI-style build; verified by `npm run build`)
