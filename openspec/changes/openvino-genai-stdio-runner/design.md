# Design

## Context

The OVMS engine kind failed in practice (garbage inference). Reconnaissance of `openvino-node@2026.4.1` (npm tarball inspected directly) confirmed it is not viable for an LLM backend: the API surface is Core/Model/CompiledModel/InferRequest only — no `LLMPipeline`, no tokenizer, and no state API (`query_state`/`reset_state` absent from both `.d.ts` and the addon build). The `OpenVINO/*` int4-ov models are stateful KV-cache models, so incremental decoding is impossible through those bindings.

Decision: a compact custom C++ runner on the OpenVINO GenAI C++ API, speaking NDJSON over stdio, binaries bundled in the .vsix, OpenVINO runtime libraries downloaded on demand.

## Goals / Non-Goals

- Goals: full control over inference (no serving layer to debug); native int8-ov IR models; NPU/GPU(Arc)/CPU on Windows x64 + Linux x64; identical completion UX across engine kinds.
- Non-Goals: HTTP/OpenAI API inside the runner; macOS support in the first iteration; MLX or other runtime kinds; replacing llama.cpp as the default kind.

## Decisions

### D1. Stdio NDJSON protocol instead of HTTP
The runner is a private child process; its stdin/stdout pipes are the transport. No ports, no API keys, no health endpoint — readiness is an explicit `ready` event on stdout. The protocol definition (requests, events, cancellation, sequential-request policy) is owned by the backend repository (`m4gshm/type-like-chuck-backed-openvino`, design D1 there); the extension side of the contract is D5 below.

