# fim-templates Specification

## Purpose

Defines fill-in-the-middle (FIM) prompt templates that structure the completion prompt for different model families, including built-in templates (qwen2.5, qwen3, mellum) and user-defined custom templates.

## Requirements

### Requirement: Built-in FIM templates
The extension SHALL ship with built-in FIM templates for the qwen2.5, qwen3, and mellum model families, each defining its reserved tokens (used as stop sequences) and the rendered prompt for a given prefix/suffix pair. The selected template SHALL be configurable via settings.

#### Scenario: Select a built-in template
- **WHEN** the user sets the template setting to `qwen3`
- **THEN** completion prompts are rendered with the qwen3 FIM markers and its reserved tokens are sent as stop sequences

#### Scenario: Default template
- **WHEN** the user has not configured a template
- **THEN** a documented default template is used

### Requirement: Custom templates via configuration
The extension SHALL allow users to add custom FIM templates through configuration, specifying at minimum the prefix, suffix, and middle markers and optionally a list of reserved stop tokens; custom templates SHALL be selectable in the same template setting.

#### Scenario: Add a custom template
- **WHEN** the user defines a custom template in settings and selects it
- **THEN** prompts are rendered with the user's markers and the user's reserved tokens are sent as stop sequences

### Requirement: Reserved token masking
For each template, the extension SHALL use the template's reserved tokens both as API stop sequences and to mask occurrences of those tokens appearing in the user's own code within the prompt, so the model is not confused by them.

#### Scenario: Reserved token in user code
- **WHEN** the user's buffer contains a token reserved by the active template
- **THEN** that occurrence is masked in the rendered prompt while the template's own structural markers remain intact

### Requirement: Invalid template selection handled
The extension SHALL fall back to the default template and report a warning when the configured template does not exist or a custom template definition is invalid.

#### Scenario: Unknown template name
- **WHEN** the template setting names a template that is neither built-in nor custom-defined
- **THEN** completions continue using the default template and a warning is surfaced to the user
