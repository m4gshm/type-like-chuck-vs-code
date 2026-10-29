# Design

## Context

TLC currently has one local engine: llama-server (llama.cpp OpenVINO build) serving `/v1/completions` on loopback with a per-session key. Its NPU path fails for Qwen2.5-Coder Q4_K_M with the `WeightlessCacheAttribute` exception (llama.cpp #25904). OVMS publishes standalone Docker-free builds in GitHub Releases and embeds the OpenVINO GenAI pipeline, whose NPU flow is Intel-maintained and does not reproduce the llama.cpp backend bug. See proposal.md for motivation and the delta spec for behavior.

## Goals / Non-Goals

**Goals:**
- Second engine kind (`ovms`) behind the existing engine-manager abstractions, sharing progress display, readiness log, fallback device chain, and command surface.
- One-time download of the OVMS build and the OV IR model, cached and reused.
- Same debuggability: output-channel forwarding, curl-friendly ready line, `tlc.local.apiKeyEnabled`.

**Non-Goals:**
- Removing or modifying llama.cpp behavior.
- Any OpenVINO GenAI JS/TS API or Python-based runner (separate backlog change).
- macOS/ARM support.

## Decisions

1. **Platform probe drives the default chain: ovms+NPU → llama.cpp+GPU → remote OpenAI API.** Before choosing an engine, TLC probes for Intel NPU (OpenVINO NPU plugin / NPU driver, Intel Core Ultra class). Probe order and outcome:
   - NPU available → ovms engine on NPU (default recommendation).
   - NPU absent/unusable → llama.cpp engine is recommended with `device=gpu` (a GPU probe: OpenVINO GPU plugin / remote adapter).
   - Neither works (or the engine keeps failing after fallbacks) → TLC proposes remote mode using `tlc.openai.*`; local remains available as explicit opt-in.
   Reason for the recommendation is shown (e.g. "NPU not detected → llama.cpp + GPU"). This sits above the engine-manager runtime fallbacks; the probe answers "which engine/device to *try first*", the device chain still answers "what to retry after a failed start".

2. **Engine kind as a top-level setting.** `tlc.local.engineKind: llama.cpp | ovms` (default `llama.cpp`). The engine manager treats the kind as data; `engine_runner` gains an adapter interface so llama-server and ovms produce (cmdline args, env, endpoint base path, ready check) without manager branching.

3. **Asset selection by release-file naming convention.** Resolve the build from `ovms_<os>_<ver>_python_off.<ext>` pattern in the release assets: `ovms_windows_...zip` for Windows x64; for Linux x64, `ovms_ubuntu22_...tar.gz` vs `ovms_ubuntu24_...tar.gz` chosen by `ldd --version` glibc version (≥ 2.39 → ubuntu24). `python_on` variants (bundled Python for media pipelines) are ignored. Rationale: stable, documented naming in OVMS releases; alternative — hardcoding a single asset per OS — loses the glibc distinction.

3. **OV IR model entries in the model catalog.** Each local model size gets an OV IR URL pair (e.g. `OpenVINO/Qwen2.5-Coder-1.5B-Instruct` `.xml` + `.bin`) in addition to the GGUF URL. The downloader treats each file separately with resume support; both files must exist in the model directory for the ovms engine to start. URL overrides (`tlc.local.modelUrls`) extend to the OV IR pair by keyed suffixes.

4. **Endpoint base path per engine.** llama-server keeps `/v1`; ovms gets `/v3` (OVMS GenAI pipeline serves OpenAI-compatible `/v3/completions`). The local endpoint getter composes `http://127.0.0.1:<port><base>` so `CompletionsClient` streams the same FIM request unchanged.

5. **Config generation over CLI-heavy flags.** TLC writes a mediapipe config JSON into the ovms directory (model files path, device, generation properties) and starts `ovms --config_path ... --rest_port <port>`. Device is conveyed by the config's generator properties, mirroring the documented OVMS GenAI deployment; `GGML_OPENVINO_*` env vars are llama.cpp-specific and are not set for ovms.

6. **Key/auth: verify at implementation, degrade gracefully.** OVMS's support for a shared secret on the REST endpoint (e.g. an api-key property in the mediapipe vertex) is verified first during implementation. If supported: same per-session key flow. If not: the ready line notes the gap explicitly, key enforcement is skipped, and the localhost-only restriction plus self-termination with the editor session remain the protections; a documented limitation goes into README.
   - Alternative rejected: proxy via a TLC-side localhost proxy injecting auth — disproportionate for now.

## Risks / Trade-offs

- [OVMS build is heavy (~120–180 MB compressed, ~400–600 MB on disk)] → one-time download with existing progress display (stage labels while no bytes, byte counts per phase, no `0B`).
- [Asset naming/format may differ from the assumed pattern in a given OVMS release] → first implementation step is listing the real assets for the pinned version and fixing the resolution table based on what exists there.
- [Key/auth support uncertain] → degradation path is decided above; be honest in the ready line and documentation.
- [OV IR model weights are FP16/BF16 (~1–2 GB), larger than Q4 GGUF] → the ovms engine targets NPU quality over VRAM; the llama.cpp engine remains the low-bandwidth default.
- [OVMS REST semantics for `stop`, `max_tokens`, single-line streaming may differ from llama-server] → integration test against a real OVMS start verifies truncation/stop behavior before wiring; adjust the client's stop-token cut only if needed.

## Migration Plan

No user-data migration: `tlc.local.engineKind` defaults to `llama.cpp`, so existing setups keep running llama-server. The ovms engine activates only when selected. Rollback = flip the setting back.

## Open Questions

- Exact OVMS GenAI mediapipe config schema for a file-based OV IR model (verified by listing the release docs/binaries during implementation, gated by the spec's start scenario).
- Does the llama.cpp engine keep a GPU-capable standard build (CUDA/Vulkan), or does the GPU fallback move fully to remote mode if no standard GPU build is shipped? Resolved during apply by picking the llama.cpp release assets.

## Asset table (verified against OVMS v2026.4.1, latest release at apply time)

llama.cpp engines use the **universal vulkan build** (user decision: llama.cpp GPU is priority; `llama-<tag>-bin-win-vulkan-(x64|arm64).zip`, `llama-<tag>-bin-ubuntu-vulkan-(x64|arm64).tar.gz` — GPU via Vulkan on NVIDIA/AMD/Intel with CPU fallback, no separate cudart download; macOS cpu builds already accelerated via Metal). Launch adds `-ngl 999` unless the device is `cpu`.

| platform | asset name | size |
| --- | --- | --- |
| Windows x64 | `ovms_windows_<v>_python_off.zip` (+`.zip.sha256`) | 118 MB |
| Windows x64 with Python | `ovms_windows_<v>_python_on.zip` (unused, **dropped — Python support not needed**) | 140 MB |
| Ubuntu 22 | `ovms_ubuntu22_<v>_python_off.tar.gz` (+`.sha256`) | 178 MB |
| Ubuntu 24 | `ovms_ubuntu24_<v>_python_off.tar.gz` (+`.sha256`) | 181 MB |
| RedHat | `ovms_redhat_<v>_python_off.tar.gz` | 120 MB |

Pattern confirmed: `ovms_<os>_<v>_python_<off|on>.<zip|tar.gz>`, version `v2026.4.1`, tag `v2026.4.1` = "latest" at apply time. The `v` in filenames carries no `v` prefix (`2026.4.1`). User decision: **Python support is not needed — only `python_off` assets are used; UA is `python_on` never downloaded.**

## OVMS text-generation deployment (verified against docs/llm/reference.md + quickstart.md)

- Baremetal start works without Python: `ovms --source_model <repo-id> --model_repository_path <dir> --rest_port <port>` (also supports `--model_path`/`--model_name` for a local directory). First start downloads the model from HF itself; repeating start reuses the cache.
- **Verified against the real 2026.4.1 Windows build**: the device flag is `--task text_generation --target_device <CPU|GPU|NPU>` — there is **no `--device`** flag (it fails option parsing and the server exits). `plugin_config` is not required for startup; NPU is never auto-selected, it must be requested explicitly. `--rest_bind_address 127.0.0.1` pins REST to loopback (default binds `0.0.0.0`). Generative `/v3` endpoints accept an API key via the `API_KEY` env or `api_key_file`; client sends `Authorization: Bearer <key>`.
- Servable type is inferred: device NPU → **Stateful** (the only NPU-capable type); CPU/GPU → Continuous Batching. This matches the priority chain: ovms+NPU is a Stateful servable.
- Model directory requires: `openvino_model.xml` + `openvino_model.bin`, `openvino_tokenizer.xml/.bin`, `openvino_detokenizer.xml/.bin`, `tokenizer_config.json` (and optional `chat_template.jinja`, `generation_config.json`). `/completions` works without a chat template.
- Device props for NPU go through `plugin_config`: `{"DEVICE_PROPERTIES": {"NPU": {"MAX_PROMPT_LEN": 2048}}}`; KV tuning options are ignored by Stateful.
- Endpoints: OpenAI-compatible; readiness check via `GET /v1/models`. Streaming on `/v3/completions`.
- Recommended alternative start (Python-free): direct `--config_path` graph.pbtxt; we avoid it — CLI flags suffice (decision 5 amended: no mediapipe JSON generation needed; OVMS builds the graph from `--source_model`/`--model_path` itself).

**Amendment to decision 5**: TLC does not write a mediapipe config JSON — OVMS composes the graph itself when started with `--source_model`/`--model_repository_path` (or `--model_path`). The generated config in task 2.4 is reduced to the start-arg assembly + `plugin_config` JSON (device properties).
(end)
