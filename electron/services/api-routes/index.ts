import { RouteApp, RouteContext } from './types';
import { registerHealthRoutes } from './health-routes';
import { registerHooksRoutes } from './hooks-routes';
import { registerAgentRoutes } from './agent-routes';
import { registerTelegramRoutes } from './telegram-routes';
import { registerSlackRoutes } from './slack-routes';
import { registerKanbanRoutes } from './kanban-routes';
import { registerVaultRoutes } from './vault-routes';
import { registerMemoryRoutes } from './memory-routes';
import { registerWebhookRoutes } from './webhook-routes';
import { registerBusRoutes } from './bus-routes';

export function registerAllRoutes(app: RouteApp, ctx: RouteContext): void {
  registerBusRoutes(app);
  registerHealthRoutes(app, ctx);
  registerHooksRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerTelegramRoutes(app, ctx);
  registerSlackRoutes(app, ctx);
  registerKanbanRoutes(app, ctx);
  registerVaultRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);
}

export type { RouteApp, RouteContext, RouteRequest, SendJson, RouteHandler, RouteDefinition } from './types';
