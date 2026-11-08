# Proposal

## Why

VS Code users running local or remote OpenAI-compatible models (Qwen, LFM2, Mellum, …) have no lightweight, universal inline code completion extension: existing solutions are either tied to a specific vendor or bind their language support to a particular language (reference: Continue.dev, whose autocomplete is the closest open-source analogue). We need a universal extension that provides AI completions in any file, using configurable fill-in-the-middle (FIM) prompt templates for the legacy OpenAI **completions** API.

## What Changes

- Create a new VS Code extension (TypeScript) in this repository that registers an `InlineCompletionItemProvider` for all file types (`**` pattern) — no language binding.
- Completion requests are triggered two ways:
  - automatically, after the user stops typing (debounce, default 250 ms, configurable);
  - manually, via a keybinding / command ("trigger completion now").
- Requests go to an OpenAI-compatible `/v1/completions` endpoint (configurable base URL, model, API key stored in secret storage; streaming supported).
- The extension ships with built-in FIM prompt templates for qwen2.5, qwen3, lfm2, and mellum, and lets users add custom templates via settings (reserved/stop tokens + prefix/suffix/middle markers).
- Completions are shown as native ghost text; accepting uses VS Code's normal inline accept gesture; moving the cursor, switching files, or typing cancels in-flight requests.
- Status bar item shows provider state; the extension can be enabled/disabled per workspace.

## Capabilities

### New Capabilities

- `inline-completion-provider`: Triggering (debounce after typing pause, manual shortcut), cancellation, caching/re-use, and delivery of suggestions as VS Code inline completions for all languages.
- `fim-templates`: FIM prompt template definitions — built-in templates (qwen2.5, qwen3, lfm2, mellum) with reserved stop tokens, and user-defined custom templates contributed through configuration.
- `completion-api-client`: Communication with an OpenAI-compatible completions API — base URL, model, API key secret storage, streaming, stop sequences, context window truncation (prefix/suffix limits).
- `extension-management`: Extension lifecycle — activation, configuration settings, enable/disable state, status bar indicator, commands (trigger completion, set/clear API key, toggle).

### Modified Capabilities

<!-- None — this is a greenfield extension. -->

## Impact

- New code in this (previously empty) repository: `package.json`, `src/**`, tests, build config (esbuild).
- Dependencies: `openai` SDK, TypeScript, esbuild; VS Code engine `^1.97.0`.
- No existing specs or code are affected (greenfield).
- Assumption recorded: the API key is optional (local servers need none); single-line completions only (truncate at first newline), matching Continue.dev's autocomplete UX.
