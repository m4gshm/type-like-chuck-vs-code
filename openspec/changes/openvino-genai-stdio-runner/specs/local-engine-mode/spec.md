# Spec Delta

## MODIFIED Requirements

### Requirement: Local mode uses the same completion client
In local mode the extension SHALL send completion requests to the locally started engine's OpenAI-compatible endpoint, so prompt templates, single-line truncation, caching, and error handling behave identically to remote mode. For the `ovgenai` engine kind, which has no HTTP endpoint, the extension SHALL route the same rendered FIM prompts through the runner's stdio transport and apply the identical post-processing (stop-token cut, single-line truncation, loop detection) to the streamed tokens, so completions are indistinguishable between engine kinds.

#### Scenario: Completion in local mode
- **WHEN** the local engine is running and the user types in an editor
- **THEN** a ghost-text completion is produced through the same FIM pipeline used in remote mode

#### Scenario: Completion via the stdio runner
- **WHEN** local mode runs the `ovgenai` engine and the user types in an editor
- **THEN** the rendered FIM prompt is sent as a request on the runner's stdin and the streamed tokens are assembled into the same single-line ghost-text suggestion as with the HTTP engines
