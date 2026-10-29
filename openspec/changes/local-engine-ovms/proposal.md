# Proposal

## Why

In the llama.cpp + OpenVINO engine, Qwen2.5-Coder Q4_K_M GGUF fails on NPU with the `WeightlessCacheAttribute` weights-separation exception (upstream llama.cpp issue #25904, open). The OpenVINO GenAI pipeline used inside OpenVINO Model Server (OVMS) runs the model on NPU reliably, and OVMS ships standalone (Docker-free) official builds for Windows and Ubuntu, so it can be added as a second local engine without Docker or Python requirement on the user side.

## What Changes

- New local engine kind `ovms` (OpenVINO Model Server) alongside the existing `llama.cpp` engine, selectable via `TLC: Select Local Engine`.
- TLC downloads the platform-matched standalone OVMS build from GitHub Releases (Windows x64 zip / Ubuntu 22-24 tar.gz by glibc version), version pinned by a new `tlc.local.ovmsVersion` setting.
- TLC downloads the Qwen2.5-Coder OV IR model (`.xml` + `.bin`) from Hugging Face instead of the GGUF file when the OVMS engine is selected.
- TLC writes the OVMS mediapipe config JSON (model path, device, generation properties) and starts `ovms` with `--config_path` / `--rest_port` on loopback, reusing the existing key/auth pattern where OVMS supports it.
- llama.cpp engine loses its OpenVINO-build specifics: the `GGML_OPENVINO_*` env handling, `tlc.local.npuCompileConfig`, the OpenVINO release asset, and the OpenVINO IR/compiled-model cache wiring are removed; the llama.cpp engine continues with standard builds (CPU/GPU), because the NPU path is now owned by the OVMS engine and the platform-probe chain.
- The existing readiness log, progress display (stage labels + byte counts, no `0B`), fallback device chain (NPU → GPU → CPU applies to both engines), and manual curl debugging flag (`tlc.local.apiKeyEnabled`) cover the OVMS engine the same way.

## Capabilities

### New Capabilities
- `local-engine-ovms`: standalone OVMS engine delivery, config generation, lifecycle and remote-mode parity for the second local engine.

### Modified Capabilities
- `local-engine-runtime`: engine kind becomes a selection (`llama.cpp` / `ovms`); device env-var handling, download assets, and template/model source switching must work per engine kind.
- `local-engine-setup`: download/orchestration flow accounts for the OVMS asset set (server build + OV IR model) and new settings.
- `local-engine-mode`: mode entry/exit and local endpoint wiring must operate independently of which engine kind is active.

## Impact

- New `src/local_engine/ovms_*.ts` modules (asset selection, config writer, runner wrapper) plus changes to `engine_manager`, `paths.ts`, `release_assets`, `model_catalog`.
- `package.json`: new settings (`tlc.local.ovmsVersion`, model URL overrides for OV IR), `TLC: Select Local Engine` command if not already generic.
- `README.md` + setting descriptions must be synced (repo rule).
- Dependencies: no new npm deps; downloads reuse existing fetch/downloader utilities. Rate limits and asset filenames per OVMS release become a data dependency to verify at implementation time.
