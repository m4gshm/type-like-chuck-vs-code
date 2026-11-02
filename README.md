# Type like Chuck (TLC)

*Type like Chuck — one more AI autocomplete tool.*

Inline (ghost text) code completions from any OpenAI-compatible API, with configurable fill-in-the-middle (FIM) templates. Local engine mode runs everything on your machine — no external server needed.

## Features

- **Local engine (default)** — TLC downloads a Qwen2.5-Coder model (0.5B / 1.5B / 3B) plus an engine:
  - `llama.cpp` — vulkan build, GGUF models, GPU (NVIDIA/AMD/Intel) + CPU fallback;
  - `ovgenai` — OpenVINO GenAI runner with native IR (nf4) models for Windows/Linux x64 and Linux arm64: CPU/GPU/Intel NPU (NF4 models favor low memory, the runtime libraries are downloaded on first use);
  - `mlx` — macOS arm64 only: MLX 4-bit models on Metal, self-contained, no downloads.
- **Remote mode** — any OpenAI-compatible endpoint (LM Studio, llama.cpp, vLLM, Ollama), `GET /v1/models` is polled so server-side model changes are picked up, and the template follows the model family.
- **Automatic + manual trigger** — completions after a typing pause (250 ms) or immediately on `Ctrl+Alt+Space` / `Alt+\` (bypasses the cache and pending reuse).
- **Built-in FIM templates** (Qwen2.5-Coder) plus custom markers, editable right in the settings.
- **Safe by default** — API key in secret storage, completions disabled in files like `.env`, and the local engine listens on loopback with a per-session key other processes cannot use.
- **Coexists with Copilot** — with `tlc.yieldToCopilot` TLC disables itself while Copilot's inline suggestions are enabled and re-enables after (a manual toggle always wins).

## Setup

1. Pick the source with `Type like Chuck: Select Mode` — **Local engine** (default, everything downloads on first use) or **Remote** (set `tlc.openai.baseUrl`, optionally `Type like Chuck: Set API Key`).
2. Local: choose the model with `Type like Chuck: Select Local Model` and the device with `Type like Chuck: Select Local Device` — the default already matches your platform (see the matrix below).
3. Remote: pick model from `Type like Chuck: Select Model`; set `tlc.promptTemplate` if not auto-detected.

All commands are discoverable in the command palette under the `TLC:` prefix.

## Local engine defaults

Engine kind and device picked by platform (untouched settings):

| Platform / arch | CPU | Kind | Device |
| --- | --- | --- | --- |
| macOS arm64 | Apple Silicon | `mlx` | `gpu` (Metal; the device setting is ignored) |
| macOS x64 | any | `llama.cpp` | `auto` (GPU → CPU) |
| Windows x64 | Intel | `ovgenai` | `auto` → **NPU** on an Intel NPU gen 4+, otherwise GPU → CPU |
| Windows x64 | AMD / other | `llama.cpp` | `auto` (GPU → CPU) |
| Windows arm64 | any | `llama.cpp` | `auto` (no OpenVINO GenAI runtime for this platform) |
| Linux x64 | Intel | `ovgenai` | `auto` → NPU on gen 4+, otherwise GPU → CPU |
| Linux x64 | AMD / other | `llama.cpp` | `auto` (GPU → CPU) |
| Linux arm64 | Intel | `ovgenai` | `auto` (GPU → CPU) |
| Linux arm64 | non-Intel (Ampere, Graviton…) | `llama.cpp` | `auto` (GPU → CPU) |

The NPU part of the `auto` chain (ovgenai only) is decided by Intel NPU generation: gen 4+ (Lunar Lake, Panther Lake, Wildcat Lake, Nova Lake) leads with NPU → GPU → CPU, and the nf4 models + NPU context cap are selected from the first hop; gen 3 and older (Meteor Lake, Arrow Lake) or no NPU stay GPU → CPU. An explicit `npu` in llama.cpp is warned about and resolved to GPU.

A failed accelerated start falls back down the device chain automatically; a start failure that hits CPU doesn't loop.

All settings (keys, defaults, descriptions) live in the Settings UI under `tlc.*` — every one is documented in its `description` field; they all apply live. In local mode nothing contacts any remote server. On startup and whenever the remote base URL changes, the configured model is validated against the server's `/v1/models` list: single-model servers are applied automatically, multi-model servers keep the configured model while it is present. A model from a supported family is marked with a check in `Type like Chuck: Select Model`.

## Custom FIM templates

`tlc.promptTemplate` selects a built-in template for a known model family (MVP focus: Qwen2.5-Coder) or `custom`. In `custom` mode the FIM markers (prefix/suffix/middle) and `stop` tokens are edited right in the corresponding settings. Selecting a built-in resets the custom fields; editing any of them switches the selection to `custom`. On a model change a better-matching built-in family is applied automatically (unless `custom`); an unknown template id falls back to the default with a warning.

## Debugging

The TLC output channel shows the engine's own log lines (`llama-server: …`) at the **Trace** level — set the channel filter to Trace.

## Building and testing

`npm` scripts are what CI runs (full builds without caching); `task` wraps them locally with incremental caching and backend-binary imports:

```bash
npm install
npm run compile      # esbuild bundle → dist/extension.js
npm run check-types  # tsc --noEmit
npm test             # unit + bundle + integration (@vscode/test-electron)
npm run lint         # eslint src
npm run build        # test + lint (what CI runs)
npm run package      # compile + icon regen + vsce package → .vsix
```

The `ovgenai` C++ runner lives in [`type-like-chuck-backed-openvino`](https://github.com/m4gshm/type-like-chuck-backed-openvino), the Swift `mlx` runner in [`type-like-chuck-backed-mlx`](https://github.com/m4gshm/type-like-chuck-backed-mlx); the extension only imports release-named binaries via:

```bash
task runner:import   # local: build & copy from the backend repos
task runner:fetch    # download from the backend releases (RUNNER_VERSION=<tag> pins)
task package         # full .vsix
```

They land in `binaries/ovgenai/<platform>/` and `binaries/mlx/darwin-arm64/` — the layout the installed extension resolves; `package.yml` re-verifies that the binaries launch from the unpacked `.vsix`.

Debug with F5 (Run Extension).

## Credits

Extension icon: ["Cowboy" by Robin Lopez from the Noun Project](https://thenounproject.com/icon/cowboy-6661201/), CC BY 4.0.

## License

Apache-2.0
