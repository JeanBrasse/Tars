import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEmitter } from 'node:events';

/**
 * A file sent to Telegram over a link slower than the file is big.
 *
 * #227 gave the Telegram server's requests a timer of silence: a minute with
 * nothing on the socket ends the request. For a file that is the wrong clock.
 * Node hands the body to the kernel's send buffer (up to 4 MB on macOS) and
 * sees nothing more while a slow link drains it, so the minute ran from the
 * last byte handed over, not from the last byte Telegram read. QA's gate of
 * #227, over TLS to a Telegram that reads at 20 KB/s: 3 MB all handed over at
 * 55.9 s, the request cut at 116 s with 2.31 MB received, where main delivered
 * the file whole in 150 s.
 *
 * How this can fail, written before the code:
 * 1. a timer of silence is left on a file's request: an upload Telegram is
 *    still reading is cut a minute after its last byte left Node;
 * 2. the time given does not grow with the file: a file a slow link takes
 *    minutes to carry gets the minute a text message gets;
 * 3. it grows without measure: a Telegram that never answers is waited on far
 *    longer than the file takes at a slow rate;
 * 4. a Telegram that never answers is no longer said as such, or not in the
 *    words every server here shares, or the wait the words name is not the one
 *    that passed (QA measured a cut at 120 s said as "60 s");
 * 5. the deadline outlives the answer: a timer left for as long as an hour
 *    keeps the request, and the file's bytes with it, and fires on a request
 *    that has ended;
 * 6. a text message, which has no body to carry, is no longer ended after a
 *    minute of silence (the rest of #227).
 *
 * The server is the real one, mcp-telegram/src/index.ts, loaded with the MCP
 * SDK replaced by a fake that keeps its tools, as in
 * __tests__/electron/telegram-private-dir.test.ts. https is replaced by a
 * transport that answers when a test says so, whose timer of silence runs as a
 * socket's does once the body sits in the kernel: from the last write. The
 * clock is vitest's. Nothing leaves the process.
 */

type FakeRequest = EventEmitter & {
  destroyed: boolean;
  /** Telegram answers: the response, whole, then the request closes, as Node does. */
  answer(json: unknown): void;
};
const requests = vi.hoisted(() => [] as FakeRequest[]);

vi.mock('https', async () => {
  const { EventEmitter } = await import('node:events');
  const open = (onAnswer?: (res: EventEmitter) => void): FakeRequest => {
    let silence = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const quiet = () => { clearTimeout(idle); idle = undefined; };
    const arm = () => {
      quiet();
      if (silence > 0 && !req.destroyed) idle = setTimeout(() => req.emit('timeout'), silence);
    };
    const req = Object.assign(new EventEmitter(), {
      destroyed: false,
      write() { arm(); return true; },
      end() { arm(); return req; },
      setTimeout(ms: number, onTimeout?: () => void) {
        silence = ms;
        if (onTimeout) req.on('timeout', onTimeout);
        arm();
        return req;
      },
      destroy(err?: Error) {
        if (req.destroyed) return req;
        req.destroyed = true;
        quiet();
        if (err) req.emit('error', err);
        req.emit('close');
        return req;
      },
      answer(json: unknown) {
        if (req.destroyed) throw new Error('Telegram answered a request that had already ended');
        quiet();
        const res = new EventEmitter();
        onAnswer?.(res);
        res.emit('data', JSON.stringify(json));
        res.emit('end');
        req.destroyed = true;
        req.emit('close');
      },
    });
    requests.push(req);
    return req;
  };
  const request = (_options: unknown, onAnswer?: (res: EventEmitter) => void) => open(onAnswer);
  const get = (_url: unknown, onAnswer?: (res: EventEmitter) => void) => {
    const req = open(onAnswer);
    req.end();
    return req;
  };
  return { default: { request, get }, request, get };
});

