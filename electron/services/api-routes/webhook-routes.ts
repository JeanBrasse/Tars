import { agents } from '../../core/agent-manager';
import { performDispatch } from './agent-routes';
import { RouteApp, RouteContext } from './types';

const HERMES_ONLY =
  'This route is Hermes\'s, and only the webhook secret Settings hands Hermes opens it. '
  + 'An agent gives another work through /api/agents/:id/dispatch.';

/**
 * Incoming webhooks: lets an external scheduler (the user's Hermes instance)
 * drive Tars agents. Tars deliberately has no scheduler of its own:
 * Hermes cron jobs / automation blueprints call this endpoint instead.
 *
 * Auth: the webhook secret, `~/.tars-private/hermes-webhook-secret`, and
 * nothing else. The server's door takes that secret for Hermes on this path
 * and on no other; this route opens to Hermes alone. Not the shared token,
 * which it used to take as a fallback "so an existing setup keeps running":
 * every agent reads that token, and this route dispatches to any agent of any
 * project, by name. Not an agent's own token, which has /dispatch, inside its
 * own project. And not nothing: with no secret configured the check here was
 * skipped, so whatever the door let in went through. Measured on bad8c97: the
 * shared token with a secret configured, and the shared token or an agent's
 * token with none, each got a 200 and had the message typed into the agent it
 * named, the agent's token into another project's.
 *
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
    if (!req.hermes) {
      sendJson({ error: HERMES_ONLY }, 403);
      return;
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
