import { describe, expect, it } from 'vitest';
import { detectLoop } from '../../loop_detection';

describe('detectLoop', () => {
  it('detects a repeated multi-character token like <|fim_pad|>', () => {
    const text = '<|fim_pad|>'.repeat(10);
    const result = detectLoop(text);
    expect(result.looped).toBe(true);
    expect(text.slice(0, result.cutIndex)).toBe('');
  });

  it('detects loops inside longer text and keeps the healthy prefix', () => {
    const prefix = 'console.log("hi"); ';
    const text = prefix + '<|fim_pad|>'.repeat(10);
    const result = detectLoop(text);
    expect(result.looped).toBe(true);
    expect(text.slice(0, result.cutIndex)).toBe(prefix);
  });

  it('detects a loop when the very first tokens repeat', () => {
    const result = detectLoop('<|fim_pad|>'.repeat(6));
    expect(result.looped).toBe(true);
    expect(result.cutIndex).toBe(0);
  });

  it('detects long runs of a single character', () => {
    const result = detectLoop('code ' + 'a'.repeat(30));
    expect(result.looped).toBe(true);
  });

  it('does not trigger on normal text', () => {
    expect(detectLoop('function foo(a, b) { return a + b; }').looped).toBe(false);
    expect(detectLoop('const x = [[1, 2], [3, 4]];').looped).toBe(false);
  });

  it('does not trigger on few repetitions', () => {
    expect(detectLoop('<|fim_pad|>'.repeat(3)).looped).toBe(false);
    expect(detectLoop('ab'.repeat(5)).looped).toBe(false);
  });

  it('returns no loop for short text', () => {
    expect(detectLoop('').looped).toBe(false);
    expect(detectLoop('ab').looped).toBe(false);
  });
});
