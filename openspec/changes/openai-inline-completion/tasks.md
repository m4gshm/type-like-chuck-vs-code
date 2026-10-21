# Tasks

## 1. Scaffold

- [x] 1.1 Create extension scaffold: `package.json` (publisher, `engines.vscode ^1.97.0`, activation `onStartupFinished`, contributes: configuration `l8t.*`, commands `triggerCompletion`, `setApiKey`, `clearApiKey`, `toggleCompletions`, default keybinding for trigger), `tsconfig.json`, `esbuild.js`, `.vscodeignore`, and a `launch.json` for F5 debugging; verify `npm install` and `npm run compile` succeed
- [x] 1.2 Add dependencies (`openai`, `micromatch`) and dev dependencies (`typescript`, `esbuild`, `@types/vscode`, `@vscode/test-electron`); verify `npm run compile` produces `out/extension.js`

## 2. FIM templates

- [x] 2.1 Define the `FimTemplate` type (`id`, `reservedTokens`, `render(prefix, suffix)`) and a template registry in `src/templates/`; verify with a unit test that registering and looking up templates works
- [x] 2.2 Implement built-in templates `qwen2.5`, `qwen3`, `lfm2`, `mellum` with verified FIM markers and reserved token lists; verify unit tests render expected prompts for sample prefix/suffix (e.g. qwen2.5 → `<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>`)
- [x] 2.3 Implement compiling user-defined custom templates from settings (`{ prefix, suffix, middle, stop? }`) into `FimTemplate` objects, and invalid/unknown selection falling back to the default with a warning; verify with unit tests for a valid custom template, an invalid one, and an unknown id

## 3. Prompt building

- [x] 3.1 Implement context extraction: prefix/suffix around the cursor with truncation to configured `prefixMaxLength` / `suffixMaxLength`; verify with unit tests on a synthetic long document
- [x] 3.2 Implement reserved-token masking of prefix/suffix text (insert space after first char of masked tokens) while keeping structural markers intact; verify with a unit test where user code contains a reserved token

## 4. API client

- [x] 4.1 Implement the completions client using the `openai` SDK: configurable `baseUrl`, `model`, `maxTokens`, streaming with `AbortSignal`; verify with a unit test against a stubbed server/response that chunks accumulate and abort discards results
- [x] 4.2 Implement single-line truncation (cut at first newline after leading whitespace) and empty-result handling; verify with unit tests for multi-line output, whitespace-only output, and normal output
- [x] 4.3 Implement API key secret storage (`setApiKey`/`clearApiKey` commands, key included when present) and error mapping: 401 → prompt for key, connection errors → non-blocking warning via output channel; verify each path with a stubbed client

## 5. Completion provider

- [x] 5.1 Implement `InlineCompletionItemProvider` registered for all files, returning an `InlineCompletionItem` for the completion text; verify with an integration test (`@vscode/test-electron`) that ghost text appears against a stubbed API
- [x] 5.2 Implement rate-limit debounce (timestamp-based, `debounceMs` default 250, configurable min/max) and the pending-request reuse window (~1000 ms) for same-line continued typing; verify with unit tests using fake timers
- [x] 5.3 Implement cancellation via `AbortController` on line change, backward cursor move, document change beyond position, config/state change, and disable; verify with an integration test
- [x] 5.4 Implement `activeCompletion` cache with prefix-match validity so prefix typing re-serves the same suggestion without an API call; verify with a unit test counting API calls

## 6. Manual trigger, state, and status bar

- [x] 6.1 Implement the `triggerCompletion` command that bypasses the throttle and fires the inline suggest trigger, with the default keybinding from `package.json`; verify manually via F5 that the shortcut produces ghost text immediately
- [x] 6.2 Implement enable/disable toggle persisted in `globalState` plus the status bar indicator reflecting state and errors; verify toggling stops provider requests and the indicator updates

## 7. File gating and settings

- [x] 7.1 Implement forbidden-file gating with micromatch globs (default `[".env"]`) and `onDidChangeConfiguration` handling so all settings apply live; verify with a unit test for glob matching and a manual check that a settings change takes effect without reload

## 8. End-to-end verification

- [x] 8.1 Add README documenting setup, all settings, built-in/custom templates, and commands; verify every documented setting name matches `package.json` contributes
- [x] 8.2 Run full integration test suite via `npm test` (`@vscode/test-electron`) covering: debounced trigger, manual trigger, accept via Tab, cancel on cursor move, forbidden file, 401 flow; verify all pass
- [ ] 8.3 Manual smoke test against a local OpenAI-compatible server (e.g. LM Studio) with each built-in template: completions render correctly and stops do not leak markers; record any template fixes


