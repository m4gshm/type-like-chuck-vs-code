import { describe, expect, it } from 'vitest';
import { CodeAction, CodeActionKind, Position, Range } from 'vscode';
import { PartialLineCodeActions } from '../../completion_code_actions';
import { PartialLineActionStore, PartialLineCandidate } from '../../partial_line_action';

const candidate = (overrides: Partial<PartialLineCandidate> = {}): PartialLineCandidate => ({
  fileName: 'main.ts',
  documentVersion: 3,
  line: 1,
  character: 45,
  insert: ', &fourth}',
  completion: '\tentities = []*entity{&first, &second, &third, &fourth}',
  ...overrides,
});

const document = (fileName = 'main.ts', version = 3) => ({ fileName, version, uri: { path: fileName } }) as never;

describe('PartialLineCodeActions', () => {
  it('offers to insert the delta into the candidate line when the cursor is on it', () => {
    const store = new PartialLineActionStore();
    store.set(candidate());
    const actions = new PartialLineCodeActions(store).provideCodeActions(document() as never, new Range(new Position(1, 0), new Position(1, 0)) as never, {} as never, { isCancelled: false } as never);
    expect(actions).toHaveLength(1);
    const action = actions[0] as CodeAction;
    expect(action.title).toBe('TLC: insert ", &fourth}" into line 2');
    expect(action.kind).toBe(CodeActionKind.QuickFix);
    expect(action.isPreferred).toBe(true);
    const edit = action.edit as unknown as { edits: Array<{ uri: unknown; position: { line: number; character: number }; insert: string }> };
    expect(edit.edits).toEqual([{ uri: { path: 'main.ts' }, position: { line: 1, character: 45 }, insert: ', &fourth}' }]);
  });

  it('truncates a long delta in the title', () => {
    const store = new PartialLineActionStore();
    store.set(candidate({ insert: ', &fourth, &fifth, &sixth, &seventh}' }));
    const actions = new PartialLineCodeActions(store).provideCodeActions(document() as never, new Range(new Position(1, 0), new Position(1, 0)) as never, {} as never, { isCancelled: false } as never);
    expect((actions[0] as CodeAction).title).toBe('TLC: insert ", &fourth, &fifth, &s…" into line 2');
  });

  it('returns nothing when the document changed since the candidate was stored', () => {
    const store = new PartialLineActionStore();
    store.set(candidate());
    expect(new PartialLineCodeActions(store).provideCodeActions(document('main.ts', 4) as never, new Range(new Position(1, 0), new Position(1, 0)) as never, {} as never, { isCancelled: false } as never)).toHaveLength(0);
  });

  it('returns nothing when the cursor is far from the candidate line', () => {
    const store = new PartialLineActionStore();
    store.set(candidate());
    expect(new PartialLineCodeActions(store).provideCodeActions(document() as never, new Range(new Position(10, 0), new Position(10, 0)) as never, {} as never, { isCancelled: false } as never)).toHaveLength(0);
  });
});
