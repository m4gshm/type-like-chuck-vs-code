# TLC — Type like Chuck

*Type like Chuck — one more AI autocomplete tool.*

Universal inline (ghost text) code completions from any OpenAI-compatible API, with configurable fill-in-the-middle (FIM) prompt templates. Works in files of any language.

## Features

- **Automatic trigger** — completions are requested after you stop typing (debounce, default 250 ms).
- **Manual trigger** — run `TLC: Trigger Completion Now` (default `Ctrl+Alt+Space`) to request a completion immediately.
- **Built-in FIM templates** for Qwen2.5, Qwen3, LFM2 (Liquid AI) and Mellum (JetBrains), plus user-defined custom templates.
- **Streaming** requests against the legacy OpenAI `POST /v1/completions` endpoint with stop sequences derived from the template's reserved tokens.
- **Single-line suggestions** that accept with <kbd>Tab</kbd> and dismiss with <kbd>Esc</kbd> via VS Code's native inline suggestions.
- **Safe by default** — the API key is stored in VS Code secret storage, and completions are disabled in files such as `.env`.

## Setup

1. Install the extension (F5 in this repository, or install the packaged `.vsix`).
2. Set `tlc.baseUrl` to your OpenAI-compatible server (default `http://127.0.0.1:1234/v1`, e.g. LM Studio, llama.cpp, vLLM, Ollama).
3. Set `tlc.model` to the model you have loaded.
4. Pick `tlc.promptTemplate` matching your model family (`qwen2`, `qwen3`, `lfm2`, `mellum`, or `custom`).
5. Choose the model: run `TLC: Select Model` to pick from the models your server exposes via `GET /v1/models` — a model from a supported family (Qwen2/Qwen2.5-Coder, Qwen3-Coder, LFM2, Mellum) is preselected by default. Manual entry of any model id remains available (via the picker or the `tlc.model` setting).
6. If your server needs authentication, run `TLC: Set API Key`. Local servers typically need none.

## Commands

| Command | Description |
| --- | --- |
| `TLC: Trigger Completion Now` | Request a completion immediately, bypassing the debounce |
| `TLC: Set API Key` | Store the API key in secret storage (empty input clears usage) |
| `TLC: Clear API Key` | Remove the stored API key |
| `TLC: Select Model` | Pick a model from the server's `GET /v1/models` list (or enter an id manually). Also available by clicking the model name in the status bar |
| `TLC: Toggle Completions` | Enable/disable completions for this workspace (persisted) |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `tlc.baseUrl` | `http://127.0.0.1:1234/v1` | Base URL of the OpenAI-compatible API |
| `tlc.model` | `Qwen2.5-Coder-1.5B` | Model name sent in requests |
| `tlc.promptTemplate` | `qwen2` | Built-in template id or `custom` |
| `tlc.prefix` / `tlc.suffix` / `tlc.middle` / `tlc.stop` | see Settings → TLC | Elements of the custom template (used when `promptTemplate` is `custom`) |
| `tlc.prefixContextMaxLength` | `8000` | Max characters of code before the cursor |
| `tlc.suffixContextMaxLength` | `2000` | Max characters of code after the cursor |
| `tlc.maxTokens` | `256` | Max tokens to generate |
| `tlc.debounceMs` | `250` (50–1000) | Minimum interval between automatic requests |
| `tlc.forbiddenFileNames` | `[".env"]` | Globs of files where completions are disabled |

All settings apply live. When `tlc.baseUrl` changes, the extension automatically selects the first supported model from the new server's `/v1/models` list (partial match: qwen, mellum, lfm, ...); manual selection via `TLC: Select Model` or `tlc.model` always wins afterwards.

## Custom FIM templates

The markers are shown in the Prefix / Suffix / Middle / Stop settings and can be edited there directly (no JSON editing needed):

- **Prefix / Suffix / Middle** - the FIM markers
- **Stop** - reserved tokens, comma-separated (sent as stop sequences and masked in your code)

All fields apply live. The fields and the selection stay in sync: selecting a built-in template in `tlc.promptTemplate` copies its markers into the marker fields; editing any of them switches `promptTemplate` to `custom`. If the fields are unusable, the default template is used with a warning in the TLC output channel.

- `prefix`, `suffix`, `middle` are the FIM markers placed around the code context.
- `stop` lists reserved tokens: they are sent as API stop sequences and masked inside your own code so the model is not confused by them.
- Custom template names that collide with built-ins are ignored; an unknown `tlc.promptTemplate` falls back to the default template with a warning in the TLC output channel.

## Building and testing

```bash
npm install
npm run compile      # esbuild bundle → out/extension.js
npm run unit         # unit tests (vitest)
npm test             # unit + integration tests (@vscode/test-electron)
```

## Credits

Extension icon: ["Cowboy" by Robin Lopez from the Noun Project](https://thenounproject.com/icon/cowboy-6661201/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Debug with F5 (Run Extension) and smoke-test against a local OpenAI-compatible server such as LM Studio.

## License

Apache-2.0
