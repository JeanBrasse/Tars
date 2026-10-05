import { describe, it, expect } from 'vitest';
import { ptyBacklog } from '../../src/lib/pty-backlog';

/**
 * What a project's shell writes before its terminal is there to hear it
 * (src/lib/pty-backlog.ts). The Projects page asks main for a PTY, then mounts
 * <Terminal>, a dynamic import away, which only then listens to the PTY: the
 * shell's banner and first prompt, written in between, reached nobody, and the
 * terminal opened empty (the QA's WHEEL-QA.md, 05/10). The page now listens
 * before it asks, and hands the terminal what came. Written before the code.
 * How it can fail:
 * 1. a chunk the PTY writes before the page knows its id (pty:create has not
 *    answered yet) is lost: the page must listen before it asks;
 * 2. another PTY's chunks are handed over: every PTY's data comes through the
 *    one channel;
 * 3. the order is lost;
 * 4. the listening never ends: once the terminal has taken the chunks it hears
 *    the PTY itself, and a page that went on listening kept every chunk of
 *    every PTY for as long as it lived; a terminal that never came (the dialog
 *    closed first, pty:create failed) left it listening too;
 * 5. the chunks are handed over twice: React runs an effect twice in
 *    development, the terminal's subscription with it.
 */

type Chunk = { id: string; data: string };

/** The bridge's pty.onData, with its listeners in view. */
function channel() {
  const listeners = new Set<(chunk: Chunk) => void>();
  return {
    onData: (cb: (chunk: Chunk) => void) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    send: (id: string, data: string) => { for (const cb of [...listeners]) cb({ id, data }); },
    get listening() { return listeners.size; },
  };
}

describe('what a PTY writes before its terminal listens', () => {
  it('is kept from before the PTY was asked for, in order, and handed to its terminal (1, 3)', () => {
    const pty = channel();
    const backlog = ptyBacklog(pty.onData);
    // pty:create has not answered: the id is not known yet.
    pty.send('p1', 'Last login: Mon Oct  5 21:40\r\n');
    pty.send('p1', 'the recorder holds the alternate screen\r\n');
    pty.send('p1', '% ');
    expect(backlog.take('p1')).toEqual(['Last login: Mon Oct  5 21:40\r\n', 'the recorder holds the alternate screen\r\n', '% ']);
  });

  it('hands over only that PTY\'s chunks (2)', () => {
    const pty = channel();
    const backlog = ptyBacklog(pty.onData);
    pty.send('other', 'an agent\'s shell\r\n');
    pty.send('p1', 'mine\r\n');
    pty.send('other', 'more of it\r\n');
    expect(backlog.take('p1')).toEqual(['mine\r\n']);
  });

  it('stops listening once the terminal has taken them, and keeps nothing after (4)', () => {
    const pty = channel();
    const backlog = ptyBacklog(pty.onData);
    pty.send('p1', 'banner\r\n');
    expect(pty.listening).toBe(1);
    backlog.take('p1');
    expect(pty.listening).toBe(0);
    pty.send('p1', 'heard by the terminal itself\r\n');
    expect(backlog.take('p1')).toEqual([]);
  });

  it('stops listening, and keeps nothing, for a terminal that never came (4)', () => {
    const pty = channel();
    const backlog = ptyBacklog(pty.onData);
    pty.send('p1', 'banner\r\n');
    backlog.drop();
    expect(pty.listening).toBe(0);
    expect(backlog.take('p1')).toEqual([]);
  });

  it('hands them over once, however often it is asked (5)', () => {
    const pty = channel();
    const backlog = ptyBacklog(pty.onData);
    pty.send('p1', 'banner\r\n');
    expect(backlog.take('p1')).toEqual(['banner\r\n']);
    expect(backlog.take('p1')).toEqual([]);
  });
});
