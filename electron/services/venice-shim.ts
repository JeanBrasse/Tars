import * as http from 'http';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { VENICE_SHIM_PORT } from '../constants';
import { getApiToken } from './api-server';
import { readAppSettingsFromDisk } from '../providers/cli-provider';

/**
 * WHY THIS FILE EXISTS
 *
 * Venice AI's API is OpenAI-compatible only - /chat/completions, no
 * /v1/messages, confirmed against docs.venice.ai. The claude binary only ever
 * speaks the Anthropic Messages wire format, so reaching Venice needs a
 * translator sitting between them. This is that translator, both directions,
 * streaming and not.
 *
 * WHY IT IS ITS OWN SERVER, NOT A ROUTE UNDER /api/*
 *
 * api-server.ts guards every /api/* route with `Authorization: Bearer
 * <token>`, except exactly four paths (see its own comment and CLAUDE.md's
 * Backend Agent rules - that count is a hard invariant, not a suggestion).
 * The claude binary does not send an Authorization header to whatever
 * ANTHROPIC_BASE_URL points at; it sends `x-api-key`. Putting this behind
 * /api/* would mean either breaking that invariant with a fifth exemption, or
 * the shim would 401 every request before its own handler ever ran. So this
 * runs as a second, separate, loopback-only http.Server, and authenticates
 * the same way in spirit: it requires `x-api-key` to equal Tars's own local
 * API token (the same secret api-server.ts already generates and guards at
 * 0600), which venice-provider.ts hands to the PTY as ANTHROPIC_API_KEY. The
 * real Venice key never leaves this process: it is read from
 * app-settings.json per request and attached only to the outbound call to
 * Venice, never handed to the claude binary.
 *
 * WHAT IS TRANSLATED
 *
 * Request: system prompt, message content blocks (text/image/tool_use/
 * tool_result), tools + tool_choice, streaming flag. Response: content
 * blocks, stop_reason, usage, and for streaming, Anthropic's block-delta SSE
 * events synthesized from OpenAI's chat-completion-chunk deltas.
 *
 * Left out on purpose, because a coding agent's turn loop does not exercise
 * them and the other alt providers already ship without them: prompt
 * caching (cache_control), the Batches API, PDF blocks, extended-thinking
 * blocks (dropped rather than round-tripped - OpenAI has no wire equivalent
 * and the turn loop does not need them echoed back), citations, and
 * tool_choice beyond auto/any/none/tool.
 *
 * /v1/messages/count_tokens: the claude binary preflights every turn with
 * this and Venice, being OpenAI-compatible, has no equivalent endpoint. Ollama
 * hits the identical gap by returning 404, which multiple users report makes
 * Ollama's own server degrade into escalating 500s (ollama/ollama#13949).
 * Since this shim is Tars's own code, the fix here is simpler than working
 * around a third party: just answer the preflight, with a coarse
 * characters/4 estimate, rather than 404ing and hoping the CLI tolerates it.
 */

const VENICE_API_BASE = 'https://api.venice.ai/api/v1';

let shimServer: http.Server | null = null;

// ── Anthropic -> OpenAI (request) ───────────────────────────────────

interface OAMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

function flattenSystemText(system: unknown): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => b.text)
      .join('\n\n');
  }
  return '';
}

function blockToOpenAIContentPart(block: Record<string, any>): Record<string, unknown> {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') {
    const src = block.source || {};
    if (src.type === 'base64') {
      return { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } };
    }
    if (src.type === 'url') {
      return { type: 'image_url', image_url: { url: src.url } };
    }
  }
  // Fail loudly rather than silently drop: a block Tars doesn't understand
  // is a turn the agent will misinterpret if it goes through half-translated.
  throw new Error(`Unsupported Anthropic content block type for Venice: ${block.type}`);
}

