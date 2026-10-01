import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the tars-relay Hermes plugin's dashboard routes (hermes-plugins/tars-relay), over real HTTP on the
 * loopback, for the tests of Tars's side of the relay. Its answers have the plugin's shapes: POST /send gives
 * {message_id}, GET /replies?after=N gives {replies: [...]}, POST /ack {through} gives {deleted}, GET /status gives
 * {configured, ...}. Every route wants the dashboard's session token, as Hermes's dashboard does.
 *
 * `mode` makes it misbehave as a real gateway can: 'down' drops every connection, 'missing' answers 404 (no plugin
 * installed), 'unauthorized' 401, 'unconfigured' says so on /status and refuses /send with 503.
 */
export interface FakeRelayReply {
  seq: number;
  at: number;
  kind: 'reply' | 'project';
  ref: string;
  project: string;
  chat_id: string;
  user_id: string;
  message_id: string;
  reply_to_message_id: string;
  text: string;
}

export interface FakeRelay {
  port: number;
  token: string;
  mode: 'ok' | 'down' | 'missing' | 'unauthorized' | 'unconfigured';
  /** Answers an ack and keeps the replies: an ack lost on the way. */
  ignoreAcks: boolean;
  sends: Array<{ text: string; kind: string; ref: string; project: string; messageId: string; token?: string }>;
  replies: FakeRelayReply[];
  acks: number[];
  /** Every request, in order: method and path. */
  calls: string[];
  /** Noah's reply to a message the relay sent, as the plugin keeps it. */
  reply(to: { messageId: string; ref?: string; project?: string }, text: string): number;
  /** Noah's "@project text", as the plugin keeps it. */
  projectMessage(project: string, text: string): number;
  close(): Promise<void>;
}

const NOAH = '1159000001';

export async function startFakeRelay(token = 'fake-dashboard-token'): Promise<FakeRelay> {
  let nextMessage = 501;
  let nextSeq = 1;
  let nextIncoming = 7001;
  const fake: FakeRelay = {
    port: 0,
    token,
    mode: 'ok',
    ignoreAcks: false,
    sends: [],
    replies: [],
    acks: [],
    calls: [],
    reply(to, text) {
      const sent = fake.sends.find((s) => s.messageId === to.messageId);
      const seq = nextSeq++;
      fake.replies.push({
        seq, at: Date.now() / 1000, kind: 'reply', ref: to.ref ?? sent?.ref ?? '', project: to.project ?? sent?.project ?? '',
        chat_id: NOAH, user_id: NOAH, message_id: String(nextIncoming++), reply_to_message_id: to.messageId, text,
      });
      return seq;
    },
    projectMessage(project, text) {
      const seq = nextSeq++;
      fake.replies.push({
        seq, at: Date.now() / 1000, kind: 'project', ref: '', project,
        chat_id: NOAH, user_id: NOAH, message_id: String(nextIncoming++), reply_to_message_id: '', text,
      });
      return seq;
    },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      fake.calls.push(`${req.method} ${url.pathname}${url.search}`);
      if (fake.mode === 'down') { req.socket.destroy(); return; }
      if (!url.pathname.startsWith('/api/plugins/tars-relay/')) return json(res, 404, { detail: 'Not Found' });
      if (fake.mode === 'missing') return json(res, 404, { detail: 'Not Found' });
      if (fake.mode === 'unauthorized' || req.headers['x-hermes-session-token'] !== fake.token) return json(res, 401, { detail: 'Unauthorized' });
      const route = url.pathname.slice('/api/plugins/tars-relay/'.length);
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { detail: 'not json' }); }
      if (route === 'status' && req.method === 'GET') {
        return json(res, 200, { plugin: 'tars-relay', version: '1.0.0', configured: fake.mode !== 'unconfigured', sends_last_hour: fake.sends.length, waiting_replies: fake.replies.length });
      }
      if (route === 'send' && req.method === 'POST') {
        if (fake.mode === 'unconfigured') return json(res, 503, { detail: 'tars-relay has no user_id in its settings' });
        const messageId = String(nextMessage++);
        fake.sends.push({ text: String(body.text), kind: String(body.kind), ref: String(body.ref ?? ''), project: String(body.project ?? ''), messageId, token: String(req.headers['x-hermes-session-token'] ?? '') });
        return json(res, 200, { message_id: messageId });
      }
      if (route === 'replies' && req.method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? 0);
        return json(res, 200, { replies: fake.replies.filter((r) => r.seq > after) });
      }
      if (route === 'ack' && req.method === 'POST') {
        const through = Number(body.through);
        fake.acks.push(through);
        const before = fake.replies.length;
        if (!fake.ignoreAcks) fake.replies = fake.replies.filter((r) => r.seq > through);
        return json(res, 200, { deleted: before - fake.replies.length });
      }
      return json(res, 404, { detail: 'Not Found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  fake.port = (server.address() as AddressInfo).port;
  return fake;
}
