import { agents, saveAgents, noteSessionRegistered, noteTurnStarted } from '../../core/agent-manager';
import { findAgentByIdOrSession } from './utils';
import { RouteApp, RouteContext } from './types';
import { AgentStatus } from '../../types';
import { broadcastToAllWindows } from '../../utils/broadcast';
import { scheduleTick } from '../../utils/agents-tick';
import { emitAgentStatus } from '../agent-events';

/**
 * Session ownership contract:
 * - A task dispatch (/start, /message respawn, /dispatch) kills the old PTY and
 *   clears `currentSessionId`. The freshly booted claude session announces
 *   itself via the SessionStart hook (recognizable by its `source` field) and
 *   is registered WITHOUT changing status. Otherwise its startup "idle" would
 *   resolve the orchestrator's long-poll before the task even begins.
 * - Status posts carrying a session_id that doesn't match the registered
 *   session are stale (hooks of a killed PTY still in flight) and are ignored.
 * - `currentSessionId` is NOT cleared on idle: the one-shot claude process is
 *   still alive at its prompt and its later hooks must keep matching.
 */
/**
 * Is this post coming from a session that no longer owns the agent?
 *
 * Two ways to be stale: the post carries the id of a session that was killed
 * (the tombstone), or it carries an id that simply is not the registered one.
 * A killed PTY's hooks are separate processes that outlive the kill, so both
 * happen routinely rather than only under attack.
 *
 * /output, /status and /task-completed each spelled this out inline; the two
 * routes that fire desktop notifications did not check at all, so a hook from a
 * session the user had already moved on from could still tell them their agent
 * needed permission. That is one of the ways the app appeared to ask twice.
 */
/**
 * A session id Tars can act on: present, and not the empty string.
 *
 * The nine hooks build this field with `jq -r '.session_id // empty'`, which
 * yields "" when the field is missing and also when jq is not installed, and
 * no hook checks that jq exists. "" is falsy, so every guard written as
 * `if (!sessionId)` or `sessionId &&` answered "this is not stale" in exactly
 * the case it existed to catch. The measured consequence: the Stop hook of a
 * killed pty posts idle with an empty id, and puts the live session to sleep.
 * Worse, a SessionStart carrying "" was accepted, `currentSessionId` was set
 * to "" and saved to disk, so ownership was erased for good and any session
 * could drive that agent afterwards.
 *
 * Empty is therefore an invalid id here, never a benign absence. It also heals
 * an agent whose id was already emptied on disk: that reads as unowned, and
 * the next real session adopts it.
 */
function usableSessionId(sessionId?: string): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed ? trimmed : undefined;
}

/** The id of a session that was killed. Checked on its own before
 *  registration, where the full staleness test cannot run: a SessionStart
 *  legitimately carries an id that is not the current one, since claiming
 *  ownership is what it is for. */
function isTombstonedSession(agent: AgentStatus, sessionId?: string): boolean {
  const id = usableSessionId(sessionId);
  return !!id && id === usableSessionId(agent.lastKilledSessionId);
}

function isStaleSessionPost(agent: AgentStatus, sessionId?: string): boolean {
  const id = usableSessionId(sessionId);
  const owner = usableSessionId(agent.currentSessionId);
  // A post that carries no usable id cannot show it is the owner. Refused
  // wherever there is an owner to protect; an agent nobody owns is left alone.
  if (!id) return !!owner;
  if (isTombstonedSession(agent, id)) return true;
  return !!owner && id !== owner;
}

/** Long enough for any message the CLI writes in place of an answer, and short
 *  enough for the notification and the card that show it. */
const TURN_FAILURE_TEXT_MAX = 500;

/**
 * What to tell Noah about a turn that failed: the CLI's own words.
 *
 * Verbatim, because they are what he needs and what he could not see. The
 * night this was found, every terminal read "Not logged in · Please run
 * /login" while Tars reported the agents as working. A paraphrase would put
 * Tars between him and the one sentence that said what to do.
 */
function describeTurnFailure(message: string | undefined, kind: string | undefined): string {
  const text = message?.trim();
  if (text) return text.slice(0, TURN_FAILURE_TEXT_MAX);
  const name = kind?.trim();
  return name
    ? `The turn stopped on an error the CLI reported as ${name.slice(0, 80)}, with no message.`
    : 'The turn stopped on an error the CLI did not describe.';
}

