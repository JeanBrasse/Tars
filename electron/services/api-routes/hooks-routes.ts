import { agents, saveAgents } from '../../core/agent-manager';
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
function isStaleSessionPost(agent: AgentStatus, sessionId?: string): boolean {
  if (!sessionId) return false;
  if (sessionId === agent.lastKilledSessionId) return true;
  return !!agent.currentSessionId && sessionId !== agent.currentSessionId;
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
      const staleOutput =
        (agent.currentSessionId && session_id && session_id !== agent.currentSessionId) ||
        (session_id && session_id === agent.lastKilledSessionId);
      if (staleOutput) {
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
    const { agent_id, session_id, status, source, waiting_reason, current_task } = req.body as {
      agent_id: string;
      session_id: string;
      status: 'running' | 'waiting' | 'idle' | 'completed';
      source?: string;
      reason?: string;
      waiting_reason?: string;
      current_task?: string;
    };

    console.log(`[hooks] POST /api/hooks/status: agent_id=${agent_id}, status=${status}, session_id=${session_id}, source=${source ?? '-'}`);

    if (!agent_id || !status) {
      sendJson({ error: 'agent_id and status are required' }, 400);
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
    if (session_id && session_id === agent.lastKilledSessionId) {
      console.log(`[hooks] Ignored post from killed session ${session_id} for ${agent.id} (status=${status})`);
      sendJson({ success: false, stale: true, agent: { id: agent.id, status: agent.status } });
      return;
    }

    // SessionStart registration (source is only ever sent by session-start
    // hooks): record which session now owns this agent, but never touch
    // status: the agent was just dispatched a task and is about to work.
    if (source) {
      agent.currentSessionId = session_id;
      // Remembered separately so a restart can resume it: currentSessionId is
      // ownership and gets cleared on load, this is where the work got to.
      agent.resumableSessionId = session_id;
      agent.lastActivity = new Date().toISOString();
      saveAgents();
      sendJson({ success: true, registered: true, agent: { id: agent.id, status: agent.status } });
      return;
    }

    // Stale-session guard: only the registered session may drive status.
    if (agent.currentSessionId && session_id && session_id !== agent.currentSessionId) {
      console.log(`[hooks] Ignored stale status post for ${agent.id}: ${status} from session ${session_id} (current: ${agent.currentSessionId})`);
      sendJson({ success: false, stale: true, agent: { id: agent.id, status: agent.status } });
      return;
    }
    // Registration fallback: if SessionStart never reached us (API briefly
    // down at boot), adopt the first non-tombstoned session that reports in.
    if (!agent.currentSessionId && session_id) {
      agent.currentSessionId = session_id;
      agent.resumableSessionId = session_id;
    }

    const oldStatus = agent.status;

    if (status === 'running' && agent.status !== 'running') {
      agent.status = 'running';
      agent.waitingReason = undefined;
      if (current_task) agent.currentTask = current_task;
    } else if (status === 'waiting' && agent.status !== 'waiting') {
      agent.status = 'waiting';
      agent.waitingReason = waiting_reason;
    } else if (status === 'idle') {
      agent.status = 'idle';
      agent.waitingReason = undefined;
    } else if (status === 'completed') {
      agent.status = 'completed';
      agent.waitingReason = undefined;
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

    // Same stale-session + tombstone guards as /api/hooks/status.
    const staleCompleted =
      (agent.currentSessionId && session_id && session_id !== agent.currentSessionId) ||
      (session_id && session_id === agent.lastKilledSessionId);
    if (staleCompleted) {
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
    if (agent && isStaleSessionPost(agent, session_id)) {
      console.log(`[hooks] Ignored ${type} notification from session ${session_id} for ${agent.id} (current: ${agent.currentSessionId ?? 'none'})`);
      sendJson({ success: false, stale: true });
      return;
    }
    const agentName = agent?.name || 'Claude';

    if (type === 'permission_prompt') {
      if (ctx.getAppSettings().notifyOnWaiting) {
        ctx.sendNotificationCallback(
          `${agentName} needs permission`,
          message || 'Claude needs your permission to proceed',
          agent?.id,
          ctx.getAppSettings()
        );
      }
    } else if (type === 'idle_prompt') {
      if (ctx.getAppSettings().notifyOnWaiting) {
        ctx.sendNotificationCallback(
          `${agentName} is waiting`,
          message || 'Claude is waiting for your input',
          agent?.id,
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
