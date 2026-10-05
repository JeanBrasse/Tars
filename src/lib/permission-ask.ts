import type { AgentStatus } from '@/types/electron';
import { flat, when } from '@/lib/stop-line';

/**
 * What a permission question Tars holds says, wherever it is shown: a panel's
 * line under its header, the top of the agent window's terminal column, the
 * card's task line. Since PR 318 a Claude agent that runs the state mod asks
 * Tars, not its terminal, before a call Claude Code would put to its dialog:
 * it reads `waiting` with `permissionAsk` set, which names what the call
 * acts on, whole (`subject`, electron/services/permission-asks.ts). Frame:
 * `Permission asked of Tars` in design/tars-redesign.pen. Its failures are listed, and pinned, in
 * __tests__/lib/permission-ask.test.ts.
 */
export interface PermissionAskLine {
  /** "Asks to use Bash:", or "Asks to use <tool>" with nothing more to name. */
  who: string;
  /** The command, the file, the address or the search; '' when there is none. */
  subject: string;
  /** "asked at 14:02", "asked on 4 Oct at 23:58", '' for a time that does not parse. */
  at: string;
  /** The whole sentence, for a title. */
  title: string;
}

/**
 * The line, or null when Tars holds no question for this agent. Only while it
 * waits: a copy of an agent allowed and running again may still carry the
 * permissionAsk it had. A waiting agent with no permissionAsk is at its
 * terminal's dialog, which only the terminal answers. The subject is the
 * question's own, whole (the gate of PR 318, Medium 2): waitingOn is cut at 200
 * characters and hidden once an interrupt is recorded, and what is allowed
 * must be what was read.
 */
export function permissionAskLine(
  agent: Pick<AgentStatus, 'status' | 'permissionAsk'>,
  now = new Date(),
): PermissionAskLine | null {
  if (agent.status !== 'waiting' || !agent.permissionAsk) return null;
  const tool = flat(agent.permissionAsk.tool);
  let subject = flat(agent.permissionAsk.subject);
  // A file is named "Edit /path", and a tool with nothing to name by itself.
  if (subject.startsWith(`${tool} `)) subject = subject.slice(tool.length + 1).trim();
  if (subject === tool) subject = '';
  const who = subject ? `Asks to use ${tool}:` : `Asks to use ${tool}`;
  const time = when(agent.permissionAsk.askedAt, now);
  return { who, subject, at: time && `asked ${time}`, title: subject ? `${who} ${subject}` : who };
}
