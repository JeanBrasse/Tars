import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';

/**
 * An Agent Client Protocol session against one agent process.
 *
 * The value over typing into a PTY is that a turn *returns*: `session/prompt`
 * resolves with a stop reason and the turn's token usage, so a delegated task
 * has a receipt instead of a keystroke and a hope. Tool calls, plans and
 * permission requests arrive as structured events rather than as ANSI text to
 * be scraped, and the same conversation works against every agent that speaks
 * the protocol.
 */

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  totalTokens?: number;
}

export interface TurnResult {
  stopReason: StopReason;
  usage?: AcpUsage;
  /** Everything the agent said this turn, concatenated. */
  text: string;
  /** Tool calls it made, in order. */
  toolCalls: { title: string; kind?: string; status?: string }[];
  costUSD?: number;
}

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: { name: string; value: string }[];
}

export interface SessionOptions {
  cwd: string;
  env?: Record<string, string>;
  mcpServers?: McpServerSpec[];
  /** How permission requests are answered when the agent asks. */
  permissionMode?: 'normal' | 'auto' | 'bypass';
  /** Tools the agent must not be allowed to use, by name fragment. */
  denyTools?: string[];
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const INITIALIZE_TIMEOUT = 90_000;
const DEFAULT_TURN_TIMEOUT = 30 * 60_000;
/** How much of what an agent writes to stderr is kept, to say why it stopped. */
const STDERR_TAIL = 4_000;

/**
 * What a launch that failed means, in words the agent that delegated can act
 * on. ENOENT alone is ambiguous: spawn reports a working directory that is
 * gone with the same code as a command that is nowhere on PATH, and names the
 * command either way.
 */
function launchFailure(err: NodeJS.ErrnoException, command: string, cwd: string, searched: string | undefined): Error {
  if (err.code === 'ENOENT' && !fs.existsSync(cwd)) {
    return new Error(`could not start the agent: its working directory ${cwd} does not exist`);
  }
  if (err.code === 'ENOENT') {
    const install = command === 'npx' ? 'npx comes with Node.js: install Node.js' : 'Install it';
    return new Error(`could not start the agent: ${command} was not found. Tars looked in ${searched || 'an empty PATH'}. ${install}, or set where it lives in Settings > CLI Paths.`);
  }
  return new Error(`could not start the agent: ${command}: ${err.message}`);
}

/**
 * The last lines an agent wrote to stderr, without stack frames or the update
 * notice npx prints after the agent it ran has died: why it stopped, in its
 * own words.
 */
function lastWords(stderr: string): string {
  const lines = stderr.split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('at ') && !line.startsWith('npm notice'));
  const words = lines.slice(-2).join('; ').slice(-400);
  return words ? `: ${words}` : '';
}

