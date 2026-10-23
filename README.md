# TLC — Type like Chuck

*Type like Chuck — one more AI autocomplete tool.*

Universal inline (ghost text) code completions from any OpenAI-compatible API, with configurable fill-in-the-middle (FIM) prompt templates. Works in files of any language.

## Features

- **Automatic trigger** — completions are requested after you stop typing (debounce, default 250 ms).
- **Manual trigger** — run `TLC: Trigger Completion Now` (default `Ctrl+Alt+Space`) to request a completion immediately.
- **Built-in FIM templates** for Qwen2.5, Qwen3, LFM2 (Liquid AI) and Mellum (JetBrains), plus user-defined custom templates.
- **Streaming** requests against the legacy OpenAI `POST /v1/completions` endpoint with stop sequences derived from the template's reserved tokens.
- **Single-line suggestions** that accept with <kbd>Tab</kbd> and dismiss with <kbd>Esc</kbd> via VS Code's native inline suggestions.
- **Automatic model tracking** — the server's `/v1/models` list is polled every 30 s: a changed model is picked up automatically and the prompt template follows its family (unless `custom`). Run `TLC: Test Connection` to check the server and load the model list immediately.
- **Safe by default** — the recommended key storage is VS Code secret storage (`TLC: Set API Key`); the optional `tlc.apiKey` setting (plaintext, for synced settings) takes precedence when set, and completions are disabled in files such as `.env`.

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
| `TLC: Test Connection` | Check that `tlc.baseUrl` is reachable, fetch `/v1/models` and apply the model list (also updates the template to match the model family) |
| `TLC: Select Model` | Pick a model from the server's `GET /v1/models` list (or enter an id manually); supported-family models are marked with a check |
| `TLC: Enable/Disable Completions` | Enable/disable completions for this workspace (persisted). Also available by clicking the TLC item in the status bar; while the server is unreachable, the click retries the connection instead |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `tlc.apiKey` | `""` | Optional API key (plaintext, e.g. for synced settings). Takes precedence over the secret-stored key when non-empty |
| `tlc.baseUrl` | `http://127.0.0.1:1234/v1` | Base URL of the OpenAI-compatible API. Saving a new value (Enter/blur) acts like `TLC: Test Connection`: the server is probed and the model list applied |
| `tlc.model` | `Qwen2.5-Coder-1.5B` | Model name sent in requests |
| `tlc.promptTemplate` | `qwen2` | Built-in template id or `custom` |
| `tlc.prefix` / `tlc.suffix` / `tlc.middle` / `tlc.stop` | see Settings → TLC | Elements of the custom template (used when `promptTemplate` is `custom`) |
| `tlc.prefixContextMaxLength` | `8000` | Max characters of code before the cursor |
| `tlc.suffixContextMaxLength` | `2000` | Max characters of code after the cursor |
| `tlc.contextMaxLength` | `0` | Max combined prefix+suffix context (characters); filled automatically from `/v1/models`, `0` = unlimited |
| `tlc.maxTokens` | `256` | Max tokens to generate |
| `tlc.autoTrigger` | `true` | Trigger completions automatically after a typing pause |
| `tlc.debounceMs` | `250` (50–1000) | Pause before an automatic request is sent |
| `tlc.pendingGraceMs` | `150` (0–1000) | How long typing past a pending request waits for its result before requesting afresh |
| `tlc.cacheEnabled` | `true` | Re-serve the last completion without a new API request: at the exact cursor position, and when the typed text extends it along the same line as its prefix (the remainder is served) |
| `tlc.cacheTtlMs` | `10000` (≥1000) | Lifetime of the cached completion |
| `tlc.forbiddenFileNames` | `[".env"]` | Globs of files where completions are disabled |

All settings apply live. On startup and whenever `tlc.baseUrl` changes, the configured model is validated against the server's `/v1/models` list: a single-model server applies that model automatically; on multi-model servers the configured model is kept when present, otherwise the picker is shown (a model from a supported family — partial match: qwen, mellum, lfm, ... — is marked with a check). While the extension runs, the list is re-checked every 30 s, so server-side model changes are picked up automatically too. Manual selection via `TLC: Select Model` or `tlc.model` always wins afterwards.

## Custom FIM templates

The markers are shown in the Prefix / Suffix / Middle / Stop settings and can be edited there directly (no JSON editing needed):

- **Prefix / Suffix / Middle** - the FIM markers
- **Stop** - reserved tokens, comma-separated (sent as stop sequences and masked in your code)

All fields apply live. The fields and the selection stay in sync: selecting a built-in template in `tlc.promptTemplate` clears the stored marker fields (they revert to their defaults, since the built-in markers are used directly); editing any of them switches `promptTemplate` to `custom`. If the fields are unusable, the default template is used with a warning in the TLC output channel.

- `prefix`, `suffix`, `middle` are the FIM markers placed around the code context.
- `stop` lists reserved tokens: they are sent as API stop sequences and masked inside your own code so the model is not confused by them.
- When the model changes (startup, `tlc.baseUrl` change, `TLC: Select Model`) and a built-in template matches the new model's family better than the selected one, the selection is switched automatically — unless `promptTemplate` is `custom`.
- Custom template names that collide with built-ins are ignored; an unknown `tlc.promptTemplate` falls back to the default template with a warning in the TLC output channel.

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

Debug with F5 (Run Extension) and smoke-test against a local OpenAI-compatible server such as LM Studio.

## Credits

Extension icon: ["Cowboy" by Robin Lopez from the Noun Project](https://thenounproject.com/icon/cowboy-6661201/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## License

Apache-2.0
