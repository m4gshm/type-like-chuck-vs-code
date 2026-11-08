# Design

## Context

Greenfield VS Code extension in this repository; the only existing content is `openspec/`. The reference project is Continue.dev, the most complete open-source analogue: it proves the architecture (VS Code inline completion provider + FIM prompt rendering against OpenAI-compatible local servers). Deviations drive this design: we ship only the autocomplete part (no chat/assistant suite, no Continue config files - plain VS Code settings), no language-specific context augmentation (universal, language-agnostic behavior is a spec requirement), and a manual shortcut trigger in addition to the debounce trigger. See proposal.md for motivation and the delta specs for requirements.

## Goals / Non-Goals

**Goals:**
- Single extension, TypeScript, esbuild bundling, VS Code engine `^1.97.0`.
- Clean separation: trigger/scheduling logic, prompt rendering (FIM templates), API client, and VS Code integration.
- Data-driven template registry so built-in and user-defined templates share one shape.

**Non-Goals:**
- Language-specific context augmentation (tree-sitter, import analysis) — may come later as a separate change.
- Chat-completions API support; only legacy `completions`.
- Multi-line completions (single-line output, matching Continue.dev's autocomplete UX)..
- Multi-cursor support.

## Decisions

1. **Use the official `openai` SDK, streaming completions.** Same approach as Continue.dev's autocomplete: streaming requests to a user-configured OpenAI-compatible endpoint (`client.completions.create({stream: true}, {signal})`). Rationale: handles SSE, abort, and auth headers for us; abort signal maps directly to request cancellation. Alternative (raw `fetch`) rejected: re-implements streaming/error handling for no gain.

2. **Debounce implemented as rate-limiting, not a setTimeout on keystrokes.** Requests are throttled to one per `debounceMs` (timestamp-based, abort-aware sleep), and a cancelled request is kept pending ~1000 ms so continued typing on the same line re-uses it. Rationale: fits VS Code's pull-based `provideInlineCompletionItems` API better than keystroke timers. Alternative (classic setTimeout) rejected: fights the provider invocation model.

3. **Template model: `{ id, reservedTokens: string[], render(prefix, suffix): string }`.** Built-ins registered in code (qwen2.5 `<|fim_prefix|>…<|fim_suffix|>…<|fim_middle|>` style, qwen3, lfm2, mellum — markers verified against each model family's documented FIM format); custom templates come from a settings array of plain objects `{ prefix, suffix, middle, stop? }` compiled to the same shape at read time. `reservedTokens` double as API `stop` sequences and as mask targets in the prompt. Alternative (templating language/files) rejected for v1: settings JSON is sufficient and needs no parser.

4. **Reserved-token masking.** If a reserved token appears in the extracted prefix/suffix, insert a space after its first character so the model never sees the user's code as template structure. Simple, reversible, no regex escaping hazards.

5. **Single-line completion.** Accumulate streamed chunks; truncate at the first `\n`/`\r` after leading whitespace; trim empty results. Keeps ghost text non-intrusive and matches reference behavior.

6. **Request lifecycle in the provider.** One `activeCompletion` cache validated by prefix-match (`stillValid()`-style check: same line, cursor advanced, typed text is a prefix of the completion) to avoid duplicate API calls; an `AbortController` per request; cancellation on line change, backward cursor move, config/state change, or disable.

7. **API key in `context.secrets`, optional.** Requests send `apiKey || placeholder`. On 401, prompt the user via the existing set-key command. Config keys under a single namespace (e.g. `l8t.*`), with `forbiddenFiles` glob list (micromatch, default `[".env"]`).

8. **Manual trigger.** A command that bypasses the rate-limit wait and invokes the provider (`vscode.commands.executeCommand('editor.action.inlineSuggest.trigger')` after clearing the throttle timestamp). Default keybinding contributed in `package.json`, user-reassignable.

## Risks / Trade-offs

- [FIM markers for lfm2/mellum may drift from model versions] → keep templates data-driven and document custom-template settings so users can correct markers without a release.
- [Debounce-as-throttle can issue a request on the first keystroke of a burst] → acceptable: result is still validated against the current position before display; matches the reference implementations' proven behavior.
- [Legacy completions endpoint unsupported by some servers] → out of scope; document requirement in README; chat-based FIM would be a separate change.
- [Streaming abort on Windows] → SDK abort signal is well-tested; fall back to discarding results if abort events misbehave.
- [Prompt size] → prefix/suffix length caps (default ~8000/2000 chars) plus max_tokens cap bound request cost.

## Migration Plan

Greenfield: scaffold the extension (`yo-code`-style layout: `src/`, `esbuild.js`, `package.json`), implement behind normal development workflow (`F5` launch config), publish as `.vsix` later. Rollback = uninstall the extension; no data or services affected.

## Open Questions

- Exact default keybinding for manual trigger (must not collide with common defaults; propose `Ctrl+Alt+Space`, adjustable during review).
