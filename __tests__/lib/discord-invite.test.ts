/**
 * The invite link Settings > Discord builds from a bot token, before any test
 * has asked Discord (src/lib/discord-invite.ts; the contract is #193's body).
 *
 * A Discord bot token is three dot-separated parts, the first the bot's user
 * id in base64url. The link is
 * `https://discord.com/oauth2/authorize?client_id=<id>&scope=bot&permissions=68608`
 * (view channels, send messages, read message history).
 *
 * Written before the function, as every way it can go wrong:
 * 1. no token: an empty or blank field has no bot to invite;
 * 2. a pasted token with spaces or a newline around it: the id is the same;
 * 3. base64url, not base64: `-` and `_` stand for `+` and `/`, and the
 *    padding is left off, so a plain `atob` refuses a valid first part;
 * 4. a first part that is not base64 at all: no link, rather than a throw that
 *    takes the Settings page down while you type;
 * 5. a first part that decodes to something other than digits (a token from
 *    another service pasted by mistake): no link to a client that is not one;
 * 6. digits, but not 17 to 20 of them: not a Discord id, so no link;
 * 7. a token with no dot at all (only an id pasted): no token, no link, even
 *    though the part decodes;
 * 8. the link itself: exactly the contract's, the id in `client_id` and
 *    nothing else of the token in it (the rest of a token is its secret).
 */
import { describe, expect, it } from 'vitest';
import { discordInviteUrl } from '../../src/lib/discord-invite';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = (id: string) => `${b64url(id)}.GhXyZa.secret-part_of-the-token`;
const link = (id: string) => `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=68608`;

describe('discordInviteUrl', () => {
  it('has no link without a token (1)', () => {
    expect(discordInviteUrl('')).toBeNull();
    expect(discordInviteUrl('   ')).toBeNull();
  });

  it('reads the same id through spaces and a newline around a pasted token (2)', () => {
    expect(discordInviteUrl(`  ${token('1187342155628118067')}\n`)).toBe(link('1187342155628118067'));
  });

  it('decodes base64url without padding, where plain base64 would refuse (3)', () => {
    // 17 digits encode to 23 characters: padding would have been due.
    const id = '12345678901234567';
    expect(b64url(id)).not.toMatch(/=$/);
    expect(discordInviteUrl(token(id))).toBe(link(id));
    // A first part carrying `-` or `_` still decodes, to whatever it holds.
    expect(() => discordInviteUrl('ab-_cd.x.y')).not.toThrow();
  });

  it('gives no link, and does not throw, for a first part that is not base64 (4)', () => {
    expect(() => discordInviteUrl('***.x.y')).not.toThrow();
    expect(discordInviteUrl('***.x.y')).toBeNull();
  });

  it('gives no link for a first part that decodes to something other than digits (5)', () => {
    expect(discordInviteUrl(`${b64url('xoxb-slack-token')}.x.y`)).toBeNull();
    expect(discordInviteUrl(`${b64url('12345678901234567a')}.x.y`)).toBeNull();
  });

  it('gives no link for digits that are not 17 to 20 of them (6)', () => {
    expect(discordInviteUrl(token('1234567890123456'))).toBeNull();
    expect(discordInviteUrl(token('123456789012345678901'))).toBeNull();
    expect(discordInviteUrl(token('12345678901234567890'))).toBe(link('12345678901234567890'));
  });

  it('gives no link for an id pasted alone, with no token behind it (7)', () => {
    expect(discordInviteUrl(b64url('1187342155628118067'))).toBeNull();
  });

  it('builds exactly the contract’s link, with nothing of the secret in it (8)', () => {
    const url = discordInviteUrl(token('283746510293847561'));
    expect(url).toBe(link('283746510293847561'));
    expect(url).not.toContain('secret');
    expect(url).not.toContain('GhXyZa');
  });
});
