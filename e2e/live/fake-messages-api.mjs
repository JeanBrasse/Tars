// A Messages API for the live specs: real Claude Code talks to it through
// ANTHROPIC_BASE_URL, with no credentials and no network. `LINES <n> <tag>` in
// the last user turn is answered with n numbered lines, anything else with
// "ok", streamed the way the real API streams; nothing ever asks for a tool.
// Every request is logged as one JSON line to FAKE_LOG, which is how a spec
// knows a turn reached the model. Adapted from the Frontend's #132 proof.
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.FAKE_PORT);
const LOG = process.env.FAKE_LOG;
if (!PORT || !LOG) throw new Error('FAKE_PORT and FAKE_LOG are required');

const log = entry => fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
const sse = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

function textOf(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content || []).map(block => (block.type === 'text' ? block.text : block.type === 'tool_result' ? '[tool_result]' : '')).join('\n');
}

function reply(res, model, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, 'message_start', {
    message: {
      id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  sse(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  sse(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  sse(res, 'content_block_stop', { index: 0 });
  sse(res, 'message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  sse(res, 'message_stop', {});
  res.end();
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    let json = {};
    try { json = JSON.parse(body || '{}'); } catch { /* an empty or odd body is answered like any other */ }
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); return res.end('{}'); }
    if (req.url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"input_tokens":10}');
    }
    const model = json.model || 'model';
    const messages = json.messages || [];
    let k = messages.length - 1;
    while (k >= 0 && messages[k].role !== 'assistant') k--;
    const last = messages.slice(k + 1).map(textOf).join('\n').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
    const side = String(model).includes('haiku');
    // The command the turn carries, which Claude Code follows with context of its
    // own: logging the end of the turn would lose it.
    log({ url: req.url, model, stream: !!json.stream, side, last: (last.match(/LINES \d+ \w+/) || [last.slice(0, 200)])[0] });
    if (!json.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'msg_x', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
      }));
    }
    const lines = !side && last.match(/LINES (\d+) (\w+)/);
    if (lines) {
      return reply(res, model, Array.from({ length: Number(lines[1]) }, (_, i) => `${lines[2]} line ${i + 1} of ${lines[1]}`).join('\n'));
    }
    return reply(res, model, 'ok');
  });
}).listen(PORT, '127.0.0.1', () => log({ listening: PORT }));
