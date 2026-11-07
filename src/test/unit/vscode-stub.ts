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

export class CodeActionKind {
  static readonly QuickFix = new CodeActionKind('quickfix');
  constructor(readonly value: string) {}
}

export class WorkspaceEdit {
  readonly edits: Array<{ uri: unknown; position: Position; insert: string }> = [];
  insert(uri: unknown, position: Position, insert: string): void {
    this.edits.push({ uri, position, insert });
  }
}

export class CodeAction {
  edit?: WorkspaceEdit;
  isPreferred?: boolean;
  constructor(
    readonly title: string,
    readonly kind: CodeActionKind,
  ) {}
}

export class CancellationError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancellationError';
  }
}

export const window = {
  showErrorMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  /** Records created status bar items so tests can inspect their text. */
  createdStatusBarItems: [] as StatusBarItemStub[],
  createStatusBarItem: (alignment?: number, priority?: number): StatusBarItemStub => {
    const item = new StatusBarItemStub(alignment, priority);
    window.createdStatusBarItems.push(item);
    return item;
  },
};

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;

export class StatusBarItemStub {
  text = '';
  tooltip: string | undefined;
  command: string | undefined;
  shown = false;
  disposed = false;
  constructor(
    readonly alignment?: number,
    readonly priority?: number,
  ) {}
  show(): void {
    this.shown = true;
  }
  hide(): void {
    this.shown = false;
  }
  dispose(): void {
    this.disposed = true;
  }
}

export const commands = { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined };
