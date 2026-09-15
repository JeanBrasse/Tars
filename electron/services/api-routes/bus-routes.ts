import { agents } from '../../core/agent-manager';
import { RouteApp, RouteRequest, SendJson } from './types';
import { callerHeader } from './utils';
import {
  getRoomSnapshot,
  listRooms,
  projectRoomId,
  publishAgentMessage,
} from '../bus-store';
import { broadcastPublication, fanOutDeliveries } from '../bus-delivery';

/**
 * The bus for agents, over the local API.
 *
 * The Chat page reaches the bus over IPC; an agent reaches it through its MCP
 * server, which speaks HTTP to this server with a bearer token and its own
 * identity headers. Both end in the same store, and every bound lives there:
 * an agent that writes faster cannot get around the three rounds, the ten
 * messages, the silence markers or the rotation, because this route applies
 * none of them itself and refuses whatever the store refuses.
 *
 * Authenticated like everything else under /api: the four exempt routes are
 * /api/local-file, /api/health, /api/hooks/* and /api/kanban/complete, and this
 * is not one of them.
 */

/** The agent behind this call, from the header its MCP client always sends. */
function callingAgent(req: RouteRequest, sendJson: SendJson): { id: string; projectPath: string } | undefined {
  const callerId = callerHeader(req, 'id');
  if (!callerId) {
    sendJson({
      error: 'This call has no agent identity, so it cannot be placed in a room. '
        + 'Restart the agent from Tars so it is spawned with CLAUDE_AGENT_ID and CLAUDE_PROJECT_PATH.',
    }, 403);
    return undefined;
  }
  const agent = agents.get(callerId);
  if (!agent) {
    sendJson({ error: 'The calling agent is not one Tars knows about.' }, 404);
    return undefined;
  }
  return { id: agent.id, projectPath: agent.projectPath };
}

/**
 * Which room this call is about: the one asked for, or the caller's own
 * project room. An agent may only speak in a room of its own project, which is
 * the same scoping the delegation routes apply.
 */
function resolveRoom(
  caller: { id: string; projectPath: string },
  asked: string | undefined,
  sendJson: SendJson,
): string | undefined {
  const roomId = asked && asked.trim() ? asked.trim() : projectRoomId(caller.projectPath);
  const room = listRooms().find(r => r.id === roomId);
  if (!room) {
    sendJson({ error: `No room "${roomId}". Rooms are the global one and one per project.` }, 404);
    return undefined;
  }
  if (room.kind === 'project' && room.projectPath !== caller.projectPath) {
    sendJson({
      error: `That room belongs to ${room.projectPath}, and you are an agent of ${caller.projectPath}.`,
    }, 403);
    return undefined;
  }
  if (room.kind === 'global') {
    sendJson({ error: 'The global room is the super chat and is not open to room_post.' }, 403);
    return undefined;
  }
  return room.id;
}

export function registerBusRoutes(app: RouteApp): void {
  // POST /api/bus/post: an agent publishes into its room.
  app.post('/api/bus/post', async (req, sendJson) => {
    const caller = callingAgent(req, sendJson);
    if (!caller) return;

    const { room: asked, text, mentions } = req.body as {
      room?: string;
      text?: string;
      mentions?: string[];
    };
    if (!text || !text.trim()) {
      sendJson({ error: 'text is required' }, 400);
      return;
    }

    const roomId = resolveRoom(caller, asked, sendJson);
    if (!roomId) return;

    const result = publishAgentMessage({
      roomId,
      agentId: caller.id,
      text,
      mentions: Array.isArray(mentions) ? mentions : undefined,
    });

    if (!result.published) {
      // Refused out loud, with the reason, rather than dropped into a queue
      // that would never move: a message that quietly never appears is the
      // silent failure this app has already had once.
      sendJson({ success: false, refused: result.reason, message: result.detail }, 200);
      return;
    }

    const roomNow = listRooms().find(r => r.id === roomId)!;
    const deliveries = fanOutDeliveries(result.message, roomNow);
    broadcastPublication(result.message, result.thread, deliveries);

    sendJson({
      success: true,
      messageId: result.message.id,
      threadId: result.thread.id,
      threadState: result.thread.state,
      round: result.thread.round,
      agentMessageCount: result.thread.agentMessageCount,
      deliveries,
    });
  });

  // GET /api/bus/read: catch up on the thread before answering.
  app.get('/api/bus/read', async (req, sendJson) => {
    const caller = callingAgent(req, sendJson);
    if (!caller) return;

    const asked = req.url.searchParams.get('room') ?? undefined;
    const roomId = asked && asked.trim() ? asked.trim() : projectRoomId(caller.projectPath);
    const room = listRooms().find(r => r.id === roomId);
    if (!room) {
      sendJson({ error: `No room "${roomId}".` }, 404);
      return;
    }
    if (room.kind === 'project' && room.projectPath !== caller.projectPath) {
      sendJson({ error: `That room belongs to ${room.projectPath}.` }, 403);
      return;
    }

    const limitParam = Number(req.url.searchParams.get('limit'));
    const snapshot = getRoomSnapshot(roomId, {
      limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50,
    });
    if (!snapshot) {
      sendJson({ error: 'Room not found' }, 404);
      return;
    }
    sendJson({ success: true, ...snapshot });
  });
}
