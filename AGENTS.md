# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

TLC — a VS Code extension providing inline (ghost text) code completions from any
OpenAI-compatible server, using FIM (fill-in-the-middle) prompt templates.
Single-line suggestions only; completions are streamed from the legacy
`POST /v1/completions` endpoint.

## Commands

```bash
npm run compile       # esbuild bundle → dist/extension.js (required before F5 / integration tests)
npm run compile-tests # tsc -p tsconfig.test.json → out/test/
npm run check-types   # tsc --noEmit
npm run unit          # vitest unit tests (fast, no VS Code)
npm run test          # unit + bundle + compile-tests + @vscode/test-electron integration tests
npm run coverage      # vitest --coverage
npm run lint          # eslint src
npm run build         # test + lint (what CI runs)
npm run package       # compile + icon regen + vsce package → .vsix
```

Run `check-types` and `unit` after every change; they are quick. On Windows
(PowerShell) do not chain commands with `&&`.

## Architecture

Entry point: `src/extension.ts` (wires everything; the only file importing `vscode`
besides `config.ts`, `status_bar.ts`, `api_key_storage.ts` and the integration
tests). Core logic lives in dependency-injected classes that do **not** import
`vscode` — this is what keeps them unit-testable with vitest (unit tests run in
plain Node; `vscode` is stubbed in `src/test/unit/vscode-stub.ts`).

| Module | Responsibility |
| --- | --- |
| `extension.ts` | Activation, commands, settings-change wiring, template-field sync, startup validation |
| `config.ts` | Reads `tlc.*` settings into `ExtensionConfig`; `effectiveContextLengths()` clamps prefix/suffix budgets to `contextMaxLength` |
| `model_config.ts` | `ModelConfig`: applies `/v1/models` lists, persists model + context limit, clamps budgets; host callbacks (`updateSetting`, `chooseModel`, `onModelChanged`, …) isolate it from VS Code |
| `model_selection.ts` | `pickSupportedModel` (family substrings) and `pickTemplateForModel` (model → built-in template id) |
| `model_polling.ts` | Poll interval constant and `modelIdsKey` (change detection for `/v1/models`) |
| `completions_client.ts` | OpenAI SDK wrapper: `/v1/models`, streaming FIM request, stop-token cut, loop detection, line truncation, error classification (`auth`/`connection`/`other`) |
| `completion_provider.ts` | `InlineCompletionItemProvider`: debounce, manual trigger, cache, pending-request grace, forbidden files |
| `templates/` | `TemplateRegistry`, built-ins (qwen2, qwen3, lfm2, mellum), custom template compiled from the marker settings |
| `prompt.ts` | FIM rendering and reserved-token masking in user code |
| `forbidden_files.ts` | Glob matching (micromatch) of files where completions are disabled |
| `connection_watchdog.ts` | Probes the server, pauses/re-enables completions |
| `status_bar.ts` | Status item; **click toggles completions** (`tlc.enableDisableCompletions`) |

## Launch and debug

Debug with F5 (Run Extension): esbuild's watch is wired through
`npm run watch`. Integration tests require `npm run compile` (the bundled
`dist/extension.js`) plus the compiled tests (`npm run compile-tests`) and
smoke-test against the stub server in `src/test/integration` — no real
completion backend is needed.

## Behavioral rules (keep docs in sync!)

When changing behavior, update `README.md` **and** the setting descriptions in
`package.json` — past bugs were exactly README/description drift. Key invariants:

- **Template fields** (`tlc.prefix/suffix/middle/stop`): used only when
  `tlc.promptTemplate` is `custom`. Editing any field switches the selection to
  `custom`; selecting a built-in *clears* the stored fields (they revert to
  defaults) — it does **not** copy built-in markers into them.
- **Template follows the model family**: when the model actually changes
  (startup, `tlc.baseUrl` change, `TLC: Select Model`), the prompt template is
  switched to the matching built-in (`pickTemplateForModel`) — unless the user
  chose `custom`. Implemented via the `onModelChanged` host callback; don't
  bypass `ModelConfig.setModel`.
- **Model lists**: one model on the server → applied automatically; several and
  the configured model is present → kept; otherwise the picker is shown. Manual
  selection always wins. There is **no** "auto-pick first supported model".
  The list is polled every 30 s (`model_polling.ts`) and via the
  `TLC: Test Connection` command; the picker/auto-apply run **only when the
  list changed** since the last check (`modelIdsKey`), so a dismissed picker is
  not re-shown every poll.
- **Context limit**: `tlc.contextMaxLength` is filled from `/v1/models` metadata;
  prefix/suffix budgets are re-clamped proportionally (priority to the prefix).
- API key: preferred home is VS Code secret storage (`TLC: Set API Key`);
  the plaintext `tlc.apiKey` setting **overrides** it when non-empty
  (priority is resolved in `effectiveApiKey`/`syncApiKey` in `extension.ts`).
- Suggestions are single-line: truncate at the first newline and strip reserved
  tokens; they must never leak into the inserted text.

## Conventions

- **Comments**: default to **no comments**. Write code that explains itself;
  add a comment only when the code cannot convey non-obvious *why* — invariants,
  workarounds, platform quirks, external-command behavior. Never comment:
  - what the next line obviously does ("//log", "// Trigger event", "// Create X");
  - JSDoc restating parameter names/types on trivial functions;
  - section markers, TODO-free narration, alternatives that were not chosen.
  If a block needs an explaining comment, first try renaming or extracting a
  well-named helper instead. When editing code, delete nearby comments that
  became redundant. Tests follow the same rule: assertion names and structure
  should make the intent clear without commentary.
- TypeScript strict mode, CommonJS sources bundled by esbuild; unit tests run
  directly on TS sources by vitest — no build step for them.
- Constructors take a "host" interface (functions/ports) instead of importing
  `vscode` — follow this pattern for new logic that needs testing.
- Tests live next to a mirror structure in `src/test/unit/*.test.ts` (vitest)
  and `src/test/integration/` (real VS Code via `@vscode/test-electron`, uses
  `stub_server.ts`). Prefer adding a unit test for any new branch.
- Warnings go through the injected `log` (TLC output channel), user-facing
  messages through `notify`/`showInformationMessage`.
- `README.md` is English; keep it accurate against `package.json` (commands,
  defaults, descriptions must match `contributes`).
