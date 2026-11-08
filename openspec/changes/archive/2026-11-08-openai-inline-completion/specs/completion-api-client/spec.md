# Spec Delta

## Purpose

Handles communication with an OpenAI-compatible completions API: configurable endpoint and model, secure API key storage, streaming responses, stop sequences, and prefix/suffix context truncation.

## ADDED Requirements

### Requirement: OpenAI-compatible completions endpoint
The extension SHALL send completion requests to the legacy `completions` endpoint of an OpenAI-compatible API, with the base URL, model name, maximum tokens, and streaming behavior configurable via settings.

#### Scenario: Local server
- **WHEN** the base URL points to a local server (e.g. `http://127.0.0.1:1234/v1`) with a loaded model
- **THEN** completion requests succeed without any API key

#### Scenario: Streaming
- **WHEN** the server streams the completion response
- **THEN** the extension accumulates chunks and presents the result once complete, and can abort mid-stream on cancellation

### Requirement: API key secure storage
The extension SHALL store the API key in VS Code secret storage (not in plain settings), settable and clearable via commands, and SHALL include it in requests when present.

#### Scenario: Set and use API key
- **WHEN** the user sets an API key via the command
- **THEN** subsequent requests carry the key and the key is not visible in settings files

### Requirement: Context truncation
The extension SHALL build the completion prompt from the text before the cursor (prefix) and after the cursor (suffix), truncating each to configurable maximum lengths.

#### Scenario: Large file
- **WHEN** the document is larger than the configured context limits
- **THEN** the prefix and suffix are truncated to their configured maximum lengths before rendering

### Requirement: Error handling
The extension SHALL surface API errors (connection failure, authentication failure, rate limiting) non-intrusively, without crashing the provider, and SHALL recover on subsequent requests. Authentication failures SHALL prompt the user to set the API key.

#### Scenario: Server unreachable
- **WHEN** the API endpoint is unreachable
- **THEN** the user sees a non-blocking warning and normal editing continues

#### Scenario: Authentication failure
- **WHEN** the API responds with 401
- **THEN** the extension prompts the user to provide an API key