### D2. Runner binary bundled, runtime libraries downloaded
The runner backend lives in its own repository
(`m4gshm/type-like-chuck-backed-openvino`); the TLC repo only **imports** its
binaries — locally from the backend `build/` directory, in CI from the backend
repo's GitHub release (pinnable via `RUNNER_VERSION`). The .vsix carries
per-platform runner binaries under `binaries/ovgenai/{platform}-{arch}/` (~5–15 MB each). A single OpenVINO GenAI archive per platform (it bundles the OpenVINO Runtime, all device plugins, TBB and the GenAI headers/libs — verified in the backend repo's design appendix, no separate runtime download is needed) is downloaded on first use from `storage.openvinotoolkit.org` (overridable via the dedicated `tlc.local.openvinoUrl` setting — the host is not GitHub, so `tlc.local.githubUrl` does not apply) into `tlc.local.engineDir/ov-genai-<version>/`, unpacked by the existing `extract.ts`, and put on the runner's library path (`PATH` prepend on Windows, `LD_LIBRARY_PATH` on Linux). This keeps the package within Marketplace size limits while the runner stays "part of the plugin".

### D3. C++ runner on `ov::genai::LLMPipeline`
The runner implementation (C++ on `ov::genai::LLMPipeline`, build tasks, CI with loader smoke and tag releases) is owned by the backend repository — see its `openspec/changes/openvino-genai-stdio-runner/design.md` (D3/D4 there).

### D4. IR model catalog
New catalog entries alongside the GGUF ones: `OpenVINO/Qwen2.5-Coder-0.5B/1.5B/3B-Instruct-int8-ov` (repo/paths verified during task 1; the backend e2e runs the int8-ov model — see its appendix). Downloader gains pair download (`.xml`+`.bin`) with pair-existence checks — carried over from the abandoned OVMS change work. `tlc.local.modelPath` accepting an `.xml` implies the `.bin` sits next to it.

### D5. Extension transport
`engine_runner.ts` stays for llama.cpp (HTTP). A new `stdio_runner.ts` spawns the bundled binary, does the readiness handshake, request id bookkeeping, token-event → async-iterator bridging, crash detection (`close` handler) and kill-on-dispose. `engine_manager.ts` branches per engine kind for ensure/start/restart/status; `CompletionsClient` is bypassed for the stdio kind — a thin `stdio_completions_client.ts` exposes the same interface shape the provider consumes (or the provider gains a transport abstraction; smallest change wins during implementation).

### D6. Device mapping and fallback
Reuse `deviceChain()`. For `ovgenai`: `cpu` → `"CPU"`, `gpu` → `"GPU"`, `npu` → `"NPU"`, `auto` → NPU probe then GPU then CPU (same chain as the OpenVINO llama.cpp build), with start-failure retry down the chain. The NPU context cap (`NPU_CONTEXT_LENGTH`) applies to the compiled pipeline config.

### D7. Capability probe (engine kind recommendation)
`probeCapability()` becomes a real probe: platform/arch first (unsupported → remote), then on Windows/Linux x64 detect the CPU vendor (`os.cpus()[0].model` contains Intel) and the Intel NPU hardware (Windows: WMI PnP entity "Intel(R) AI Boost" / "Intel(R) NPU" or PNPClass `ComputeAccelerator` — the device name differs across driver generations; Linux: PCI scan for vendor 0x8086 device class 0x1180 — a cheap process spawn or sysfs read, cached per session). Recommendation matrix: Intel + NPU → `ovgenai` + NPU; Intel without NPU → `ovgenai` + `auto` (the runner's device chain resolves GPU→CPU at start, which also covers the no-GPU case such as GitHub Actions); macOS arm64 → `mlx`; macOS x64 / other → llama.cpp (`auto`); unsupported → remote. `RecommendedPath` gains an `engineKind` field, and `offerRecommendedLocalEngine` applies both engineKind and device when the user accepts the recommendation. GPU *presence* is not probed at extension level — the already-specified start-failure fallback chain (runner auto → GPU → CPU) handles that; the probe only decides which engine kind to recommend.

### D8. Local distribution folder and model picker
- `tlc.local.distroDir` (empty by default): a locally unpacked engine distribution. For `ovgenai` it is an OpenVINO GenAI runtime archive directory (unpacked by the user, same layout as the downloaded one); for llama.cpp it is an unpacked llama.cpp build. When set, the manager skips the engine/runtime download for that kind and uses the folder in place; a wrong layout surfaces as a start failure with the standard error path. This replaces the per-asset `tlc.local.engineBinary`/`tlc.local.openvinoUrl` overrides for the offline case.
- Model picker: `TLC: Select Local Model` gains a "From disk…" entry that opens a file dialog (GGUF for llama.cpp, `.xml` for ovgenai) and writes `tlc.local.modelPath`; the engine starts with that file and downloads nothing. The setting is cleared when the user picks a catalog model again.
- Non-Qwen2.5-Coder warning: when the resolved model (catalog selection or `tlc.local.modelPath`) is not a Qwen2.5-Coder catalog entry, the extension warns on engine start that the model was not validated for FIM completions; completions continue.

## Risks / Trade-offs

- [Bundled binaries in git/vsix] → binaries built by CI, fetched at package time; `.vscodeignore` keeps non-target platforms out only if we later split per-platform packages (accepted: one vsix carries all binaries for now).
- [LLMPipeline streaming granularity] → token events may arrive per-piece rather than per-token; acceptable — the extension assembles incrementally either way.
- [int4-ov model availability/paths on HuggingFace] → verified in the recon appendix; `tlc.local.modelUrls` override exists as an escape hatch.
- [Windows library path] → runner resolves OpenVINO DLLs next to its own binary first; the extension copies/symlinks runtime libs into the binary's directory if needed.

### Appendix: Recon results (task 1)

#### IR model repos (int4-ov verified via HF API, 2026-10-29; int8-ov is the current backend e2e default)

The catalog uses the **int8-ov** variants (`OpenVINO/Qwen2.5-Coder-*-Instruct-int8-ov`) — the model the backend e2e validates on NPU/GPU/CPU. The int4-ov table below is the original recon (int4-ov caused 20+ min NPU compiles; backend switched to int8-ov). Sizes for int8-ov are re-verified in task 6.5.

All three are public (`gated: false`). A model is a **directory**, not a pair: `openvino_model.xml`/`.bin` plus separate `openvino_tokenizer.xml`/`.bin` and `openvino_detokenizer.xml`/`.bin` (+ tokenizer JSONs). `LLMPipeline` accepts the model directory and auto-discovers the tokenizer files.

| Model | Repo | Download size (approx) |
| --- | --- | --- |
| 0.5B | `OpenVINO/Qwen2.5-Coder-0.5B-Instruct-int4-ov` | ~349 MB |
| 1.5B | `OpenVINO/Qwen2.5-Coder-1.5B-Instruct-int4-ov` | ~941 MB |
| 3B | `OpenVINO/Qwen2.5-Coder-3B-Instruct-int4-ov` | ~1835 MB |

Catalog entries should therefore download a file list (`openvino_model.xml/.bin`, `openvino_tokenizer.xml/.bin`, `openvino_detokenizer.xml/.bin`, `tokenizer.json` at minimum) into one model directory. The OpenVINO GenAI runtime archive URLs/layout recon moved to the backend repository's design appendix.

## Migration Plan

`llama.cpp` remains the default engine kind; `ovgenai` is opt-in via `tlc.local.engineKind`. The OVMS change (`local-engine-ovms`) is archived as abandoned; its `.xml`+`.bin` downloader work is re-landed here.
