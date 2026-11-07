import * as vscode from 'vscode';
import { PartialLineActionStore } from './partial_line_action';

/** Surfaces a suppressed completion that mostly extends the line right below
 * the cursor as a quick fix inserting the difference into that line. */
export class PartialLineCodeActions implements vscode.CodeActionProvider {
  constructor(private readonly store: PartialLineActionStore) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    _context: vscode.CodeActionContext,
    _token: vscode.CancellationToken,
  ): vscode.CodeAction[] {
    const candidate = this.store.get(document.fileName, document.version);
    if (candidate === undefined || range.start.line > candidate.line || range.end.line < candidate.line) {
      return [];
    }
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(candidate.line, candidate.character), candidate.insert);
    const shown = candidate.insert.length > 24 ? `${candidate.insert.slice(0, 21)}…` : candidate.insert;
    const action = new vscode.CodeAction(
      `TLC: insert "${shown}" into line ${candidate.line + 1}`,
      vscode.CodeActionKind.QuickFix,
    );
    action.edit = edit;
    action.isPreferred = true;
    return [action];
  }
}
