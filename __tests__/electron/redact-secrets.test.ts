import { describe, it, expect } from 'vitest';
import { redactSecrets, containsSecret } from '../../electron/utils/redact-secrets';

/**
 * Agent output leaves this machine twice: into a Telegram chat, and into the
 * prompt sent to a Hermes gateway that can live anywhere on a tailnet. Both
 * took the raw PTY buffer, stripped ANSI, and sent it. An agent's environment
 * holds ANTHROPIC_API_KEY, and for every provider except the local ones that is
 * the user's real vendor key, so one `env`, one verbose curl or one stack trace
 * that prints its config was enough.
 *
 * The tests below use keys shaped like the real ones but made of obvious filler,
 * so nothing here is a live credential.
 */

/**
 * The fixtures are assembled from parts on purpose.
 *
 * Written as literals they are shaped exactly like real credentials, and
 * GitHub's push protection blocks the whole push on one of them, which is the
 * scanner doing its job. Nothing here is a live secret either way.
 */
const j = (...parts: string[]) => parts.join('');
const FILLER = 'A'.repeat(40);
const JWT = j('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.payload', '.sig');
const KEY = j('sk-', 'ant-', 'api03-', FILLER);

describe('redactSecrets', () => {
  it('takes the key out of an env dump, which is the reported path', () => {
    const out = redactSecrets(`ANTHROPIC_API_KEY=${KEY}\nHOME=/Users/noah`);
    expect(out).not.toContain(KEY);
    expect(out).toContain('ANTHROPIC_API_KEY=');
    // The path beside it is untouched, so the dump is still readable.
    expect(out).toContain('HOME=/Users/noah');
  });

  it('leaves enough of the value to tell which key it was', () => {
    const out = redactSecrets(KEY);
    expect(out).toContain('[redacted]');
    expect(out.startsWith('sk-a')).toBe(true);
  });

  it('catches the vendor prefixes on their own, mid sentence', () => {
    const samples = [
      KEY,
      j('sk-', 'proj-', 'B'.repeat(28)),
      j('AIza', 'C'.repeat(31)),
      j('ghp', '_', 'D'.repeat(30)),
      j('xox', 'b-', '111111111-', 'E'.repeat(16)),
      j('sk-', 'or-', 'v1-', 'F'.repeat(26)),
      j('AKIA', 'IOSFODNN7EXAMPLE'),
    ];
    for (const s of samples) {
      const out = redactSecrets(`the call failed with ${s} in the header`);
      expect(out, s).not.toContain(s);
    }
  });

  it('catches a bearer token and an api-key header from a verbose curl', () => {
    const curl = [
      `> Authorization: Bearer ${JWT}`,
      '> x-api-key: 7bQ2xLmR9vTkA4pZ0nWy',
    ].join('\n');
    const out = redactSecrets(curl);
    expect(out).not.toContain(JWT);
    expect(out).not.toContain('7bQ2xLmR9vTkA4pZ0nWy');
    // The header names survive, so the trace still says what it was doing.
    expect(out).toContain('Authorization: Bearer');
    expect(out).toContain('x-api-key:');
  });

  it('catches a settings file printed into the terminal', () => {
    const json = '{"deepSeekApiKey":"ds3Kq8ZmR2vX7bTnL4pWyE","defaultProjectPath":"/Users/noah/proj"}';
    const out = redactSecrets(json);
    expect(out).not.toContain('ds3Kq8ZmR2vX7bTnL4pWyE');
    expect(out).toContain('/Users/noah/proj');
  });

  it('catches a telegram bot token, which is itself a credential', () => {
    const token = j('123456789', ':', 'AA', 'F'.repeat(33));
    expect(redactSecrets(`token=${token}`)).not.toContain(token);
  });

  it('treats a run of one repeated character as a hand-written placeholder', () => {
    // This is deliberate: `API_KEY=xxxxxxxxxxxx` in a README or a template is
    // not a secret, and redacting it makes the redaction read as noise.
    expect(redactSecrets('API_KEY=xxxxxxxxxxxxxxxx')).toBe('API_KEY=xxxxxxxxxxxxxxxx');
  });

  it('leaves ordinary output alone', () => {
    const prose = [
      'Reading src/app/usage/page.tsx',
      'The API key is set in Settings, under AI Providers.',
      'export API_KEY=not-set',
      'TOKEN=undefined',
      'GITHUB_TOKEN=/Users/noah/.config/gh/hosts.yml',
      'password: xxxxxxxx',
    ].join('\n');
    expect(redactSecrets(prose)).toBe(prose);
  });

  it('does not choke on an empty or huge buffer', () => {
    expect(redactSecrets('')).toBe('');
    const big = 'line of ordinary output\n'.repeat(5000);
    expect(redactSecrets(big)).toBe(big);
  });

  it('redacts every occurrence, not only the first', () => {
    const out = redactSecrets(`${KEY} and again ${KEY}`);
    expect(out).not.toContain(KEY);
    expect(out.match(/\[redacted\]/g)?.length).toBe(2);
  });

  it('containsSecret answers the same question without rewriting', () => {
    expect(containsSecret(`ANTHROPIC_API_KEY=${KEY}`)).toBe(true);
    expect(containsSecret('nothing to see here')).toBe(false);
  });
});
