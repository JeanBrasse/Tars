import { RouteApp, RouteContext } from './types';
import { instanceProof } from '../../core/agent-tokens';

export function registerHealthRoutes(app: RouteApp, _ctx: RouteContext): void {
  app.get('/api/health', (req, sendJson) => {
    // A hook's check before it sends its token (#11): the proof for its
    // challenge, never the id. Unauthenticated, like the rest of this route.
    const proof = instanceProof(req.url?.searchParams.get('challenge'));
    sendJson(proof ? { ok: true, proof } : { ok: true });
  });
}
