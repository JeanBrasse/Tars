import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { agents } from '../../core/agent-manager';
import { performDispatch } from './agent-routes';
import { RouteApp, RouteContext } from './types';
import { dataPath } from '../../constants';

/**
 * Incoming webhooks: lets an external scheduler (the user's Hermes instance)
 * drive Tars agents. Tars deliberately has no scheduler of its own:
 * Hermes cron jobs / automation blueprints call this endpoint instead.
 *
 * Auth: the standard API bearer token (~/.dorothy/api-token), NOT exempt.
 * Reachability from a VPS: run `tailscale serve 31415` on this machine (or an
 * equivalent tunnel) so Hermes can reach the localhost-bound API.
 *
 * POST /api/webhooks/hermes
 * Body: {
 *   agent_id?: string;        // exact agent id, or…
 *   agent_name?: string;      // …case-insensitive exact name match
 *   project_path?: string;    // narrows agent_name when the same role exists on several projects
 *   message: string;          // the task
 *   model?: string;
 *   permission_mode?: 'normal' | 'auto' | 'bypass';
 *   dry_run?: boolean;        // validate auth + agent resolution without dispatching
 * }
 * Responds like /api/agents/:id/dispatch ({ success, mode, agent }); poll
 * GET /api/agents/:id for status/output afterwards.
 */
export function registerWebhookRoutes(app: RouteApp, ctx: RouteContext): void {
  app.post('/api/webhooks/hermes', async (req, sendJson) => {
    // This route is the one thing published over the tailnet, so it carries
    // its own secret rather than the master API token.
    const provided = String(req.raw.headers.authorization || '').replace(/^Bearer\s+/i, '');
    let expected = '';
    try {
      const secretFile = dataPath('hermes-webhook-secret');
      if (fs.existsSync(secretFile)) expected = fs.readFileSync(secretFile, 'utf-8').trim();
    } catch { /* fall through */ }
    if (expected && provided !== expected) {
      const apiToken = (() => {
        try { return fs.readFileSync(dataPath('api-token'), 'utf-8').trim(); }
        catch { return ''; }
      })();
      // The master token still works so an existing setup keeps running.
      if (!apiToken || provided !== apiToken) {
        sendJson({ error: 'Unauthorized' }, 401);
        return;
      }
    }

    const body = req.body as {
      agent_id?: string;
      agent_name?: string;
      project_path?: string;
      message?: string;
      model?: string;
      permission_mode?: 'normal' | 'auto' | 'bypass';
      dry_run?: boolean;
    };

    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      sendJson({ error: 'message is required' }, 400);
      return;
    }

    let agent = body.agent_id ? agents.get(body.agent_id) : undefined;

    if (!agent && typeof body.agent_name === 'string' && body.agent_name.trim()) {
      const nameLc = body.agent_name.trim().toLowerCase();
      const matches = Array.from(agents.values()).filter(a =>
        (a.name || '').toLowerCase() === nameLc
        && (!body.project_path || a.projectPath === body.project_path)
      );
      if (matches.length > 1) {
        sendJson({
          error: `Agent name "${body.agent_name}" is ambiguous: pass project_path or agent_id.`,
          matches: matches.map(a => ({ id: a.id, name: a.name, projectPath: a.projectPath })),
        }, 409);
        return;
      }
      agent = matches[0];
    }

    if (!agent) {
      sendJson({
        error: 'Agent not found. Pass agent_id, or agent_name (+ project_path when ambiguous).',
        agents: Array.from(agents.values()).map(a => ({ id: a.id, name: a.name, projectPath: a.projectPath, status: a.status })),
      }, 404);
      return;
    }

    if (body.dry_run) {
      // Config check for the Hermes side: auth passed, agent resolved. Stop
      // before dispatching anything.
      sendJson({
        success: true,
        dry_run: true,
        agent: { id: agent.id, name: agent.name, projectPath: agent.projectPath, status: agent.status },
      });
      return;
    }

    await performDispatch(agent, {
      message,
      model: body.model,
      permissionMode: body.permission_mode,
    }, ctx, sendJson);
  });
}