function anthropicMessagesToOpenAI(messages: Array<Record<string, any>>): OAMessage[] {
  const out: OAMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const parts: Record<string, unknown>[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    const toolResultMessages: OAMessage[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
        case 'image':
          parts.push(blockToOpenAIContentPart(block));
          break;
        case 'tool_use':
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
          break;
        case 'tool_result': {
          const content = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
              : JSON.stringify(block.content ?? '');
          toolResultMessages.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
          break;
        }
        case 'thinking':
        case 'redacted_thinking':
          // No OpenAI wire equivalent; the turn loop does not need it echoed
          // back, so it is dropped rather than failed (see file header).
          break;
        default:
          throw new Error(`Unsupported Anthropic content block type for Venice: ${block.type}`);
      }
    }

    if (toolCalls.length > 0) {
      out.push({ role: 'assistant', content: parts.length ? parts : null, tool_calls: toolCalls });
    } else if (parts.length > 0) {
      // A lone text part collapses to a plain string: most Venice models were
      // tuned against plain-string content, only vision needs the array form.
      const content = parts.length === 1 && parts[0].type === 'text' ? (parts[0] as { text: string }).text : parts;
      out.push({ role: msg.role, content });
    }

    out.push(...toolResultMessages);
  }

  return out;
}

function anthropicToolsToOpenAI(tools: Array<Record<string, any>> | undefined): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function anthropicToolChoiceToOpenAI(choice: Record<string, any> | undefined): unknown {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { type: 'function', function: { name: choice.name } };
    default: return 'auto';
  }
}

export function anthropicRequestToOpenAI(body: Record<string, any>): Record<string, unknown> {
  const messages: OAMessage[] = [];
  const systemText = flattenSystemText(body.system);
  if (systemText) messages.push({ role: 'system', content: systemText });
  messages.push(...anthropicMessagesToOpenAI(body.messages || []));

  const stream = !!body.stream;
  return {
    model: body.model,
    messages,
    ...(body.tools ? { tools: anthropicToolsToOpenAI(body.tools) } : {}),
    ...(body.tool_choice ? { tool_choice: anthropicToolChoiceToOpenAI(body.tool_choice) } : {}),
    max_tokens: body.max_tokens,
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    stream,
    // Only meaningful with stream:true; asks Venice for a final usage-only
    // chunk so the translated message_delta can carry real output_tokens.
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
}

// ── OpenAI -> Anthropic (response, non-streaming) ───────────────────

const STOP_REASON_MAP: Record<string, string> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'end_turn',
};

