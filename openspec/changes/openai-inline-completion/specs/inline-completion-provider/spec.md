# Spec Delta

## Purpose

Provides AI-powered inline (ghost text) code completions in VS Code for files of any language, triggered either automatically after a typing pause or manually by a keyboard shortcut, with proper cancellation and re-use of in-flight requests.

## ADDED Requirements

### Requirement: Automatic trigger after typing pause
The extension SHALL automatically request a completion when the user stops typing, with a debounce delay that is configurable via settings (default 250 ms) and applies to files of any language.

#### Scenario: Debounced request
- **WHEN** the user types in an editor and stops for the configured debounce delay
- **THEN** the extension issues at most one completion request for the current position

#### Scenario: Continued typing cancels
- **WHEN** the user types again before the completion result arrives
- **THEN** the pending request is cancelled or re-throttled and no stale ghost text is shown

### Requirement: Manual trigger by shortcut
The extension SHALL expose a command that triggers a completion immediately at the current cursor position, and SHALL contribute a default keybinding for it that users can reassign.

#### Scenario: Manual trigger
- **WHEN** the user invokes the trigger-completion command
- **THEN** a completion request is issued immediately, bypassing the debounce delay

### Requirement: Universal language support
The extension SHALL register its inline completion provider for all files (any document), without language-specific behavior or per-language binding.

#### Scenario: Works in any file type
- **WHEN** the user pauses after typing in a Markdown, Go, or Python file
- **THEN** the completion provider is invoked the same way in each case

### Requirement: Cancellation of stale requests
The extension SHALL cancel in-flight completion requests when the cursor moves to a different line, the document changes beyond the pending position, the editor loses focus, or the extension is disabled.

#### Scenario: Cursor move cancels
- **WHEN** a request is in flight and the user moves the cursor to another line
- **THEN** the request is aborted and its result is discarded

### Requirement: Re-use of active completion
The extension SHALL re-serve an already received completion without a new API call while the user types text that is a prefix of that completion on the same line.

#### Scenario: Prefix typing re-uses result
- **WHEN** a completion "function foo" is displayed and the user types "function"
- **THEN** the remaining suggestion " foo" is still shown with no additional API request

### Requirement: Accept and dismiss via native gestures
The extension SHALL deliver suggestions as VS Code inline completion items so that accepting (Tab) and dismissing (Esc) use VS Code's native gestures.

#### Scenario: Accept suggestion
- **WHEN** the user presses Tab while ghost text is shown
- **THEN** the completion text is inserted at the cursor

### Requirement: Toggle enabled state
The extension SHALL allow the user to enable or disable completions per workspace via a command, persisted across sessions, and reflected in a status bar indicator.

#### Scenario: Disable completions
- **WHEN** the user runs the toggle command while enabled
- **THEN** completions stop being requested and the status bar shows the disabled state
