import { describe, expect, it, vi } from 'vitest';
import { PartialLineActionStore, PartialLineCandidate } from '../../partial_line_action';

const candidate = (overrides: Partial<PartialLineCandidate> = {}): PartialLineCandidate => ({
  fileName: 'main.ts',
  documentVersion: 1,
  line: 3,
  character: 8,
  insert: ' // done',
  completion: 'const x = 1; // done',
  ...overrides,
});

describe('PartialLineActionStore', () => {
  it('reports the set candidate to the change listener', () => {
    const onChanged = vi.fn();
    const store = new PartialLineActionStore(onChanged);
    const c = candidate();
    store.set(c);
    expect(onChanged).toHaveBeenCalledWith(c);
  });

  it('hides the badge once the document changed', () => {
    const store = new PartialLineActionStore();
    store.set(candidate());
    expect(store.get('main.ts', 2)).toBeUndefined();
  });

  it('replaces a previous candidate', () => {
    const onChanged = vi.fn();
    const store = new PartialLineActionStore(onChanged);
    store.set(candidate({ documentVersion: 1 }));
    const next = candidate({ documentVersion: 2, line: 5 });
    store.set(next);
    expect(onChanged).toHaveBeenLastCalledWith(next);
    expect(store.get('main.ts', 2)).toBe(next);
  });
});
