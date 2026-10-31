# Proposal

## Why

The OVMS experiment (`local-engine-ovms`) failed: OVMS produced garbage inference on the FIM completion workload, so the OpenVINO-native path needs a different runtime. A reconnaissance of `openvino-node@2026.4.1` (npm, Oct 2026) showed it exposes only the low-level runtime API — no `LLMPipeline`, no tokenizer, and critically no state API (`query_state`/`reset_state`), which makes incremental KV-cache decoding impossible for stateful int4-ov models. A small custom C++ runner built on the OpenVINO GenAI C++ API gives full control over inference (no third-party serving layer to debug) with tokenizer, streaming and stop strings provided out of the box.

## What Changes

- Add a **native OpenVINO GenAI runner** as a second local engine kind (`tlc.local.engineKind: "ovgenai"`):
  - a compact C++ binary per platform **bundled in the .vsix** (one binary per platform variant);
  - the heavy OpenVINO Runtime/GenAI shared libraries are NOT bundled — they are downloaded on first use into the engine directory (existing downloader/extract machinery);
  - loads native OpenVINO IR models (`.xml` + `.bin` pairs, NNCF int4, e.g. `OpenVINO/Qwen2.5-Coder-*`) directly — no GGUF conversion;
  - **no OpenAI HTTP API inside the runner**: it communicates with the extension over **stdin/stdout/stderr using newline-delimited JSON (NDJSON)** — completion requests in on stdin, streamed token events out on stdout, logs out on stderr. No ports, no HTTP, no API keys for this engine kind.
- Add a stdio transport in the extension side so the existing FIM completion pipeline (prompt templates, single-line truncation, caching) works unchanged on top of the runner.
- Extend model catalog with int4-ov IR model entries (xml+bin pair download with pair-existence checks, reusing the OVMS change's downloader extension).
- Platform matrix (first iteration): Windows x64 and Linux (Ubuntu) x64, devices CPU / GPU (Intel Arc) / NPU.
- **Capability probe**: the first-run engine recommendation chooses engine kind + device, not just device: Windows/Linux Intel x64 → `ovgenai` (NPU detected → NPU, else GPU→CPU via the runner's auto chain); macOS arm64 → `mlx`; macOS x64 → llama.cpp; other platforms → llama.cpp (GPU→CPU); unsupported → remote.
- **Local distribution folders**: the user can point the extension at a locally unpacked engine distribution (`tlc.local.distroDir`) for the `ovgenai` (OpenVINO GenAI runtime) or llama.cpp kind — setup skips downloads and uses the folder in place.
- **Model selection without re-download**: `TLC: Select Local Model` gains a "From disk…" entry that sets `tlc.local.modelPath` (GGUF file or IR `.xml`), so an already-available local model is used without downloading.
- **Non-Qwen2.5-Coder warning**: selecting a model that is not a Qwen2.5-Coder catalog entry (via catalog or `tlc.local.modelPath`) shows a compatibility warning.
- Remove/reject the OVMS engine kind path (`ovms` work is superseded; the OVMS change is archived without implementation).

## Capabilities

### New Capabilities

- `openvino-genai-runner`: the bundled native stdio runner — NDJSON protocol over stdin/stdout, per-platform binaries shipped in the extension package, OpenVINO runtime library acquisition, and the IR model inference contract (streaming tokens, stop strings, context window).

### Modified Capabilities

- `local-engine-runtime`: engine kind selection gains `ovgenai`; for this kind the lifecycle is a stdio child process (no HTTP endpoint isolation, no per-session key — the process is a private pipe); device selection maps to the OpenVINO GenAI device string; model/device switches restart the runner.
- `local-engine-setup`: for the `ovgenai` kind the engine is a bundled binary plus a downloaded OpenVINO runtime library archive; models are `.xml`+`.bin` IR pairs instead of GGUF files; a locally unpacked distribution folder can replace downloads; a local model file can be selected without downloading.
- `local-engine-mode`: in local mode with `engineKind: "ovgenai"` completion requests are routed through the stdio transport instead of an HTTP endpoint; remote/llama.cpp behavior is unchanged.

## Impact

- New C++ component (`runner/` in the repo): NDJSON stdio server on `ov::genai::LLMPipeline`; CMake build for win-x64 and linux-x64; CI jobs producing binaries committed/packaged into the extension.
- Extension: new stdio transport adapter (`src/local_engine/`), `engineKind` value `ovgenai`, IR model catalog entries, runtime-library download step, config settings for the runner (runtime version, IR model overrides).
- Package: `.vsix` grows by the per-platform runner binaries (~5–15 MB each); OpenVINO runtime libs (~100–200 MB per platform) stay out of the package and download into `tlc.local.engineDir`.
- Superseded: the `local-engine-ovms` change is abandoned; its downloader work for `.xml`+`.bin` pairs is carried over here.
