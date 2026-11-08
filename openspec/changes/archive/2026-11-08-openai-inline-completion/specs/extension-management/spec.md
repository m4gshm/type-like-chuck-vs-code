# Spec Delta

## Purpose

Covers the extension's lifecycle and user-facing management: activation, configuration settings, commands, enable/disable persistence, and status bar feedback.

## ADDED Requirements

### Requirement: Configuration settings
The extension SHALL expose configuration for: API base URL, model name, FIM template selection, custom template definitions, debounce delay (with sane minimum/maximum), prefix/suffix context maximum lengths, maximum completion tokens, and a list of file globs in which completions are disabled.

#### Scenario: Settings change applies
- **WHEN** the user changes a configuration setting while VS Code is running
- **THEN** subsequent completion requests use the new value without reload

### Requirement: Forbidden files
The extension SHALL not request completions in files matching the configured forbidden-file globs (default including `.env`).

#### Scenario: Editing .env
- **WHEN** the user pauses after typing in a `.env` file
- **THEN** no completion request is made

### Requirement: Commands
The extension SHALL provide commands to: trigger a completion immediately, set the API key, clear the API key, and toggle completions on/off — all discoverable in the command palette under the extension's category.

#### Scenario: Command palette discovery
- **WHEN** the user opens the command palette and types the extension's category
- **THEN** all extension commands are listed and executable

### Requirement: Status bar indicator
The extension SHALL display a status bar item reflecting whether completions are enabled, and SHALL reflect transient state (e.g. request in flight or error) without being intrusive.

#### Scenario: Error feedback
- **WHEN** a completion request fails
- **THEN** the status bar/output channel reflects the failure and editing is not disrupted

### Requirement: Activation
The extension SHALL activate on startup finished and register its provider, commands, and configuration listeners.

#### Scenario: Startup
- **WHEN** VS Code finishes starting with the extension installed and enabled
- **THEN** inline completions work in any opened file without manual activation steps
