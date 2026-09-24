import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mount, settle, ofType, textOf, deferred, type Mount } from './hook-runtime';
import { DiscordSection } from '../../src/components/Settings/DiscordSection';
import { SettingsRow } from '../../src/components/Settings/SettingsRow';
import type { AppSettings } from '../../src/components/Settings/types';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * Settings > Discord's invite link, from the main process (#200's contract:
 * `window.electronAPI.discord.inviteUrl(token)`, permissions 3072). The page
 * built its own link until then, with the permissions #200 took away (68608,
 * Read Message History included), so the link it offered and the one the bot's
 * own test returned asked for different things. Written before the section
 * changes, as the ways it can fail:
 * 1. the page still builds the link itself: what "copy invite link" copies is
 *    not what main answered for the token;
 * 2. an answer for a token that is no longer in the field (typed over, a late
 *    reply) is shown or copied;
 * 3. with no answer yet, a null answer, a failed call, or no Discord API at
 *    all, the row offers a link anyway, or the page throws;
 * 4. the row still says the bot may read the channels' history, or names
 *    permissions the link does not carry. #203 adds Send Messages in Threads,
 *    so the sentence says what the bot does, in channels, threads and direct
 *    messages, and the permissions themselves stay main's.
 */

type El = { type: unknown; props: Record<string, unknown> };
const g = globalThis as unknown as { window?: unknown; navigator?: unknown };
const TOKEN_A = 'MTE4NzM0MjE1NTYyODExODA2Nw.GhXyZa.first-token-secret';
const TOKEN_B = 'MjgzNzQ2NTEwMjkzODQ3NTYx.GhXyZa.second-token-secret';
const LINK_A = 'https://discord.com/oauth2/authorize?client_id=1187342155628118067&scope=bot&permissions=3072';
const LINK_B = 'https://discord.com/oauth2/authorize?client_id=283746510293847561&scope=bot&permissions=3072';
const READY = 'Adds the bot to a server of yours, allowed to see channels and send messages, in channels, threads and direct messages.';
const WAITING = 'Set the bot token first: the link is made from it.';

let page: Mount<unknown> | null = null;
const copied: string[] = [];
const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
beforeEach(() => {
  copied.length = 0;
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  page?.unmount();
  page = null;
  delete g.window;
  if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore);
  else delete g.navigator;
});

/** The section on a token, with main's inviteUrl answered by `answer`. */
function section(answer?: (token: string) => Promise<string | null>) {
  const asked: string[] = [];
  g.window = answer
    ? { electronAPI: { discord: { inviteUrl: (token: string) => { asked.push(token); return answer(token); } } } }
    : {};
  const settings = { discordEnabled: true, discordBotToken: TOKEN_A } as unknown as AppSettings;
  page = mount(() => DiscordSection({ appSettings: settings, onSaveAppSettings: () => {}, onUpdateLocalSettings: () => {} }));
  const row = () => (ofType(page!.result, SettingsRow) as unknown as El[]).find(el => el.props.label === 'Invite')!;
  const button = () => row().props.control as El;
  return {
    asked,
    retype: (token: string) => { settings.discordBotToken = token; page!.rerender(); },
    said: () => textOf(row().props.description as never),
    disabled: () => button().props.disabled as boolean,
    copy: async () => { (button().props.onClick as () => Promise<void>)(); await settle(); },
  };
}

describe("the invite link is main's (#200)", () => {
  it('copies exactly what main answered for the token in the field (1)', async () => {
    const s = section(async token => (token === TOKEN_A ? LINK_A : null));
    await settle();
    expect(s.asked).toEqual([TOKEN_A]);
    expect(s.disabled()).toBe(false);
    expect(s.said()).toBe(READY);
    await s.copy();
    expect(copied).toEqual([LINK_A]);
  });

  it('never shows or copies an answer for a token that is no longer in the field (2)', async () => {
    const late = deferred<string | null>();
    const s = section(token => (token === TOKEN_A ? late.promise : Promise.resolve(LINK_B)));
    s.retype(TOKEN_B);
    await settle();
    late.resolve(LINK_A);
    await settle();
    expect(s.asked).toEqual([TOKEN_A, TOKEN_B]);
    await s.copy();
    expect(copied).toEqual([LINK_B]);
  });

  it('offers no link before main has answered for the token being typed (2, 3)', async () => {
    const pending = deferred<string | null>();
    const s = section(token => (token === TOKEN_A ? Promise.resolve(LINK_A) : pending.promise));
    await settle();
    s.retype(TOKEN_B);
    expect(s.disabled()).toBe(true);
    expect(s.said()).toBe(WAITING);
    await s.copy();
    expect(copied).toEqual([]);
  });

  it.each([
    ['main answers null', async () => null],
    ['the call fails', async () => { throw new Error('no handler for discord:inviteUrl'); }],
  ])('offers no link when %s (3)', async (_what, answer) => {
    const s = section(answer);
    await settle();
    expect(s.disabled()).toBe(true);
    expect(s.said()).toBe(WAITING);
    await s.copy();
    expect(copied).toEqual([]);
  });

  it('offers no link, and does not throw, outside the app (3)', async () => {
    const s = section();
    await settle();
    expect(s.disabled()).toBe(true);
    expect(s.said()).toBe(WAITING);
  });
});
