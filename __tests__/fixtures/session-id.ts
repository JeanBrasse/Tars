import { createHash } from 'node:crypto';

/**
 * A session id the hooks route accepts, named for the test that reads it.
 *
 * The route only takes the UUID a CLI gives its session, so a fixture cannot
 * post `'sess-1'`. The same name always gives the same UUID, and two names
 * never share one, so a test keeps reading as the story it tells.
 */
export function sid(name: string): string {
  const h = createHash('sha256').update(name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
