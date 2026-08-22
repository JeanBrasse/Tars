import { describe, it, expect, vi, beforeEach } from 'vitest';
let a: ReturnType<typeof vi.fn>;
let b: ReturnType<typeof vi.fn>;
beforeEach(() => {
  a = vi.fn();
  b = vi.fn((...args: unknown[]) => a(...args));
});
describe('repro', () => {
  it('delegates throw', () => {
    a.mockImplementation(() => { throw new Error('boom'); });
    expect(() => b('x')).toThrow('boom');
  });
});
