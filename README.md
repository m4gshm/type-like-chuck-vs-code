# Type like Chuck (TLC)

*Type like Chuck — one more AI autocomplete tool.*

Universal inline (ghost text) code completions from any OpenAI-compatible API, with configurable fill-in-the-middle (FIM) prompt templates. Works in files of any language.

## Features

- **Automatic trigger** — completions are requested after you stop typing (debounce, default 250 ms).
- **Manual trigger** — run `TLC: Trigger Completion Now` (default `Ctrl+Alt+Space` or `Alt+\`) to request a completion immediately; it always performs a fresh API request, ignoring the cache and any pending request. When Type like Chuck is disabled or yielding to Copilot, the same keys trigger the suggestion (e.g. Copilot's) directly.
- **Built-in FIM templates** for Qwen2.5-Coder and Mellum (JetBrains), plus user-defined custom templates.
- **Local engine mode** — no external server needed: TLC downloads a llama.cpp build and a Qwen2.5-Coder GGUF model (0.5B / 1.5B / 3B) on first use and starts its own local server. Two build flavors, chosen by the requested device: a **vulkan build** (GPU via NVIDIA/AMD/Intel + CPU fallback) and an **openvino build** (Windows/Linux x64) that runs the same GGUF on the **Intel NPU** via the NPUW backend — no separate IR model download. A platform probe picks the best device at startup (NPU when present, GPU when a CUDA device answers, CPU otherwise); failed accelerated starts fall back to CPU.
- **OpenVINO GenAI runner (`ovgenai` engine kind)** — an alternative local engine for Windows/Linux x64: a small runner binary bundled with the extension (no engine download) speaking NDJSON over stdin/stdout (no ports, no HTTP, no keys), loading native **OpenVINO IR** models (Qwen2.5-Coder int8-ov, ~0.5/1.6/3.1 GB) with NNCF int8 weights, and running on CPU, Intel Arc (GPU) or the Intel NPU. The OpenVINO runtime libraries (~130–250 MB per platform) are downloaded on first use into the engine directory. Select it with `tlc.local.engineKind: "ovgenai"`.
- **MLX runner (`mlx` engine kind)** — the local engine for **macOS arm64**: a small Swift runner binary bundled with the extension speaking the same NDJSON stdio protocol, loading **MLX 4-bit** models (`mlx-community` Qwen2.5-Coder, ~0.4/1.0/1.9 GB) on Metal. The binary is self-contained (MLX statically linked, Metal is a system framework) — no engine or runtime downloads at all. Select it with `tlc.local.engineKind: "mlx"`.
- **Streaming** requests against the legacy OpenAI `POST /v1/completions` endpoint with stop sequences derived from the template's reserved tokens.
- **Single-line suggestions** that accept with <kbd>Tab</kbd> and dismiss with <kbd>Esc</kbd> via VS Code's native inline suggestions.
- **No duplicated text** — suggestions that repeat the code right after the cursor are not shown.
- **Coexists with GitHub Copilot** — with `tlc.yieldToCopilot` (default), Type like Chuck disables itself and notifies when Copilot's ghost text turns on, and re-enables itself when it turns off.
- **Connection watchdog** — if the server goes unreachable, completions are auto-disabled with a warning and come back automatically when the server responds.
- **Automatic model tracking** — the server's `/v1/models` list is checked regularly: a changed model is picked up automatically and the prompt template follows its family (unless `custom`). Run `TLC: Test Connection` to check the server and load the model list immediately.
- **Safe by default** — the recommended key storage is VS Code secret storage (`TLC: Set API Key`); the optional `tlc.openai.apiKey` setting (plaintext, for synced settings) takes precedence when set, and completions are disabled in files such as `.env`.

## Setup

1. Install the extension (F5 in this repository, or install the packaged `.vsix`).
2. Pick the completion source with `TLC: Select Mode`:
   - **Local engine** (default): nothing else is required — the engine and the model are downloaded on first use (about 0.4–2 GB). Pick the model with `TLC: Select Local Model` and the device (auto/GPU/CPU, opt-in NPU) with `TLC: Select Local Device`. GPU acceleration uses the llama.cpp vulkan build (NVIDIA/AMD/Intel). The NPU is opt-in (`device: npu`, Intel Core Ultra with the NPU driver): it uses the llama.cpp openvino build, each start compiles the graph (~15 s, no on-disk compile cache), and it is not recommended as the default device.
   - **Remote**: set `tlc.openai.baseUrl` to your OpenAI-compatible server (e.g. LM Studio, llama.cpp, vLLM, Ollama) and `tlc.openai.model` to the loaded model.
3. Pick `tlc.promptTemplate` matching your model family (`qwen2`, `qwen3`, `lfm2`, `mellum`, or `custom`) — in local mode the template follows the Qwen2.5-Coder models automatically.
4. Remote mode: run `TLC: Select Model` to pick from the models your server exposes via `GET /v1/models`; if your server needs authentication, run `TLC: Set API Key`.

## Security

In local mode the local engine is reached only via the loopback interface with a randomly generated per-session key (never persisted), so other processes on the machine cannot use it. The resolved engine/model/cache directories are written to the TLC output channel; change them via `tlc.local.engineDir` / `tlc.local.modelDir` (existing downloads are moved to the new location). `TLC: Reset Local Engine` re-downloads the engine or the model, or clears the cache. At startup TLC probes the platform (local GPU acceleration on Windows/Linux/macOS → none) and suggests the matching device with a reason; the suggestion is always shown until `tlc.local.device` is explicitly chosen (Apply Recommendation, `TLC: Select Local Device`, or a stored setting) or the offer is dismissed ("Don't Ask Again").

## Commands

| Command | Description |
| --- | --- |
| `TLC: Trigger Completion Now` | Request a completion immediately, bypassing the debounce, the cache, and pending-request reuse |
| `TLC: Select Mode` | Switch between the local engine and a remote server |
| `TLC: Select Local Model` | Pick the local engine model: 0.5B / 1.5B / 3B |
| `TLC: Select Local Device` | Pick the inference device: auto / GPU / CPU (opt-in: NPU) |
| `TLC: Reset Local Engine` | Re-download the engine or the model, or clear the cache |
| `TLC: Test Connection` | Check that `tlc.openai.baseUrl` is reachable, fetch `/v1/models` and apply the model list (remote mode) |
| `TLC: Select Model` | Pick a model from the server's `GET /v1/models` list (or enter an id manually); supported-family models are marked with a check (remote mode) |
| `TLC: Set API Key` | Store the API key in secret storage (empty input clears usage) |
| `TLC: Clear API Key` | Remove the stored API key |
| `TLC: Enable/Disable Completions` | Enable/disable completions for this workspace (persisted). Also available by clicking the Type like Chuck item in the status bar; while the server is unreachable, the click retries the connection instead |

## Settings

### Mode and local engine

| Setting | Default | Description |
| --- | --- | --- |
| `tlc.mode` | `local` | Completion source: `local` (TLC-managed engine: llama.cpp or OpenVINO GenAI) or `remote` (OpenAI-compatible server at `tlc.openai.baseUrl`) |
| `tlc.local.engineKind` | `mlx` on macOS arm64, `llama.cpp` elsewhere | Local engine implementation (local mode): `llama.cpp` (llama-server + GGUF, all platforms), `ovgenai` (bundled OpenVINO GenAI runner + IR models, Windows/Linux x64, NPU/GPU/CPU) or `mlx` (bundled MLX runner + 4-bit models, macOS arm64, Metal) |
| `tlc.local.model` | `1.5b` | Local engine model (local mode): `0.5b`, `1.5b` or `3b` (Qwen2.5-Coder; GGUF for llama.cpp, OpenVINO IR int8 for ovgenai, MLX 4-bit for mlx) |
| `tlc.local.device` | `auto` | Local engine inference device: `auto` (NPU → GPU → CPU), or `cpu`, `gpu`, `npu`; a failed accelerated start falls back to CPU |
| `tlc.local.npuContextMaxLength` | `8192` | Context window used on the NPU (local mode only). The NPU graph is compiled for this window: a smaller window compiles faster, generates faster and needs less memory; it also caps the prefix/suffix prompt budgets when the NPU is used. `0` uses the model's full context |
| `tlc.local.llamaCppRelease` | `b11935` | llama.cpp release tag used for the engine download (vulkan build for GPU/CPU, openvino build for NPU) |
| `tlc.local.engineBinary` | `""` | Path to a locally unpacked llama-server binary used instead of downloading (empty = download) |
| `tlc.local.distroDir` | `""` | Locally unpacked engine distribution used instead of downloading: an OpenVINO GenAI runtime folder for the ovgenai kind, or an unpacked llama.cpp build for llama.cpp (ignored by mlx; empty = download) |
| `tlc.local.engineDir` | `""` | Directory for the downloaded engine (empty = extension storage; changing it moves the engine) |
| `tlc.local.modelDir` | `""` | Directory for the downloaded models (empty = extension storage; changing it moves the models) |
| `tlc.local.modelCacheDir` | `""` | Directory for the NPU compiled-blob cache (`GGML_OPENVINO_COMPILED_MODEL_CACHE_DIR`) — NPU starts after the first one are much faster (empty = extension storage) |
| `tlc.local.modelPath` | `""` | Path to a local model file to use instead of downloading (empty = download): a GGUF file for llama.cpp, an IR `.xml` (with its `.bin` alongside) or model directory for ovgenai, an mlx model directory for mlx |
| `tlc.local.modelUrls` | `{}` | Per-model download URL overrides, keyed by model id (`{ "1.5b": "https://mirror/.../model.gguf" }`); for the ovgenai kind, key individual IR files as `1.5b/openvino_model.bin` |
| `tlc.local.huggingfaceUrl` | `https://huggingface.co` | Base URL for model downloads (local mode only; change to a mirror) |
| `tlc.local.githubUrl` | `https://github.com` | Base URL for llama.cpp release downloads (local mode only; change to a mirror) |
| `tlc.local.openvinoUrl` | `https://storage.openvinotoolkit.org` | Base URL for the OpenVINO GenAI runtime download used by the ovgenai engine (local mode only; change to a mirror) |
| `tlc.local.apiKeyEnabled` | `true` | Require the per-session key from engine clients. Turn off only to debug the engine directly with curl |

### Remote server

| Setting | Default | Description |
| --- | --- | --- |
| `tlc.openai.baseUrl` | `http://127.0.0.1:1234/v1` | Base URL of the OpenAI-compatible API. Saving a new value (Enter/blur) acts like `TLC: Test Connection`: the server is probed and the model list applied |
| `tlc.openai.model` | `Qwen2.5-Coder-1.5B` | Model name sent in requests |
| `tlc.openai.apiKey` | `""` | Optional API key (plaintext, e.g. for synced settings). Takes precedence over the secret-stored key when non-empty |

### Trigger, cache and context

| Setting | Default | Description |
| --- | --- | --- |
| `tlc.prefixContextMaxLength` | `8000` | Max characters of code before the cursor |
| `tlc.suffixContextMaxLength` | `2000` | Max characters of code after the cursor |
| `tlc.contextMaxLength` | `0` | Max combined prefix+suffix context (characters); filled automatically from `/v1/models`, `0` = unlimited |
| `tlc.maxTokens` | `256` | Max tokens to generate |
| `tlc.autoTrigger` | `true` | Trigger completions automatically after a typing pause |
| `tlc.debounceMs` | `250` (50–1000) | Pause before an automatic request is sent |
| `tlc.pendingGraceMs` | `150` (0–1000) | How long typing past a pending request waits for its result before requesting afresh |
| `tlc.cacheEnabled` | `true` | Re-serve the last completion without a new API request: at the exact cursor position, and when the typed text extends it along the same line as its prefix (the remainder is served) |
| `tlc.cacheTtlMs` | `10000` (≥1000) | Lifetime of the cached completion |
| `tlc.yieldToCopilot` | `true` | When GitHub Copilot inline completions turn on (detected via the installed `GitHub.copilot` extension, its `github.copilot.enable` per-language setting and `github.copilot.inlineSuggest.enable` ghost-text switch), TLC disables itself and notifies; when Copilot turns off, TLC re-enables itself — but only if it was disabled by this auto-reaction, not by the user. A manual toggle always wins |
| `tlc.forbiddenFileNames` | `[".env"]` | Globs of files where completions are disabled |

All settings apply live. On startup and whenever `tlc.openai.baseUrl` changes, the configured model is validated against the server's `/v1/models` list: a single-model server applies that model automatically; on multi-model servers the configured model is kept when present, otherwise the picker is shown (a model from a supported family — partial match: qwen, mellum, ... — is marked with a check). While the extension runs, the list is re-checked regularly, so server-side model changes are picked up automatically too. Manual selection via `TLC: Select Model` or `tlc.openai.model` always wins afterwards. Local mode never contacts the remote server.

## Custom FIM templates

The markers are shown in the Prefix / Suffix / Middle / Stop settings and can be edited there directly (no JSON editing needed):

- **Prefix / Suffix / Middle** - the FIM markers
- **Stop** - reserved tokens, comma-separated (sent as stop sequences and masked in your code)

All fields apply live. The fields and the selection stay in sync: selecting a built-in template in `tlc.promptTemplate` clears the stored marker fields (they revert to their defaults, since the built-in markers are used directly); editing any of them switches `promptTemplate` to `custom`. If the fields are unusable, the default template is used with a warning in the TLC output channel.

- `prefix`, `suffix`, `middle` are the FIM markers placed around the code context.
- `stop` lists reserved tokens: they are sent as API stop sequences and masked inside your own code so the model is not confused by them.
- When the model changes (startup, `tlc.openai.baseUrl` change, `TLC: Select Model`) and a built-in template matches the new model's family better than the selected one, the selection is switched automatically — unless `promptTemplate` is `custom`.
- Custom template names that collide with built-ins are ignored; an unknown `tlc.promptTemplate` falls back to the default template with a warning in the TLC output channel.

## Debugging

The TLC output channel shows the engine's own log lines (`llama-server: …`) at the **Trace** level — set the channel filter to Trace to see them, including NPU compile progress on the openvino build.

## Building and testing

```bash
npm ci
npm run compile      # esbuild bundle → dist/extension.js
npm run check-types  # tsc --noEmit
npm run unit         # unit tests (vitest)
npm run coverage     # unit tests + coverage report
npm test             # unit + bundle + integration tests (@vscode/test-electron)
npm run lint         # eslint src
npm run build        # test + lint (what CI runs)
npm run package      # compile + icon regen + vsce package → .vsix
```

### Building the OpenVINO GenAI runner (backend)

The C++ `ovgenai` runner lives in its own repository:
[`type-like-chuck-backed-openvino`](https://github.com/m4gshm/type-like-chuck-backed-openvino).
It is built with [go-task](https://taskfile.dev) and produces release-named
binaries in its `build/` directory; its CI (`.github/workflows/runner.yml`
there) smoke-tests the binaries on windows-latest/ubuntu-latest and publishes
them as GitHub release assets on `v*` tags.

The plugin does not build the backend — it only imports the binaries:

```bash
task -t tasks.yaml runner:import  # local: build & copy from ../type-like-chuck-backed-openvino/build
task -t tasks.yaml runner:fetch   # CI: download from the backend repo's latest release
                                  # (pin a version via RUNNER_VERSION=<tag> or the RUNNER_VERSION var in tasks.yaml)
task -t tasks.yaml package        # full .vsix, importing the binaries if missing
```

They land in `binaries/ovgenai/<platform>/` (plus `binaries/mlx/darwin-arm64/`
for the MLX runner, imported from
[`type-like-chuck-backed-mlx`](https://github.com/m4gshm/type-like-chuck-backed-mlx))
— the layout the installed
extension resolves via `${extensionPath}/binaries/ovgenai/…` — and
`.github/workflows/package.yml` re-verifies that the binaries launch from the
unpacked `.vsix`. Mac is not an ovgenai target: the ovgenai runner binary is
only produced for Windows x64 and Linux x64 (the mlx runner covers macOS
arm64).

Debug with F5 (Run Extension); in local mode the extension manages its own engine, in remote mode smoke-test against a local OpenAI-compatible server such as LM Studio.

## Credits

Extension icon: ["Cowboy" by Robin Lopez from the Noun Project](https://thenounproject.com/icon/cowboy-6661201/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## License

Apache-2.0
