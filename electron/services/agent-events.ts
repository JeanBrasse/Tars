import { EventEmitter } from 'events';

/**
 * When an agent's status moves, and who is told.
 *
 * Its own module rather than a member of the HTTP server, because the things
 * that listen are not all HTTP: the overseer watches the whole fleet so it can
 * react to work happening instead of asking every few minutes whether any has.
 * Reaching that through `api-server` would drag the Telegram bot, the Slack
 * app and the route table into anything that wants to know an agent moved.
 *
 * Two channels, one call. `status:<id>` is what a caller waiting on one agent
 * listens to; `fleet-change` is what anything watching the fleet listens to.
 * They are emitted together here rather than at each of the six call sites, so
 * a seventh cannot add one and forget the other.
 */
export const agentStatusEmitter = new EventEmitter();
// One `/wait` listener per agent in flight, plus the overseer.
agentStatusEmitter.setMaxListeners(50);

export function emitAgentStatus(agentId: string): void {
  agentStatusEmitter.emit(`status:${agentId}`);
  agentStatusEmitter.emit('fleet-change', agentId);
}
