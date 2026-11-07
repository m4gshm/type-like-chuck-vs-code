# Type like Chuck (TLC)

*Type like Chuck — one more AI autocomplete tool.*

Inline (ghost text) code completions from any OpenAI-compatible API, with configurable fill-in-the-middle (FIM) templates. Local engine mode runs everything on your machine — no external server needed.

## Features

- **Local engine (default)** — TLC downloads a Qwen2.5-Coder model (0.5B / 1.5B / 3B) plus an engine; when the configured model is not downloaded yet, a picker offers the whole catalog with sizes before anything is downloaded:
  - `llama.cpp` — vulkan build, GGUF models, GPU (NVIDIA/AMD/Intel) + CPU fallback;
  - `ovgenai` — OpenVINO GenAI runner with native IR (nf4) models for Windows/Linux x64 and Linux arm64: CPU/GPU/Intel NPU (NF4 models favor low memory, the runtime libraries are downloaded on first use);
  - `mlx` — macOS arm64 only: MLX 4-bit models on Metal, self-contained, no downloads.
- **Remote mode** — any OpenAI-compatible endpoint (LM Studio, llama.cpp, vLLM, Ollama), `GET /v1/models` is polled so server-side model changes are picked up, and the template follows the model family.
- **Automatic + manual trigger** — completions after a typing pause (250 ms) or immediately on `Ctrl+Alt+Space` / `Alt+\` (bypasses the cache and pending reuse).
- **Duplicate-aware suggestions** — a suggestion that repeats the line right below the cursor is dropped; one that mostly re-states that line is offered as a quick fix (`Ctrl+.`) inserting just the difference into it, so accepting never duplicates code that already exists.
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

## Runner protocol (local engines)

Both native runners — the OpenVINO GenAI runner ([type-like-chuck-backed-openvino](https://github.com/m4gshm/type-like-chuck-backed-openvino)) and the MLX runner ([type-like-chuck-backed-mlx](https://github.com/m4gshm/type-like-chuck-backed-mlx)) — speak the same NDJSON stdio protocol; each README documents its runner-specific spawn options.

The extension spawns `tlc-ovgenai-runner --model <dir> --device CPU|GPU|NPU [--ctx N] [--prop KEY=VALUE ...]` or `tlc-mlx-runner --model <dir> [--ctx N]` and exchanges newline-delimited JSON over stdin/stdout. On GPU/CPU a start that does not reach `ready` in 10 minutes fails; on NPU there is no wall-clock limit (the first graph compilation can take tens of minutes), but a silent runner produces no compiler output — 30 minutes of stderr silence kills the runner and falls through the device chain.

Events on stdout (one JSON object per line):
- `{"type":"version","app":"..."}` in response to `--version` (exit 0, no model load);
- `{"type":"ready","model":...,"device":...,"ctx":N}` after the model loads;
- `{"type":"token","text":"..."}` per generated piece (no id — only one generation is active);
- `{"type":"done","id":N,"finishReason":"stop"|"length"|"cancel"}`;
- `{"type":"error","id":N|null,"message":"..."}`.

Requests on stdin:
- `{"type":"generate","id":N,"prompt":"...","maxTokens":N,"stop":[...]}` — generate requests are queued and served one at a time in arrival order;
- `{"type":"cancel","id":N}` — cancels the active generation, or a queued one by id (the cancelled queued request is answered immediately with `finishReason:"cancel"`);
- `{"type":"shutdown"}` — drains the queue answering every pending request with `finishReason:"cancel"`, cancels the active generation and exits.

Logs go to stderr only; a failed generation is reported with a single `error` event (no `done` follows). Exit codes: 0 = normal, 1 = model load failure, 2 = usage/loader error.

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

The `ovgenai` C++ runner lives in the [`type-like-chuck-backed-openvino`](https://github.com/m4gshm/type-like-chuck-backed-openvino) submodule, the Swift `mlx` runner in the [`type-like-chuck-backed-mlx`](https://github.com/m4gshm/type-like-chuck-backed-mlx) submodule; the extension only imports release-named binaries via:

```bash
git submodule update --init   # one-time: fetch the backend submodules
task runner:import   # local: build & copy from the backend submodules
task runner:fetch    # download from the backend releases (RUNNER_VERSION=<tag> pins)
task package         # full .vsix
```

They land in `binaries/ovgenai/<platform>/` and `binaries/mlx/darwin-arm64/` — the layout the installed extension resolves; `package.yml` re-verifies that the binaries launch from the unpacked `.vsix`.

Debug with F5 (Run Extension).

## Credits

Extension icon: ["Cowboy" by Robin Lopez from the Noun Project](https://thenounproject.com/icon/cowboy-6661201/), CC BY 4.0.

## License

Apache-2.0
