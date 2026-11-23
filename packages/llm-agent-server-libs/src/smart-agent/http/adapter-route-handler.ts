import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RagCaller } from '@mcp-abap-adt/llm-agent';
import {
  AdapterValidationError,
  buildExternalResults,
  contextExceededError,
  type ILlmApiAdapter,
  MODEL_CONTEXT_EXCEEDED,
  type NormalizedRequest,
  terminalRunError,
} from '@mcp-abap-adt/llm-agent';
import type { SessionGraph, SmartAgent } from '@mcp-abap-adt/llm-agent-libs';
import { canWrite, createRequestAbort } from './request-abort.js';
import {
  jsonError,
  readBody,
  streamWithContextOverflow,
} from './response-helpers.js';
import { attachSseKeepAlive } from './sse-heartbeat.js';

/**
 * POST /v1/messages handler (Anthropic adapter route), extracted verbatim from
 * SmartServer._handleAdapterRequest. Pure — no SmartServer state is touched.
 */
export async function handleAdapterRequest(
  req: IncomingMessage,
  res: ServerResponse,
  agent: SmartAgent,
  adapter: ILlmApiAdapter,
  session:
    | {
        sessionId: string;
        traceId: string;
        graph: SessionGraph;
        caller: RagCaller;
      }
    | undefined,
  heartbeatIntervalMs: number | undefined,
  log?: (e: Record<string, unknown>) => void,
): Promise<void> {
  if (!session) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(jsonError('Caller identity required', 'access_denied'));
    return;
  }
  const t0 = Date.now();
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(jsonError('Invalid JSON', 'invalid_request_error'));
    return;
  }

  let normalized: NormalizedRequest;
  try {
    normalized = adapter.normalizeRequest(body);
  } catch (err) {
    if (err instanceof AdapterValidationError) {
      res.writeHead(err.statusCode, { 'Content-Type': 'application/json' });
      res.end(jsonError(err.message, 'invalid_request_error'));
      return;
    }
    throw err;
  }

  // #171 (review#8): the adapter has already normalized Anthropic
  // tool_use/tool_result blocks into the OpenAI-shaped Message[]
  // (assistant.tool_calls + role:'tool' with tool_call_id). Run the same
  // external-results extraction the OpenAI path uses so Anthropic clients get
  // identical stateless-resume behaviour: the full history is preserved and
  // results are also threaded to the agent keyed by the returned `ext:` call ID.
  const { results: externalResults, sanitizedMessages } = buildExternalResults(
    normalized.messages,
  );

  // Client disconnect before the response finished cancels the whole request.
  const abort = createRequestAbort(res);
  const logCancelled = (): void =>
    log?.({ event: 'request_cancelled', durationMs: Date.now() - t0 });

  const augmentedOptions = session
    ? {
        ...normalized.options,
        signal: abort.signal,
        sessionId: session.sessionId,
        caller: session.caller,
        userId: session.caller.userId,
        trace: { traceId: session.traceId },
        toolAvailability: session.graph.toolAvailability,
        pendingToolResults: session.graph.pendingToolResults,
        externalResults,
      }
    : { ...normalized.options, signal: abort.signal, externalResults };

  if (normalized.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const keepAlive = attachSseKeepAlive(res, heartbeatIntervalMs);
    try {
      for await (const event of adapter.transformStream(
        streamWithContextOverflow(
          agent.streamProcess(sanitizedMessages, augmentedOptions),
        ),
        normalized.context,
      )) {
        if (!canWrite(res, abort.signal)) break;
        keepAlive.reset();
        const eventLine = event.event ? `event: ${event.event}\n` : '';
        res.write(`${eventLine}data: ${event.data}\n\n`);
      }
    } catch (err) {
      if (!abort.signal.aborted) throw err;
      logCancelled();
      return;
    } finally {
      keepAlive.stop();
    }
    if (!canWrite(res, abort.signal)) {
      logCancelled();
      return;
    }
    res.end();
    return;
  }

  // Non-streaming
  let result: Awaited<ReturnType<SmartAgent['process']>>;
  try {
    result = await agent.process(sanitizedMessages, augmentedOptions);
  } catch (err) {
    const overflow = contextExceededError(err);
    if (overflow) result = { ok: false, error: overflow };
    else {
      if (!abort.signal.aborted) throw err;
      logCancelled();
      return;
    }
  }
  if (!canWrite(res, abort.signal)) {
    logCancelled();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  if (!result.ok) {
    const failure = terminalRunError(result.error) ?? result.error;
    res.writeHead(failure.code === MODEL_CONTEXT_EXCEEDED ? 400 : 500);
    res.end(
      JSON.stringify(
        adapter.formatError?.(failure, normalized.context) ?? {
          error: {
            message: failure.message,
            type: failure.code,
          },
        },
      ),
    );
    return;
  }
  res.writeHead(200);
  res.end(
    JSON.stringify(adapter.formatResult(result.value, normalized.context)),
  );
}
