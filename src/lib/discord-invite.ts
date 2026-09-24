/**
 * The link that invites a Discord bot to a server, built from its token before
 * any test has asked Discord (#193's contract for Settings > Discord).
 *
 * A bot token is three dot-separated parts, the first the bot's user id in
 * base64url, so the link can be offered as soon as the token is typed. A token
 * that does not carry an id gives no link at all, rather than a link to a
 * client that is not one; only the id goes into it, never the rest of the
 * token, which is its secret.
 */

/** View channels, send messages and read message history. */
export const DISCORD_INVITE_PERMISSIONS = 68608;

export function discordInviteUrl(token: string): string | null {
  const [first, ...rest] = token.split('.');
  // A token has its three parts: a field that is blank, or holds an id pasted
  // alone, invites nobody.
  if (!rest.length) return null;
  let id: string;
  try {
    // atob's decoding is forgiving: the padding base64url leaves off and the
    // spaces a paste brings are fine. base64url's own `-` and `_` never occur
    // in an id's encoding (ASCII digits never reach index 62 or 63), so a
    // first part holding one is no id, and atob refusing it says as much.
    id = atob(first);
  } catch {
    return null;
  }
  if (!/^\d{17,20}$/.test(id)) return null;
  return `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=${DISCORD_INVITE_PERMISSIONS}`;
}
