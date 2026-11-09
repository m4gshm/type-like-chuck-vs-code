import { describe, expect, it } from 'vitest';
import { copilotActive } from '../../copilot_gate';

describe('copilotActive', () => {
  it('is false when the Copilot extension is not installed', () => {
    expect(copilotActive(false, { '*': true }, undefined, 'typescript')).toBe(false);
    expect(copilotActive(false, undefined, undefined, 'typescript')).toBe(false);
  });

  it('defaults to active when installed and no enable map exists', () => {
    expect(copilotActive(true, undefined, undefined, 'typescript')).toBe(true);
    expect(copilotActive(true, {}, undefined, 'python')).toBe(true);
  });

  it('is false when ghost text suggestions are disabled', () => {
    expect(copilotActive(true, undefined, false, 'typescript')).toBe(false);
    expect(copilotActive(true, { '*': true }, false, 'typescript')).toBe(false);
    expect(copilotActive(true, undefined, true, 'typescript')).toBe(true);
  });

  it('follows the language override over the global one', () => {
    const enable = { '*': true, python: false };
    expect(copilotActive(true, enable, undefined, 'python')).toBe(false);
    expect(copilotActive(true, enable, undefined, 'typescript')).toBe(true);
  });

  it('follows the global switch when the language has no override', () => {
    expect(copilotActive(true, { '*': false }, undefined, 'typescript')).toBe(false);
  });
});