type Result = { content: Array<{ text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
const tools = new Map<string, Handler>();

/** The SDK the server gets: a McpServer that keeps the handlers, and a transport that connects to nothing. */
const FAKE_SDK: Record<string, () => unknown> = {
  '@modelcontextprotocol/sdk/server/mcp.js': () => ({
    McpServer: class {
      tool(name: string, _description: string, _schema: unknown, handler: Handler) { tools.set(name, handler); }
      async connect() {}
    },
  }),
  '@modelcontextprotocol/sdk/server/stdio.js': () => ({ StdioServerTransport: class {} }),
};

const SERVER_DIR = path.join(__dirname, '..', '..', 'mcp-telegram');

/**
 * The file the server's own import of `specifier` lands on, or the bare name
 * when nothing there provides it: vitest keys a mock by the file an import
 * resolves to, and the server finds its SDK in mcp-telegram/node_modules when
 * that folder is installed. telegram-private-dir.test.ts says it at length.
 */
function whereTheServerFinds(specifier: string): string {
  try {
    const url = execFileSync(process.execPath, [
      '--input-type=module', '--eval', 'process.stdout.write(import.meta.resolve(process.env.SPECIFIER))',
    ], { cwd: SERVER_DIR, env: { ...process.env, SPECIFIER: specifier }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return fileURLToPath(url);
  } catch {
    return specifier;
  }
}

const WORK = path.join(os.homedir(), 'work');
/** QA's file: 3 MB, which a Telegram reading at 20 KB/s takes 150 s to receive. */
const BIG = path.join(WORK, 'big.bin');
const SMALL = path.join(WORK, 'shot.png');

beforeAll(async () => {
  fs.mkdirSync(path.join(os.homedir(), '.dorothy'), { recursive: true });
  fs.writeFileSync(path.join(os.homedir(), '.dorothy', 'app-settings.json'), JSON.stringify({
    telegramBotToken: '123:tok', telegramChatId: '111',
  }));
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(BIG, Buffer.alloc(3_000_000, 7));
  fs.writeFileSync(SMALL, Buffer.alloc(3_000, 7));
  for (const [specifier, fake] of Object.entries(FAKE_SDK)) vi.doMock(whereTheServerFinds(specifier), fake);
  await import('../../mcp-telegram/src/index');
});

beforeEach(() => {
  requests.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A tool call, the request it made, and when on vitest's clock it came back, with what. */
async function call(name: string, args: Record<string, unknown>) {
  const handler = tools.get(name);
  expect(handler, `${name} was never registered`).toBeDefined();
  const started = Date.now();
  const outcome: { after?: number; text?: string; isError?: boolean } = {};
  const done = handler!(args).then((result) => {
    outcome.after = (Date.now() - started) / 1000;
    outcome.text = result.content.map((c) => c.text).join('');
    outcome.isError = result.isError;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(requests, `${name} made no request`).toHaveLength(1);
  return { outcome, done, req: requests[0] };
}

/** A Telegram that never answers a file: when the tool gave up, and the wait its words name. */
async function neverAnswered(name: string, args: Record<string, unknown>, noun: string) {
  const { outcome, done, req } = await call(name, args);
  await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
  await done;
  expect(outcome.isError, `${name} did not fail`).toBe(true);
  const said = outcome.text!.match(new RegExp(`^Error sending ${noun} to Telegram: no answer within (\\d+) s$`));
  expect(said, outcome.text).not.toBeNull();
  expect(req.destroyed, 'the request was left open').toBe(true);
  return { after: outcome.after!, said: Number(said![1]) };
}

describe('a file sent to Telegram over a slow link', () => {
  it('1. a 3 MB file Telegram is still reading after two minutes arrives: nothing cuts it a minute after it left Node', async () => {
    const { outcome, done, req } = await call('send_telegram_document', { document_path: BIG });

    // QA's link: 20 KB/s, the whole file received and answered at 150.3 s.
    await vi.advanceTimersByTimeAsync(150_300);
    expect(outcome.text, 'the tool gave up while Telegram was still reading').toBeUndefined();
    expect(req.destroyed, 'the upload was cut while Telegram was still reading').toBe(false);

    req.answer({ ok: true, result: { message_id: 1 } });
    await done;
    expect(outcome.isError).toBeUndefined();
    expect(outcome.text).toBe(`Document sent to Telegram chat 111: ${BIG}`);
  });

  it('2, 3, 4. a Telegram that never answers is said to, after a time that grows with the file, and in measure', async () => {
    const small = await neverAnswered('send_telegram_photo', { photo_path: SMALL }, 'photo');
    requests.length = 0;
    const big = await neverAnswered('send_telegram_document', { document_path: BIG }, 'document');

    // 4. The wait the words name is the one that passed, to the second.
    expect(small.after).toBe(small.said);
    expect(big.after).toBe(big.said);
    // A small file is said after about the minute any answer gets.
    expect(small.said).toBeGreaterThanOrEqual(60);
    expect(small.said).toBeLessThanOrEqual(65);
    // 2. QA's 3 MB, which a 20 KB/s link takes 150 s to carry, gets those 150 s on top.
    expect(big.said - small.said).toBeGreaterThanOrEqual(150);
    // 3. And no more than the file takes at 5 KB/s: minutes, not hours.
    expect(big.said - small.said).toBeLessThanOrEqual(600);
  });

  it('5. no timer outlives the answer', async () => {
    const { done, req } = await call('send_telegram_photo', { photo_path: SMALL });
    await vi.advanceTimersByTimeAsync(5_000);
    req.answer({ ok: true, result: { message_id: 2 } });
    await done;

    expect(vi.getTimerCount(), 'a timer is still pending after Telegram answered').toBe(0);
  });
});

describe('a text message, as #227 left it', () => {
  it('6. ends after a minute of silence, and says so', async () => {
    const { outcome, done, req } = await call('send_telegram', { message: 'Hi' });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(outcome.text).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    await done;

    expect(outcome.text).toBe('Error sending to Telegram: no answer within 60 s');
    expect(outcome.after).toBe(60);
    expect(req.destroyed).toBe(true);
  });
});
