# Spec Delta

## MODIFIED Requirements

### Requirement: Engine process lifecycle
The extension SHALL run the local engine as a managed child process and terminate it when the extension deactivates or the mode switches to remote. HTTP-speaking engines (llama.cpp) start as a llama-server bound to a free localhost port, and the extension waits until the OpenAI-compatible endpoint responds. stdio engines (ovgenai, mlx) are spawned with the model path and are ready when they report readiness on stdout. With sharing enabled (`tlc.local.sharedRunner`, the default), stdio runners follow the connect-or-spawn and self-termination rules of the `local-engine/stdio-runner-sharing` capability instead of being terminated by their spawner: on deactivate or mode switch the extension only disconnects its client connection, and the runner exits when its last client disconnects. With sharing disabled, the stdio runner's stdin/stdout pipes stay private to the extension instance and the process is terminated by it. In both cases the stdio runner SHALL NOT open any TCP network port and SHALL NOT require an API key: its endpoint is a local named pipe (Windows) or unix domain socket (Linux/macOS) under the engine directory, and its protocol stays the existing NDJSON stream.

#### Scenario: Start and become ready
- **WHEN** local mode is entered with engine and model present
- **THEN** the engine process starts (or an existing shared runner is connected to) and completions become available once the engine is ready; the status bar shows the engine state (starting → ready)

#### Scenario: Shutdown
- **WHEN** VS Code closes or the window reloads with sharing disabled
- **THEN** the engine process is terminated and does not keep the model loaded in memory

#### Scenario: Shutdown with sharing enabled
- **WHEN** VS Code closes or the window reloads with sharing enabled
- **THEN** the extension disconnects from the shared runner; the runner exits by itself only when no other client remains connected

#### Scenario: Stdio runner starts without a port or key
- **WHEN** the `ovgenai` runner starts
- **THEN** it opens no TCP port, no API key is generated or logged, and readiness is taken from the runner's ready handshake on its connection