export function openAIResponseToAnthropic(json: Record<string, any>, requestedModel: string): Record<string, unknown> {
  const choice = json.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content: Record<string, unknown>[] = [];

  if (message.content) {
    content.push({ type: 'text', text: typeof message.content === 'string' ? message.content : String(message.content) });
  }
  for (const tc of message.tool_calls || []) {
    let input: unknown = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }

  return {
    id: json.id || `msg_${crypto.randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: json.model || requestedModel,
    content,
    stop_reason: STOP_REASON_MAP[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens ?? 0,
      output_tokens: json.usage?.completion_tokens ?? 0,
    },
  };
}

// ── OpenAI -> Anthropic (response, streaming) ───────────────────────

function sseWrite(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamOpenAIAsAnthropic(upstream: Response, res: http.ServerResponse, requestedModel: string): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  sseWrite(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId, type: 'message', role: 'assistant', model: requestedModel,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let nextIndex = 0;
  let textIndex = -1;
  let textOpen = false;
  const toolBlocks = new Map<number, { index: number; id: string; name: string }>();
  let finishReason: string | null = null;
  let outputTokens = 0;

  // Response.body is a web ReadableStream; Readable.fromWeb gives it a typed,
  // guaranteed async iterator rather than relying on lib.dom for one.
  const nodeStream = Readable.fromWeb(upstream.body as any);
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of nodeStream) {
    buffer += decoder.decode(chunk as Buffer, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = rawEvent.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;

      let parsed: Record<string, any>;
      try { parsed = JSON.parse(data); } catch { continue; }

      if (parsed.usage) {
        outputTokens = parsed.usage.completion_tokens ?? outputTokens;
      }

      const choice = parsed.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!textOpen) {
          textIndex = nextIndex++;
          textOpen = true;
          sseWrite(res, 'content_block_start', { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } });
        }
        sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } });
      }

      for (const tc of delta.tool_calls || []) {
        let block = toolBlocks.get(tc.index);
        if (!block) {
          const index = nextIndex++;
          block = { index, id: tc.id || `call_${tc.index}`, name: tc.function?.name || '' };
          toolBlocks.set(tc.index, block);
          sseWrite(res, 'content_block_start', {
            type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
          });
        }
        if (tc.function?.arguments) {
          sseWrite(res, 'content_block_delta', {
            type: 'content_block_delta', index: block.index, delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
          });
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  if (textOpen) sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: textIndex });
  for (const block of toolBlocks.values()) {
    sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: block.index });
  }

  sseWrite(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: STOP_REASON_MAP[finishReason || 'stop'] || 'end_turn', stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  sseWrite(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

// ── /v1/messages/count_tokens ────────────────────────────────────────

/** Anthropic's own rule of thumb for English text; good enough to keep the
 *  CLI's preflight satisfied when there is no real endpoint to ask. */
function estimateTokens(body: Record<string, any>): number {
  const parts: string[] = [];
  if (typeof body.system === 'string') parts.push(body.system);
  else if (Array.isArray(body.system)) parts.push(...body.system.map((b: any) => b?.text || ''));
  for (const msg of body.messages || []) {
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type === 'text') parts.push(b.text || '');
        if (b?.type === 'tool_result' && typeof b.content === 'string') parts.push(b.content);
      }
    }
  }
  const chars = parts.join('\n').length;
  return Math.max(1, Math.ceil(chars / 4));
}

// ── Request handling ─────────────────────────────────────────────────

function sendError(res: http.ServerResponse, status: number, type: string, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

async function handleMessages(anthropicBody: Record<string, any>, res: http.ServerResponse, veniceApiKey: string, signal: AbortSignal): Promise<void> {
  let openAIBody: Record<string, unknown>;
  try {
    openAIBody = anthropicRequestToOpenAI(anthropicBody);
  } catch (err) {
    sendError(res, 400, 'invalid_request_error', (err as Error).message);
    return;
  }

  const upstream = await fetch(`${VENICE_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${veniceApiKey}`,
    },
    body: JSON.stringify(openAIBody),
    signal,
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    sendError(res, upstream.status, 'api_error', text || `Venice returned HTTP ${upstream.status}`);
    return;
  }

  if (openAIBody.stream) {
    await streamOpenAIAsAnthropic(upstream, res, anthropicBody.model);
    return;
  }

  const json = await upstream.json();
  const anthropicResponse = openAIResponseToAnthropic(json, anthropicBody.model);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(anthropicResponse));
}

function handleCountTokens(anthropicBody: Record<string, any>, res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: estimateTokens(anthropicBody) }));
}

// ── Server lifecycle ─────────────────────────────────────────────────

export function startVeniceShimServer(): void {
  if (shimServer) return;

  shimServer = http.createServer(async (req, res) => {
    const expected = getApiToken();
    const provided = req.headers['x-api-key'];
    if (provided !== expected) {
      sendError(res, 401, 'authentication_error', 'Invalid x-api-key');
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${VENICE_SHIM_PORT}`);
    const isMessages = url.pathname === '/v1/messages';
    const isCountTokens = url.pathname === '/v1/messages/count_tokens';
    if (req.method !== 'POST' || (!isMessages && !isCountTokens)) {
      sendError(res, 404, 'not_found_error', 'Not found');
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      sendError(res, 400, 'invalid_request_error', 'Invalid JSON body');
      return;
    }

    if (isCountTokens) {
      handleCountTokens(body, res);
      return;
    }

    const veniceApiKey = readAppSettingsFromDisk().veniceApiKey;
    if (!veniceApiKey) {
      sendError(res, 401, 'authentication_error', 'No Venice API key configured in Tars settings');
      return;
    }

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    try {
      await handleMessages(body, res, veniceApiKey, controller.signal);
    } catch (err) {
      console.error('Venice shim error:', err);
      if (!res.headersSent) {
        sendError(res, 500, 'api_error', String(err));
      } else {
        res.end();
      }
    }
  });

  shimServer.listen(VENICE_SHIM_PORT, '127.0.0.1', () => {
    console.log(`Venice shim server running on http://127.0.0.1:${VENICE_SHIM_PORT}`);
  });

  shimServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${VENICE_SHIM_PORT} is in use, Venice shim not started`);
    } else {
      console.error('Venice shim server error:', err);
    }
  });
}

export function stopVeniceShimServer(): void {
  if (shimServer) {
    shimServer.close();
    shimServer = null;
  }
}