export class AcpSession extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private sessionId: string | null = null;
  /** The configuration options the agent offered when the session opened. */
  private configOptionIds = new Set<string>();
  private closed = false;
  private stderrTail = '';

  /** Text and tool calls for the turn currently in flight. */
  private turnText: string[] = [];
  private turnTools: { title: string; kind?: string; status?: string }[] = [];
  private turnUsage: AcpUsage | undefined;
  private turnCost: number | undefined;

  constructor(
    private readonly launch: { command: string; args: string[] },
    private readonly options: SessionOptions,
  ) {
    super();
  }

  /** Spawns the agent, negotiates the protocol and opens a session. */
  async start(): Promise<{ sessionId: string; agentName?: string; capabilities?: unknown }> {
    const env = { ...process.env, ...this.options.env };
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout.on('data', chunk => this.onStdout(chunk.toString()));
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL);
      this.emit('stderr', text);
    });
    child.on('exit', code => {
      this.fail(new Error(`agent exited (code ${code})${lastWords(this.stderrTail)}`));
      this.emit('exit', code);
    });
    // A launch that fails, the command nowhere on PATH or the folder gone, is
    // reported here and only here: no 'exit' follows it. It used to be emitted
    // again on this session, where nothing listened, and an 'error' nobody
    // hears is thrown: in the main process, the "Uncaught Exception" window
    // Noah saw on 2026-09-18, while the initialize below waited out its 90
    // seconds. It fails what is waiting instead, that initialize first.
    child.on('error', err => this.fail(launchFailure(err, this.launch.command, this.options.cwd, env.PATH)));
    // The same class on the way in: writing to an agent that has stopped
    // reading raises EPIPE on its stdin. Nothing can reach it any more, so the
    // session is over, and the agent is stopped rather than left behind.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      this.fail(new Error(`the agent stopped reading its input (${err.code ?? err.message})`));
      child.kill();
    });

    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    }, INITIALIZE_TIMEOUT) as { agentInfo?: { name?: string }; agentCapabilities?: unknown };

    const session = await this.request('session/new', {
      cwd: this.options.cwd,
      mcpServers: (this.options.mcpServers ?? []).map(s => ({
        name: s.name,
        command: s.command,
        args: s.args,
        env: s.env ?? [],
      })),
    }, INITIALIZE_TIMEOUT) as { sessionId: string };

    this.sessionId = session.sessionId;
    const offered = (session as { configOptions?: { id?: unknown }[] }).configOptions;
    this.configOptionIds = new Set((Array.isArray(offered) ? offered : [])
      .map(option => option?.id)
      .filter((id): id is string => typeof id === 'string'));
    await this.selectMode(session as unknown as Record<string, unknown>);

    return {
      sessionId: session.sessionId,
      agentName: init?.agentInfo?.name,
      capabilities: init?.agentCapabilities,
    };
  }

  /**
   * Picks the session's permission mode.
   *
   * The default on some agents is "deny anything not pre-approved", which
   * silently blocks the very MCP tools we inject. Choosing `default` puts the
   * decision back on the client: every risky call arrives as a
   * session/request_permission we answer ourselves, which is how the deny list
   * ends up enforced identically on every agent.
   */
  private async selectMode(session: Record<string, unknown>): Promise<void> {
    const modes = session.modes as
      | { currentModeId?: string; availableModes?: { id: string }[] }
      | undefined;
    const available = new Set((modes?.availableModes ?? []).map(m => m.id));
    if (available.size === 0) return;

    const wantsArbitration = (this.options.denyTools?.length ?? 0) > 0
      || this.options.permissionMode === 'normal';

    const preference = wantsArbitration
      ? ['default', 'auto', 'acceptEdits']
      : this.options.permissionMode === 'bypass'
        ? ['bypassPermissions', 'acceptEdits', 'default']
        : ['acceptEdits', 'default', 'auto'];

    const target = preference.find(id => available.has(id));
    if (!target || target === modes?.currentModeId) return;

    try {
      await this.request('session/set_mode', { sessionId: this.sessionId, modeId: target }, 15_000);
      this.emit('mode', target);
    } catch (err) {
      this.emit('stderr', `could not set session mode to ${target}: ${String(err)}`);
    }
  }

  /**
   * Sets one of the options the agent offered for this session, such as its
   * model or its effort (`session/set_config_option`). ACP has no command line
   * to put them on: a session is configured once it is open. Answers whether
   * the agent took the value, and says why not when it did not, because the
   * turn runs either way and a setting that silently did not apply is how a
   * delegation came to run on the CLI's defaults.
   */
  async setConfigOption(configId: string, value: string): Promise<boolean> {
    if (!this.sessionId) throw new Error('session not started');
    if (!this.configOptionIds.has(configId)) {
      this.emit('stderr', `the agent offers no ${configId} option, so ${value} was not applied`);
      return false;
    }
    try {
      await this.request('session/set_config_option', { sessionId: this.sessionId, configId, value }, 15_000);
      return true;
    } catch (err) {
      this.emit('stderr', `could not set ${configId} to ${value}: ${String(err)}`);
      return false;
    }
  }

  /** Sends a prompt and resolves when the agent finishes the turn. */
  async prompt(text: string, timeoutMs = DEFAULT_TURN_TIMEOUT): Promise<TurnResult> {
    if (!this.sessionId) throw new Error('session not started');

    this.turnText = [];
    this.turnTools = [];
    this.turnUsage = undefined;
    this.turnCost = undefined;

    const result = await this.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }, timeoutMs) as { stopReason?: StopReason; usage?: AcpUsage };

    return {
      stopReason: result?.stopReason ?? 'end_turn',
      usage: result?.usage ?? this.turnUsage,
      text: this.turnText.join(''),
      toolCalls: this.turnTools,
      costUSD: this.turnCost,
    };
  }

  async cancel(): Promise<void> {
    if (!this.sessionId || this.closed) return;
    try {
      await this.notify('session/cancel', { sessionId: this.sessionId });
    } catch {
      // the kill below is the real stop
    }
  }

  stop(): void {
    this.closed = true;
    this.child?.kill();
    this.child = null;
  }

  get isRunning(): boolean {
    return !!this.child && !this.closed;
  }

  /** Ends the session: nothing more is written, and every call still waiting fails with `err`. */
  private fail(err: Error): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /* ── wire ─────────────────────────────────────────────── */

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit('stderr', line);
        continue;
      }

      const id = message.id as number | undefined;
      if (id !== undefined && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (message.error) {
          const err = message.error as { message?: string };
          p.reject(new Error(err?.message ?? 'agent error'));
        } else {
          p.resolve(message.result);
        }
        continue;
      }

      if (typeof message.method === 'string') {
        this.onAgentMessage(message);
      }
    }
  }

  private onAgentMessage(message: Record<string, unknown>): void {
    const method = message.method as string;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const id = message.id as number | undefined;

    if (method === 'session/update') {
      this.onUpdate((params.update ?? {}) as Record<string, unknown>);
      return;
    }

    if (method === 'session/request_permission') {
      this.answerPermission(id, params);
      return;
    }

    // Anything else the agent asks of the client gets an empty acknowledgement
    // rather than silence, which would hang its turn.
    if (id !== undefined) this.respond(id, {});
  }

  private onUpdate(update: Record<string, unknown>): void {
    const kind = update.sessionUpdate as string;

    if (kind === 'agent_message_chunk') {
      const content = update.content as { text?: string } | undefined;
      if (content?.text) {
        this.turnText.push(content.text);
        this.emit('text', content.text);
      }
      return;
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const title = (update.title as string) || (update.rawInput as { command?: string } | undefined)?.command || 'tool';
      const entry = { title, kind: update.kind as string | undefined, status: update.status as string | undefined };
      if (kind === 'tool_call') this.turnTools.push(entry);
      this.emit('tool', entry);
      return;
    }

    if (kind === 'usage_update') {
      this.turnUsage = {
        inputTokens: update.inputTokens as number | undefined,
        outputTokens: update.outputTokens as number | undefined,
        totalTokens: update.used as number | undefined,
      };
      const cost = update.cost as { amount?: number } | undefined;
      if (typeof cost?.amount === 'number') this.turnCost = cost.amount;
      this.emit('usage', this.turnUsage);
      return;
    }

    if (kind === 'plan') {
      this.emit('plan', update.entries);
      return;
    }

    this.emit('update', update);
  }

  /**
   * Answers a permission request without a human in the loop. This is the
   * guardrail that finally works on every agent rather than only on Claude:
   * a denied tool is denied by the protocol, not by a flag one CLI happens to
   * support.
   */
  private answerPermission(id: number | undefined, params: Record<string, unknown>): void {
    if (id === undefined) return;

    const toolCall = (params.toolCall ?? {}) as { title?: string; kind?: string };
    const options = (params.options ?? []) as { optionId: string; kind?: string; name?: string }[];
    const label = `${toolCall.title ?? ''} ${toolCall.kind ?? ''}`.toLowerCase();

    const denied = (this.options.denyTools ?? []).some(fragment => label.includes(fragment.toLowerCase()));
    const wanted = denied
      ? ['reject_once', 'reject_always']
      : this.options.permissionMode === 'normal'
        ? ['allow_once']
        : ['allow_always', 'allow_once'];

    const chosen = wanted.map(kind => options.find(o => o.kind === kind)).find(Boolean)
      ?? (denied ? undefined : options[0]);

    this.emit('permission', { tool: toolCall.title, denied, decision: chosen?.optionId });

    this.respond(id, chosen
      ? { outcome: { outcome: 'selected', optionId: chosen.optionId } }
      : { outcome: { outcome: 'cancelled' } });
  }

  private respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.child || this.closed) return Promise.reject(new Error('agent not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(message: unknown): void {
    if (!this.child || this.closed) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