export function registerHooksRoutes(app: RouteApp, ctx: RouteContext): void {
  // POST /api/hooks/output: capture clean text output from agent transcript
  app.post('/api/hooks/output', (req, sendJson) => {
    const { agent_id, session_id, output } = req.body as {
      agent_id: string;
      session_id?: string;
      output: string;
    };

    if (!agent_id || !output) {
      sendJson({ error: 'agent_id and output are required' }, 400);
      return;
    }

    const agent = findAgentByIdOrSession(agent_id, session_id);
    if (agent) {
      if (isStaleSessionPost(agent, session_id)) {
        // Stale session: don't let a killed PTY's Stop hook overwrite the
        // live task's output.
        console.log(`[hooks] Ignored stale output post for ${agent.id} (session ${session_id}, current ${agent.currentSessionId ?? 'none'})`);
        sendJson({ success: false, stale: true });
        return;
      }
      agent.lastCleanOutput = output;
      saveAgents();
    }

    sendJson({ success: true });
  });

  // POST /api/hooks/status
  app.post('/api/hooks/status', (req, sendJson) => {
    const {
      agent_id, session_id, status, source, event, waiting_reason, current_task, error_kind, error_message,
    } = req.body as {
      agent_id: string;
      session_id: string;
      status: 'running' | 'waiting' | 'idle' | 'completed' | 'error';
      source?: string;
      event?: string;
      reason?: string;
      waiting_reason?: string;
      current_task?: string;
      /** StopFailure only: the CLI's name for what failed, e.g. authentication_failed. */
      error_kind?: string;
      /** StopFailure only: what the CLI wrote in the terminal instead of an answer. */
      error_message?: string;
    };

    console.log(`[hooks] POST /api/hooks/status: agent_id=${agent_id}, status=${status}, session_id=${session_id}, source=${source ?? '-'}`);

    if (!agent_id || !status) {
      sendJson({ error: 'agent_id and status are required' }, 400);
      return;
    }

    // Refused loudly, and before anything can be written down. This is the
    // route that sets ownership, drives status, and makes Tars type into a
    // terminal, and an empty id is how a post with nothing to prove reached
    // all three. The predicates below would refuse it too, but as `stale`,
    // which reads as "another session spoke"; this is a malformed post, and
    // saying so names the actual cause: every hook Tars ships sends a real id,
    // so one that cannot is telling us jq is missing on that machine.
    if (!usableSessionId(session_id)) {
      sendJson({ error: 'session_id is required and must not be empty' }, 400);
      return;
    }

    const agent: AgentStatus | undefined = findAgentByIdOrSession(agent_id, session_id);
    if (!agent) {
      sendJson({ success: false, message: 'Agent not found' });
      return;
    }

    // Tombstone guard: hooks of a killed PTY's session (separate processes
    // that survive the kill) may arrive during the window where the new
    // session hasn't registered yet. Never let them register or flip status.
    if (isTombstonedSession(agent, session_id)) {
      console.log(`[hooks] Ignored post from killed session ${session_id} for ${agent.id} (status=${status})`);
      sendJson({ success: false, stale: true, agent: { id: agent.id, status: agent.status } });
      return;
    }

    // SessionStart registration (source is only ever sent by session-start
    // hooks): record which session now owns this agent, but never touch
    // status: the agent was just dispatched a task and is about to work.
    if (source) {
      agent.currentSessionId = session_id;
      // What the task-start watch reads, instead of an emptied ownership field.
      agent.sessionRegisteredAt = new Date().toISOString();
      agent.sessionPtyId = agent.ptyId;
      // Remembered separately so a restart can resume it: currentSessionId is
      // ownership and gets cleared on load, this is where the work got to.
      agent.resumableSessionId = session_id;
      agent.lastActivity = new Date().toISOString();
      // Registered is not started: this only puts the task this session was
      // spawned with on the clock.
      noteSessionRegistered(agent);
      saveAgents();
      sendJson({ success: true, registered: true, agent: { id: agent.id, status: agent.status } });
      return;
    }

    // Stale-session guard: only the registered session may drive status.
    //
    // Naming no session at all is refused here too, and that is the point of
    // this guard rather than a detail of it. A status change emits
    // fleet-change, agent-watch answers it with flush(), and flush writes a
    // note into the agent's pty. flush also refuses a requester that is
    // `running`, so posting `idle` for a busy agent is precisely how an
    // outsider could make Tars write into a turn in progress, which it
    // otherwise refuses on principle. The old condition required a session id
    // to be present before comparing it, so omitting the field skipped the
    // comparison: the guard cancelled itself exactly when the caller gave it
    // nothing to check. Every hook Tars ships sends one.
    if (isStaleSessionPost(agent, session_id)) {
      console.log(`[hooks] Ignored stale status post for ${agent.id}: ${status} from session ${session_id} (current: ${agent.currentSessionId})`);
      sendJson({ success: false, stale: true, agent: { id: agent.id, status: agent.status } });
      return;
    }
    // Registration fallback: if SessionStart never reached us (API briefly
    // down at boot), adopt the first non-tombstoned session that reports in.
    // An agent whose id was emptied on disk by the old bug reads as unowned
    // here, so the next real session adopts it and the damage heals itself.
    if (!usableSessionId(agent.currentSessionId)) {
      agent.currentSessionId = session_id;
      agent.resumableSessionId = session_id;
    }

    // The one post that proves a task reached the CLI. It cannot be read off
    // `status: 'running'`: PostToolUse sends that too, and a dispatch has
    // already set that status at spawn, so the hook names the event instead.
    if (event === 'UserPromptSubmit') {
      noteTurnStarted(agent);
    }

    const oldStatus = agent.status;

    if (status === 'running' && agent.status !== 'running') {
      agent.status = 'running';
      agent.waitingReason = undefined;
      if (current_task) agent.currentTask = current_task;
    } else if (status === 'waiting' && agent.status !== 'waiting' && agent.status !== 'error') {
      // An agent whose turn failed stays in error until a new turn starts.
      // Claude Code sends idle_prompt about sixty seconds after StopFailure,
      // as a `waiting` post, and without this guard it replaced the error:
      // an agent left alone, the very case the error exists for, stopped
      // showing why it had stopped. Only `running` clears it.
      agent.status = 'waiting';
      agent.waitingReason = waiting_reason;
    } else if (status === 'idle') {
      agent.status = 'idle';
      agent.waitingReason = undefined;
    } else if (status === 'completed') {
      agent.status = 'completed';
      agent.waitingReason = undefined;
    } else if (status === 'error') {
      // The turn ended on an error the CLI reported itself, through StopFailure.
      // Without this the agent stayed `running` for good: the process lives on
      // at its prompt, so nothing exits, and a turn did begin, so nothing that
      // watches for one ever fires. See hooks/stop-failure.sh for the
      // measurement.
      //
      // This is not a watch on a quiet agent, and must not become one. Nothing
      // here is timed and nothing is inferred from silence: an agent that works
      // slowly never sends this, and one whose turn failed always does.
      agent.status = 'error';
      agent.waitingReason = undefined;
      agent.error = describeTurnFailure(error_message, error_kind);
      // The turn happened and failed. A delivery still pending would be typed in
      // again fifteen seconds later, into a CLI that cannot run it, and its own
      // verdict would then replace the reason the CLI gave.
      agent.pendingDelivery = undefined;
    }

    agent.lastActivity = new Date().toISOString();

    if (oldStatus !== agent.status) {
      console.log(`[hooks] Status changed: ${agent.id} ${oldStatus} → ${agent.status}`);
      ctx.handleStatusChangeNotificationCallback(agent, agent.status);
      emitAgentStatus(agent.id);

      broadcastToAllWindows('agent:status', {
        agentId: agent.id,
        status: agent.status,
        waitingReason: waiting_reason,
      });
      scheduleTick();
    }

    sendJson({ success: true, agent: { id: agent.id, status: agent.status } });
  });

  // POST /api/hooks/task-completed: dedicated endpoint for TaskCompleted hook
  app.post('/api/hooks/task-completed', (req, sendJson) => {
    const { agent_id, session_id } = req.body as {
      agent_id: string;
      session_id?: string;
    };

    if (!agent_id) {
      sendJson({ error: 'agent_id is required' }, 400);
      return;
    }

    const agent = findAgentByIdOrSession(agent_id, session_id);
    if (!agent) {
      sendJson({ success: false, message: 'Agent not found' });
      return;
    }

    // The same decision as everywhere else, taken in one place.
    if (isStaleSessionPost(agent, session_id)) {
      console.log(`[hooks] Ignored stale task-completed for ${agent.id} from session ${session_id}`);
      sendJson({ success: false, stale: true, agent: { id: agent.id, status: agent.status } });
      return;
    }

    const oldStatus = agent.status;
    agent.status = 'completed';
    agent.waitingReason = undefined;
    agent.lastActivity = new Date().toISOString();

    const agentName = agent.name || `Agent ${agent.id.slice(0, 6)}`;

    // Send native notification if user has completion notifications enabled
    if (ctx.getAppSettings().notificationsEnabled && ctx.getAppSettings().notifyOnComplete) {
      ctx.sendNotificationCallback(
        `${agentName} finished`,
        agent.currentTask ? `Done: ${agent.currentTask.slice(0, 80)}` : 'Task completed successfully.',
        agent.id,
        ctx.getAppSettings()
      );
    }

    if (oldStatus !== 'completed') {
      console.log(`[hooks] Task completed: ${agent.id} ${oldStatus} → completed`);
      ctx.handleStatusChangeNotificationCallback(agent, 'completed');
      emitAgentStatus(agent.id);

      broadcastToAllWindows('agent:status', {
        agentId: agent.id,
        status: agent.status,
      });
      scheduleTick();
    }

    sendJson({ success: true, agent: { id: agent.id, status: agent.status } });
  });

  // POST /api/hooks/agent-stopped: Send notification when agent finishes a response (Stop hook)
  app.post('/api/hooks/agent-stopped', (req, sendJson) => {
    const { agent_id, session_id } = req.body as {
      agent_id: string;
      session_id?: string;
    };

    if (!agent_id) {
      sendJson({ error: 'agent_id is required' }, 400);
      return;
    }

    const agent = findAgentByIdOrSession(agent_id, session_id);
    if (!agent) {
      sendJson({ success: false, message: 'Agent not found' });
      return;
    }

    if (isStaleSessionPost(agent, session_id)) {
      console.log(`[hooks] Ignored stop from session ${session_id} for ${agent.id} (current: ${agent.currentSessionId ?? 'none'})`);
      sendJson({ success: false, stale: true });
      return;
    }

    if (ctx.getAppSettings().notificationsEnabled && ctx.getAppSettings().notifyOnStop) {
      const agentName = agent.name || `Agent ${agent.id.slice(0, 6)}`;
      ctx.sendNotificationCallback(
        `${agentName}`,
        agent.lastCleanOutput ? agent.lastCleanOutput.slice(0, 80) : 'Agent has finished and is ready for the next prompt.',
        agent.id,
        ctx.getAppSettings()
      );
    }

    sendJson({ success: true });
  });

  // POST /api/hooks/notification
  app.post('/api/hooks/notification', (req, sendJson) => {
    const { agent_id, session_id, type, title, message } = req.body as {
      agent_id: string;
      session_id: string;
      type: string;
      title: string;
      message: string;
    };

    if (!agent_id || !type) {
      sendJson({ error: 'agent_id and type are required' }, 400);
      return;
    }

    const agent = findAgentByIdOrSession(agent_id, session_id);
    // An unknown agent_id used to skip the guard below, because the guard was
    // conditioned on the agent existing: the alert still went to the desktop,
    // carrying the caller's own `message`, under the name "Claude". Same shape
    // as the missing session id above, a guard that lapses when the value it
    // checks is absent.
    if (!agent) {
      sendJson({ success: false, message: 'Agent not found' });
      return;
    }
    if (isStaleSessionPost(agent, session_id)) {
      console.log(`[hooks] Ignored ${type} notification from session ${session_id} for ${agent.id} (current: ${agent.currentSessionId ?? 'none'})`);
      sendJson({ success: false, stale: true });
      return;
    }
    const agentName = agent.name || 'Claude';

    if (type === 'permission_prompt') {
      if (ctx.getAppSettings().notifyOnWaiting) {
        ctx.sendNotificationCallback(
          `${agentName} needs permission`,
          message || 'Claude needs your permission to proceed',
          agent.id,
          ctx.getAppSettings()
        );
      }
    } else if (type === 'idle_prompt') {
      if (ctx.getAppSettings().notifyOnWaiting) {
        ctx.sendNotificationCallback(
          `${agentName} is waiting`,
          message || 'Claude is waiting for your input',
          agent.id,
          ctx.getAppSettings()
        );
      }
    }

    broadcastToAllWindows('agent:notification', {
      agentId: agent?.id,
      type,
      title,
      message,
    });

    sendJson({ success: true });
  });
}
