# Proposal (future — not scheduled)

> **Status: backlog.** This change is a design placeholder for a native OpenVINO GenAI runner. Do not start it until the `local-engine-mode` change (llama.cpp-based) is archived, and only if native-IR performance on NPU proves to matter.

## Why

The current local engine path (llama.cpp OpenVINO build + GGUF) converts GGUF to an OpenVINO graph at load time. Quantization is llama.cpp's (Q4_K_M), not NNCF-tuned. A runner built directly on OpenVINO GenAI can load native OpenVINO IR models (int4, NNCF-optimized, e.g. from the `OpenVINO/*` HuggingFace org), which may give better NPU utilization and time-to-first-token on Intel NPUs.

## What Changes

- Replace (or offer alongside) the llama.cpp server with a **native OpenVINO GenAI runner** that:
  - loads OpenVINO IR models (`OpenVINO/Qwen2.5-Coder-*` int4-ov) directly;
  - exposes the same OpenAI-compatible `/v1/completions` contract the extension's client expects (streaming, FIM stop tokens) — implemented by the runner itself;
  - uses the configurable model cache directory for the loaded pipeline state.
- Distribution question to resolve: the runner cannot be a downloaded llama.cpp zip; it must ship as a bundled binary or an npm-native dependency per platform — a significantly larger packaging matrix.
- Device selection (CPU/GPU/NPU via `OPENVINO_DEVICE` or the GenAI device string) and the reset/directory settings are reused unchanged.

## Capabilities

### New Capabilities

- `openvino-genai-runner`: native model runtime using OpenVINO GenAI with OpenVINO IR models.

### Modified Capabilities

- `local-engine-setup`: a second engine kind (runner binary + IR model download) selectable per platform.
- `local-engine-runtime`: device selection and lifecycle for the alternative runner.

## Impact

- New runner component (own process), new packaging/publishing pipeline for platform binaries, new model source (HuggingFace `OpenVINO/*` int4-ov repos).
- Risk: maintaining a custom OpenAI-compatible server duplicates llama-server behavior (streaming, stop tokens, health). Only justified by measurable NPU wins.

---

## Note: MLX on macOS (answered, no change)

MLX models (safetensors for Apple's MLX framework, e.g. `mlx-community/*`) are **not** loadable by llama.cpp — same situation as OpenVINO IR: llama.cpp uses GGUF with the Metal backend on macOS. Native MLX would require a separate runner (mlx-lm server), i.e. the same architecture change as above. If NPU-first users ever want it, it belongs in this same future runner abstraction ("swappable local runtime"), not in the current change.
