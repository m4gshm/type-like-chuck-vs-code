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
- **Built-in FIM templates** (Qwen2.5-Coder, Mellum) plus custom markers, editable right in the settings.
- **Safe by default** — API key in secret storage, completions disabled in files like `.env`, and the local engine listens on loopback with a per-session key other processes cannot use.
- **Coexists with Copilot** — with `tlc.yieldToCopilot` TLC disables itself while Copilot's inline suggestions are enabled and re-enables after (a manual toggle always wins).

## Setup

1. Pick the source with `TLC: Select Mode` — **Local engine** (default, everything downloads on first use) or **Remote** (set `tlc.openai.baseUrl`, optionally `TLC: Set API Key`).
2. Local: choose the model with `TLC: Select Local Model` and the device with `TLC: Select Local Device` — the default already matches your platform (see the matrix below).
3. Remote: pick model from `TLC: Select Model`; set `tlc.promptTemplate` if not auto-detected.

## Commands

| Command | What it does |
| --- | --- |
| `TLC: Trigger Completion Now` | Request immediately (no cache, no debounce) |
| `TLC: Select Mode` | Switch local engine ↔ remote server |
| `TLC: Select Model` | Pick the remote model from `/v1/models` |
| `TLC: Select Local Model` | Pick the local model: 0.5B / 1.5B / 3B |
| `TLC: Select Local Device` | Pick the local device: auto / GPU / CPU / NPU |
| `TLC: Reset Local Engine` | Re-download the engine or model, clear the cache |
| `TLC: Test Connection` | Probe `tlc.openai.baseUrl`, apply the model list (remote) |
| `TLC: Set API Key` / `Clear API Key` | Store/remove the key in secret storage |
| `TLC: Enable/Disable Completions` | Toggle per workspace (also via the status bar item) |

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

## Settings

All settings apply live. In local mode nothing contacts any remote server.

| Setting | Default | Description |
| --- | --- | --- |
| `tlc.mode` | `local` | `local` (TLC-managed engine) or `remote` (OpenAI-compatible API) |
| `tlc.local.engineKind` | see matrix above | `llama.cpp` (all platforms), `ovgenai` (Windows/Linux x64, Linux arm64), `mlx` (macOS arm64) |
| `tlc.local.model` | `Qwen2.5-Coder 1.5B` GGUF / IR / MLX per kind | `0.5B` / `1.5B` / `3B` |
| `tlc.local.device` | `auto` | `auto` (see matrix), or `cpu`, `gpu`, `npu` |
| `tlc.local.npuContextMaxLength` | `8192` | Context window used on the NPU; also caps prefix/suffix budgets. `0` = model's full context |
| `tlc.local.llamaCppRelease` | `b11935` | llama.cpp release tag (vulkan build) |
| `tlc.local.distroDir` | `""` | Unpacked engine distribution used instead of downloading (ovgenai runtime / llama.cpp build; ignored by mlx) |
| `tlc.local.engineDir` | `""` | Engine directory (empty = extension storage; moving it relocates the engine) |
| `tlc.local.downloadedModelsDir` | `""` | Models directory (empty = extension storage; moving it relocates) |
| `tlc.local.modelCacheDir` | `""` | Model cache (cleared by `TLC: Reset Local Engine` → Clear model cache) |
| `tlc.local.customModelPath` | `""` | Local model file instead of a download; applies only while `tlc.local.model` is `custom` |
| `tlc.local.modelUrls` | `{}` | Per-model URL overrides (`{ "Qwen2.5-Coder 1.5B": "https://…" }`) |
| `tlc.local.huggingfaceUrl` | `https://huggingface.co` | Model download mirror |
| `tlc.local.githubUrl` | `https://github.com` | llama.cpp release mirror |
| `tlc.local.openvinoUrl` | `https://storage.openvinotoolkit.org` | OpenVINO runtime mirror |
| `tlc.local.apiKeyEnabled` | `true` | Require the per-session key from engine clients (off only for curl debugging) |
| `tlc.openai.baseUrl` | `http://127.0.0.1:1234/v1` | Remote API base URL; changing it re-probes the server |
| `tlc.openai.model` | `Qwen2.5-Coder-1.5B` | Remote model name |
| `tlc.openai.apiKey` | `""` | Plaintext key (synced settings); wins over the secret-stored one |
| `tlc.prefixContextMaxLength` | `8000` | Max characters before the cursor |
| `tlc.suffixContextMaxLength` | `2000` | Max characters after the cursor |
| `tlc.contextMaxLength` | `0` | Max combined context; `0` = filled from `/v1/models` |
| `tlc.maxTokens` | `256` | Max tokens to generate |
| `tlc.autoTrigger` | `true` | Auto-request after a typing pause |
| `tlc.debounceMs` | `250` | Pause before an auto-request |
| `tlc.pendingGraceMs` | `150` | How long typing waits for a pending request |
| `tlc.cacheEnabled` | `true` | Re-serve the last completion (same position or typed extension) |
| `tlc.cacheTtlMs` | `10000` | Cached completion lifetime |
| `tlc.yieldToCopilot` | `true` | Disable TLC while Copilot inline suggestions are enabled; manual toggle wins |
| `tlc.forbiddenFileNames` | `[".env"]` | Globs of files where completions are disabled |

## Custom FIM templates

`tlc.promptTemplate` selects a built-in template (`qwen2`, `qwen3`, `lfm2`, `mellum`) or `custom`. In `custom` mode the FIM markers (prefix/suffix/middle) and `stop` tokens are edited right in the corresponding settings. Selecting a built-in resets the custom fields; editing any of them switches the selection to `custom`. On a model change a better-matching built-in family is applied automatically (unless `custom`); an unknown template id falls back to the default with a warning.

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
