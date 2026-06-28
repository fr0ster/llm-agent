import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AdapterValidationError,
  buildExternalResults,
  type ILlmApiAdapter,
  type NormalizedRequest,
} from '@mcp-abap-adt/llm-agent';
import type { SessionGraph, SmartAgent } from '@mcp-abap-adt/llm-agent-libs';
import { jsonError, readBody } from './response-helpers.js';

/**
 * POST /v1/messages handler (Anthropic adapter route), extracted verbatim from
 * SmartServer._handleAdapterRequest. Pure — no SmartServer state is touched.
 */
export async function handleAdapterRequest(
  req: IncomingMessage,
  res: ServerResponse,
  agent: SmartAgent,
  adapter: ILlmApiAdapter,
  session?: { sessionId: string; traceId: string; graph: SessionGraph },
): Promise<void> {
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
  // identical stateless-resume behaviour: consumed external turns are stripped
  // and their results threaded to the agent keyed by deterministic `ext:` id.
  const { results: externalResults, sanitizedMessages } = buildExternalResults(
    normalized.messages,
  );

  const augmentedOptions = session
    ? {
        ...normalized.options,
        sessionId: session.sessionId,
        trace: { traceId: session.traceId },
        toolAvailability: session.graph.toolAvailability,
        pendingToolResults: session.graph.pendingToolResults,
        externalResults,
      }
    : { ...normalized.options, externalResults };

  if (normalized.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    for await (const event of adapter.transformStream(
      agent.streamProcess(sanitizedMessages, augmentedOptions),
      normalized.context,
    )) {
      const eventLine = event.event ? `event: ${event.event}\n` : '';
      res.write(`${eventLine}data: ${event.data}\n\n`);
    }
    res.end();
    return;
  }

  // Non-streaming
  const result = await agent.process(sanitizedMessages, augmentedOptions);
  res.setHeader('Content-Type', 'application/json');
  if (!result.ok) {
    res.writeHead(500);
    res.end(
      JSON.stringify(
        adapter.formatError?.(result.error, normalized.context) ?? {
          error: {
            message: result.error.message,
            type: result.error.code,
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
