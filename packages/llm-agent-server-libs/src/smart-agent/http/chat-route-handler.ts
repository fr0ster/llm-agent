import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildExternalResults,
  type IModelProvider,
  type IRequestLogger,
  type Message,
  normalizeAndValidateExternalTools,
  type StreamToolCall,
  toToolCallDelta,
} from '@mcp-abap-adt/llm-agent';
import {
  type SessionGraph,
  SessionLogger,
  type SmartAgent,
  type SmartAgentHandle,
  type StopReason,
} from '@mcp-abap-adt/llm-agent-libs';
import type { SmartServerConfig } from '../smart-server.js';
import { resolveTraceSink } from './debug-trace-sink.js';
import {
  jsonError,
  jsonValidationError,
  mapStopReason,
  readBody,
} from './response-helpers.js';

/**
 * POST /v1/chat/completions handler (OpenAI-compatible), extracted verbatim
 * from SmartServer._handleChat. The only change vs. the original is that the
 * three `this.cfg` reads are now the trailing `cfg` parameter.
 */
export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  _requestLogger: IRequestLogger,
  smartAgent: SmartAgent,
  _chat: SmartAgentHandle['chat'],
  _streamChat: SmartAgentHandle['streamChat'],
  log: (e: Record<string, unknown>) => void,
  modelProvider: IModelProvider | undefined,
  session:
    | { sessionId: string; traceId: string; graph: SessionGraph }
    | undefined,
  cfg: SmartServerConfig,
): Promise<void> {
  const rawBody = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(jsonError('Invalid JSON body', 'invalid_request_error'));
    return;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).messages)
  ) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      jsonError('messages must be a non-empty array', 'invalid_request_error'),
    );
    return;
  }

  const body = parsed as {
    messages: Array<{
      role: string;
      content: unknown;
      tool_call_id?: unknown;
      tool_calls?: unknown;
    }>;
    model?: string;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    stop?: string | string[];
    tools?: unknown[];
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
  };

  const extractText = (c: unknown): string => {
    if (c === null || c === undefined) return '';
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return '';
    return c
      .filter(
        (b): b is { type: 'text'; text: string } =>
          typeof b === 'object' &&
          b !== null &&
          (b as { type?: unknown }).type === 'text' &&
          typeof (b as { text?: unknown }).text === 'string',
      )
      .map((b) => b.text)
      .join('\n');
  };

  const userMessages = body.messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      jsonError(
        'at least one message with role "user" is required',
        'invalid_request_error',
      ),
    );
    return;
  }

  // Prefer the session injected by `_withSession` (cookie identity); fall
  // back to the legacy x-session-id header / 'default' bucket only when no
  // session was wired (defensive — production routes always inject one).
  const traceId = session?.traceId ?? randomUUID();
  const sessionId =
    session?.sessionId ?? (req.headers['x-session-id'] as string) ?? 'default';
  const traceSink = resolveTraceSink(cfg.logDir);
  const sessionLogger = new SessionLogger(
    traceSink.dir,
    sessionId,
    traceId,
    traceSink.enabledAreas,
  );
  const toolsValidationMode =
    cfg.agent?.externalToolsValidationMode ?? 'permissive';
  const externalToolsValidation = normalizeAndValidateExternalTools(body.tools);
  const externalTools = externalToolsValidation.tools;
  if (externalToolsValidation.errors.length > 0) {
    log({
      event: 'invalid_external_tools_detected',
      traceId,
      sessionId,
      mode: toolsValidationMode,
      count: externalToolsValidation.errors.length,
      errors: externalToolsValidation.errors,
    });
    sessionLogger.logStep('invalid_external_tools_detected', {
      mode: toolsValidationMode,
      count: externalToolsValidation.errors.length,
      errors: externalToolsValidation.errors,
    });
    if (toolsValidationMode === 'strict') {
      const firstError = externalToolsValidation.errors[0];
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        jsonValidationError(
          firstError.message,
          firstError.code,
          firstError.param,
        ),
      );
      return;
    }
  }

  const t0 = Date.now();
  log({ event: 'request_start', stream: body.stream ?? false, traceId });

  const opts = {
    stream: body.stream,
    externalTools,
    sessionId,
    trace: { traceId },
    sessionLogger,
    model: body.model,
    ...(session
      ? {
          toolAvailability: session.graph.toolAvailability,
          pendingToolResults: session.graph.pendingToolResults,
        }
      : {}),
    ...(body.temperature !== undefined
      ? { temperature: body.temperature }
      : {}),
    ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
    ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
    ...(body.stop !== undefined
      ? { stop: Array.isArray(body.stop) ? body.stop : [body.stop] }
      : {}),
  };

  const responseModel =
    body.model ?? modelProvider?.getModel() ?? 'smart-agent';

  const normalizedMessages = body.messages
    .map((m) => {
      const role = m.role as Message['role'];
      const normalizedMessage: Message = {
        role,
        content: extractText(m.content),
      };

      if (role === 'tool') {
        if (typeof m.tool_call_id === 'string' && m.tool_call_id.trim()) {
          normalizedMessage.tool_call_id = m.tool_call_id;
        } else {
          sessionLogger.logStep('drop_orphan_tool_message', {
            reason: 'missing_tool_call_id',
          });
          return null;
        }
      }

      if (role === 'assistant' && Array.isArray(m.tool_calls)) {
        const toolCalls = m.tool_calls
          .filter(
            (
              tc,
            ): tc is {
              id: string;
              type: 'function';
              function: { name: string; arguments: string };
            } =>
              typeof tc === 'object' &&
              tc !== null &&
              typeof (tc as { id?: unknown }).id === 'string' &&
              (tc as { type?: unknown }).type === 'function' &&
              typeof (tc as { function?: { name?: unknown } }).function
                ?.name === 'string' &&
              typeof (tc as { function?: { arguments?: unknown } }).function
                ?.arguments === 'string',
          )
          .map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          }));

        if (toolCalls.length > 0) {
          normalizedMessage.tool_calls = toolCalls;
          if (!normalizedMessage.content) normalizedMessage.content = null;
        }
      }

      return normalizedMessage;
    })
    .filter((m): m is Message => m !== null);

  // #171 (review#11): consume external (client-executed) tool result turns
  // from the incoming history into a validated `extId → result` map and strip
  // those raw turns from the messages forwarded to the agent (so no internal
  // LLM call ever sees an unmatched assistant tool_calls). On a normal request
  // with no external history this returns the messages unchanged + an empty
  // map — a safe no-op. The map is threaded via options.externalResults.
  const { results: externalResults, sanitizedMessages } =
    buildExternalResults(normalizedMessages);

  const invalidToolsHeader =
    externalToolsValidation.errors.length > 0
      ? {
          'x-smartagent-invalid-tools': String(
            externalToolsValidation.errors.length,
          ),
        }
      : {};

  if (body.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...invalidToolsHeader,
    });
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    const stream = smartAgent.streamProcess(sanitizedMessages, {
      ...opts,
      externalResults,
    });
    let firstChunk = true;
    let finishReasonSent = false;
    let lastUsage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | null = null;

    for await (const chunk of stream) {
      if (!chunk.ok) {
        const errorChunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: responseModel,
          choices: [
            {
              index: 0,
              delta: { content: `[Error] ${chunk.error.message}` },
              finish_reason: 'stop',
            },
          ],
        };
        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        finishReasonSent = true;
        break;
      }
      // SSE heartbeat comment — keeps connection alive, ignored by clients
      if (chunk.value.heartbeat) {
        const hb = chunk.value.heartbeat;
        res.write(`: heartbeat tool=${hb.tool} elapsed=${hb.elapsed}ms\n\n`);
        continue;
      }
      // SSE timing breakdown comment — sent with the final chunk
      if (chunk.value.timing) {
        const parts = chunk.value.timing.map(
          (t: { phase: string; duration: number }) =>
            `${t.phase}=${t.duration}ms`,
        );
        res.write(`: timing ${parts.join(' ')}\n\n`);
      }
      if (chunk.value.usage) {
        lastUsage = {
          prompt_tokens: chunk.value.usage.promptTokens,
          completion_tokens: chunk.value.usage.completionTokens,
          total_tokens: chunk.value.usage.totalTokens,
        };
      }
      const baseResponse = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        usage: null,
      };

      if (firstChunk) {
        res.write(
          `data: ${JSON.stringify({ ...baseResponse, choices: [{ index: 0, delta: { role: 'assistant', content: chunk.value.content || '' }, finish_reason: null }] })}\n\n`,
        );
        firstChunk = false;
        if (!chunk.value.finishReason && !chunk.value.toolCalls) continue;
      }

      if (chunk.value.content || chunk.value.toolCalls) {
        const delta: Record<string, unknown> = {};
        if (chunk.value.content) delta.content = chunk.value.content;
        if (chunk.value.toolCalls) {
          delta.tool_calls = chunk.value.toolCalls.map(
            (call: StreamToolCall, index: number) => {
              const tc = toToolCallDelta(call, index);
              return {
                index: tc.index,
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: tc.arguments || '',
                },
              };
            },
          );
        }
        res.write(
          `data: ${JSON.stringify({ ...baseResponse, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
      }

      if (chunk.value.finishReason) {
        res.write(
          `data: ${JSON.stringify({ ...baseResponse, choices: [{ index: 0, delta: {}, finish_reason: mapStopReason(chunk.value.finishReason as StopReason) }] })}\n\n`,
        );
        finishReasonSent = true;
      }
    }

    if (!finishReasonSent) {
      const baseResponse = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: responseModel,
        usage: null,
      };
      res.write(
        `data: ${JSON.stringify({ ...baseResponse, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      );
    }

    if (
      (cfg.reportUsage !== false || body.stream_options?.include_usage) &&
      lastUsage
    ) {
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: responseModel, choices: [], usage: lastUsage })}\n\n`,
      );
    }
    res.write('data: [DONE]\n\n');
    res.end();
    log({
      event: 'request_done',
      ok: true,
      stream: true,
      finishReason: finishReasonSent ? 'sent' : 'fallback_stop',
      durationMs: Date.now() - t0,
    });
    return;
  }

  const result = await smartAgent.process(sanitizedMessages, {
    ...opts,
    externalResults,
  });
  log({ event: 'request_done', ok: result.ok, durationMs: Date.now() - t0 });
  const finalContent = result.ok
    ? result.value.content || (result.value.toolCalls ? null : '(no response)')
    : `Error: ${result.error.message}`;
  const finalFinishReason = result.ok
    ? mapStopReason(result.value.stopReason)
    : 'stop';
  let finalUsage = null;
  if (result.ok && result.value.usage) {
    finalUsage = {
      prompt_tokens: result.value.usage.promptTokens,
      completion_tokens: result.value.usage.completionTokens,
      total_tokens: result.value.usage.totalTokens,
    };
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: finalContent,
  };
  if (result.ok && result.value.toolCalls) {
    message.tool_calls = result.value.toolCalls;
  }

  res.writeHead(200, {
    'Content-Type': 'application/json',
    ...invalidToolsHeader,
  });
  res.end(
    JSON.stringify({
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: responseModel,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finalFinishReason,
        },
      ],
      usage: finalUsage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    }),
  );
}
