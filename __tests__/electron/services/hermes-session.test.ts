import { describe, it, expect } from 'vitest';
import { stripAnsi, firstCompleteJson } from '../../../electron/services/hermes-session';

/**
 * The two pure parts of the live transport.
 *
 * They carry the whole risk of it. The gateway publishes no turn-completed
 * event and records no message for a PTY session, so "the reply has finished"
 * is decided entirely by finding a complete JSON envelope in a stream of
 * terminal bytes that redraws itself. If either of these is wrong the overseer
 * either hangs until its timeout or answers with half an envelope.
 */

describe('stripAnsi', () => {
  it('removes the sequences the agent TUI actually emits', () => {
    const raw = '\x1b[2J\x1b[H\x1b[38;5;214mHermes\x1b[0m ready\x1b]0;title\x07';
    expect(stripAnsi(raw)).toBe('Hermes ready');
  });

  it('leaves the text alone when there is nothing to strip', () => {
    expect(stripAnsi('{"say": "hello"}')).toBe('{"say": "hello"}');
  });

  it('does not eat the payload while removing a cursor move', () => {
    expect(stripAnsi('{"say":\x1b[12;40H "still here"}')).toBe('{"say": "still here"}');
  });
});

describe('firstCompleteJson', () => {
  it('returns nothing while the object is still arriving', () => {
    expect(firstCompleteJson('{"say": "half a repl')).toBeNull();
    expect(firstCompleteJson('noise, no brace at all')).toBeNull();
  });

  it('returns the object as soon as it closes', () => {
    expect(firstCompleteJson('{"say": "done"}')).toBe('{"say": "done"}');
  });

  it('ignores the terminal chatter around it', () => {
    const screen = '❯ ask\n  thinking...\n{"say": "ok", "action": null}\n─ ready │ deepseek';
    expect(firstCompleteJson(screen)).toBe('{"say": "ok", "action": null}');
  });

  it('counts nested objects rather than stopping at the first close', () => {
    const text = '{"say": "hi", "action": {"agentId": "a1", "text": "go"}}';
    expect(firstCompleteJson(text)).toBe(text);
  });

  it('is not fooled by a brace inside a string', () => {
    // The envelope quotes agent output, which is full of braces: a naive
    // depth count that ignores strings closes the object early and the reply
    // is truncated mid-sentence.
    const text = '{"say": "the agent printed } and then {"}';
    expect(firstCompleteJson(text)).toBe(text);
  });

  it('is not fooled by an escaped quote inside a string', () => {
    const text = '{"say": "it said \\"} done\\" to me"}';
    expect(firstCompleteJson(text)).toBe(text);
  });

  it('stops at the end of the first object when two arrive', () => {
    expect(firstCompleteJson('{"a": 1}{"b": 2}')).toBe('{"a": 1}');
  });
});
