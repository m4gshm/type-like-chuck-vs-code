/**
 * Minimal stand-in for the `vscode` module, aliased in vitest.config.ts so
 * pure-logic modules that only use vscode types/small classes stay unit
 * testable without the extension host.
 */
export class Range {
  constructor(
    readonly start: { line: number; character: number },
    readonly end: { line: number; character: number },
  ) {}
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}

  translate(lineDelta: number, characterDelta: number): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
}

export class InlineCompletionItem {
  constructor(
    readonly insertText: string,
    readonly range?: Range,
  ) {}
}

export class CancellationError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancellationError';
  }
}

export const window = { showErrorMessage: async () => undefined, showWarningMessage: async () => undefined };

export const commands = { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined };
