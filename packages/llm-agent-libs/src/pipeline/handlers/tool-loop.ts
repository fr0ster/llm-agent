import {
  addCacheTokenUsage,
  type LlmUsage,
  type LlmUsageAttribution,
  toModelToolMessages,
} from '@mcp-abap-adt/llm-agent';
import { normalizeLoopLimit } from '../../config/normalize-max-iterations.js';
import { withSubmitReport } from '../../coordinator/dialogue/submit-report-tool.js';
import { withUsageCalls } from '../../logger/llm-call-usage.js';
import {
  logToolLoopAttempt,
  recordThrownLlmUsage,
  StreamAttemptUsage,
} from '../../logger/stream-attempt-usage.js';
import { denyRagAccess, ownerBoundQuery } from '../../rag/owner-bound-query.js';
import { ToolResponseRound } from './tool-response-round.js';
/**
 * ToolLoopHandler — streaming LLM call + MCP tool execution loop.
 *
 * This is the "terminal" pipeline stage. It takes over the streaming yield
 * mechanism to push SSE chunks back to the consumer.
 *
 * Reads: `ctx.assembledMessages`, `ctx.activeTools`, `ctx.toolClientMap`,
 *        `ctx.externalTools`, `ctx.mainLlm`
 * Writes: yields chunks via `ctx.yield()`, updates `ctx.timing`
 *
 * ## Config
 *
 * | Field              | Type   | Default     | Description                     |
 * |--------------------|--------|-------------|---------------------------------|
 * | `maxIterations`    | number | from ctx    | Max tool-loop iterations        |
 * | `maxToolCalls`     | number | from ctx    | Max total tool calls per request|
 * | `heartbeatIntervalMs` | number | 5000     | SSE heartbeat interval (ms); `<= 0` or non-finite disables it |
 *
 * ## Includes
 *
 * - Output validation (re-prompts on invalid LLM output)
 * - Tool call classification (internal / external / hallucinated / blocked)
 * - Concurrent tool execution with heartbeat
 * - Tool availability tracking (temporary blacklist)
 */

import type {
  IToolLoopContextStrategy,
  LlmFinishReason,
  LlmTool,
  Message,
  TimingEntry,
} from '@mcp-abap-adt/llm-agent';
import {
  buildNamespacedTools,
  defaultToolNamespace,
  mergeOfferedTools,
  scopedUsage,
  toolNameFromRecord,
  toToolCallDelta,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '../../agent.js';
import { resolveCallerIdentity } from '../../policy/caller-identity.js';
import { fireInternalToolsAsync } from '../../policy/mixed-tool-call-handler.js';
import type { ISpan } from '../../tracer/types.js';
import { LegacyAccumulateContextStrategy } from '../context/tool-loop-context/index.js';
import { ToolLoopControlHistory } from '../context/tool-loop-control-history.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
import { normalizeHeartbeatMs } from './normalize-heartbeat-ms.js';
import {
  classifyToolCalls,
  executeToolBatchWithHeartbeat,
  filterAvailableTools,
  guardToolRound,
  injectPendingResults,
  injectToolPriority,
  pendingSourceMessages,
  readTaskFinish,
  runOutputValidationReprompt,
} from './tool-loop-core.js';
import { wrapFinalResponse } from './wrap-final-response.js';

function summarizeIterationMessages(
  messages: Message[],
): Record<string, unknown> {
  const totalChars = messages.reduce((sum, msg) => {
    const content =
      typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content ?? '');
    return sum + content.length;
  }, 0);

  return {
    messageCount: messages.length,
    totalChars,
    roles: messages.map((msg, index) => ({
      index,
      role: msg.role,
      contentLength:
        typeof msg.content === 'string'
          ? msg.content.length
          : JSON.stringify(msg.content ?? '').length,
      hasToolCalls: 'tool_calls' in msg && Array.isArray(msg.tool_calls),
      toolCallCount:
        'tool_calls' in msg && Array.isArray(msg.tool_calls)
          ? msg.tool_calls.length
          : 0,
      toolCallId: 'tool_call_id' in msg ? (msg.tool_call_id ?? null) : null,
    })),
    tail: messages.slice(-6).map((msg, index) => {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content ?? '');
      return {
        index: messages.length - Math.min(messages.length, 6) + index,
        role: msg.role,
        preview:
          content.length > 240
            ? `${content.slice(0, 240)}...[truncated]`
            : content,
        hasToolCalls: 'tool_calls' in msg && Array.isArray(msg.tool_calls),
        toolCallNames:
          'tool_calls' in msg && Array.isArray(msg.tool_calls)
            ? msg.tool_calls.map((tc) => tc.function?.name || '')
            : [],
        toolCallId: 'tool_call_id' in msg ? (msg.tool_call_id ?? null) : null,
      };
    }),
  };
}

/**
 * The cause chain as plain text, bounded.
 *
 * A provider failure usually carries the thing that actually went wrong one or
 * two levels down — the HTTP status, the socket error — and a trace that shows
 * only the outermost message is the one that sends someone reading it back to
 * the logs it was meant to replace.
 */
function describeCause(error: unknown): string[] {
  const chain: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = (error as { cause?: unknown })?.cause;
  while (cur && chain.length < 5 && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur instanceof Error ? cur.message : String(cur));
    cur = (cur as { cause?: unknown })?.cause;
  }
  return chain;
}

export class ToolLoopHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    parentSpan: ISpan,
  ): Promise<boolean> {
    const identity =
      ctx.callerResolution ?? resolveCallerIdentity(ctx.options, ctx.sessionId);
    const maxIterations = normalizeLoopLimit(
      'maxIterations' in config
        ? config.maxIterations
        : ctx.config.maxIterations,
      'maxIterations',
    );
    const maxToolCalls = normalizeLoopLimit(
      'maxToolCalls' in config ? config.maxToolCalls : ctx.config.maxToolCalls,
      'maxToolCalls',
    );
    const heartbeatMs = normalizeHeartbeatMs(
      (config.heartbeatIntervalMs as number | undefined) ??
        ctx.config.heartbeatIntervalMs,
    );

    // External (client-provided) tools are mode-independent (spec D1/D4): the
    // worker never executes them, so `hard` (which constrains only INTERNAL
    // execution posture) must still OFFER them and surface their calls. The
    // previous `mode === 'hard' ? []` drop is removed.
    const externalTools = ctx.externalTools;
    const externalToolNames = new Set(externalTools.map((t) => t.name));

    let toolCallCount = 0;
    let progressContent = '';
    const emitFinalContent = (content: string): void => {
      const output = wrapFinalResponse(ctx, content);
      ctx.yield({ ok: true, value: { content: output } });
      ctx.onPartial?.({ kind: 'content', delta: output });
    };
    const emitProgressFallback = (): void => {
      if (
        (!ctx.clientAdapter && ctx.config.streamMode !== 'final') ||
        !progressContent
      )
        return;
      emitFinalContent(progressContent);
    };
    let lastToolsSelected: number | undefined;
    let lastToolsAvailable: number | undefined;
    let messages = ctx.assembledMessages;
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const addUsage = (attempt: LlmUsage): void => {
      Object.assign(usage, addCacheTokenUsage(usage, attempt));
      usage.promptTokens += attempt.promptTokens;
      usage.completionTokens += attempt.completionTokens;
      usage.totalTokens += attempt.totalTokens;
      ctx.sessionManager.addTokens(attempt.totalTokens);
    };
    const timingLog: TimingEntry[] = [];
    const loopStart = Date.now();
    let currentTools: LlmTool[] = ctx.activeTools;
    const localBlocks = new Set<string>();

    messages = injectToolPriority(messages, externalTools);
    // staticPrefix is immutable across all iterations — re-emitted every round.
    const staticPrefix = await injectPendingResults(
      messages,
      ctx.pendingToolResults,
      identity,
      ctx.options,
      ctx.externalResults,
      ctx.textOrMessages,
    );
    const strategy: IToolLoopContextStrategy = (
      ctx.toolLoopContextStrategyFactory ??
      (() => new LegacyAccumulateContextStrategy())
    )({ run: undefined });
    // Preserve validation exchanges between their original tool rounds.
    const controlHistory = new ToolLoopControlHistory(staticPrefix.length);

    messages = controlHistory.restore(
      await strategy.form({
        prefix: staticPrefix,
        toolTrust: ctx.config.toolTrust,
        queryText: ctx.inputText,
      }),
    );

    const requestId = ctx.options?.trace?.traceId;
    const finalize = (
      content: string,
      finishReason: LlmFinishReason | undefined,
    ): boolean => {
      ctx.assistantText = content;
      const summary = ctx.requestLogger.getSummary(requestId);
      ctx.options?.sessionLogger?.logStep('final_response', {
        content,
        usage,
        byComponent: summary.byComponent,
        byModel: summary.byModel,
        byCategory: summary.byCategory,
      });
      timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
      ctx.timing.push(...timingLog);

      ctx.yield({
        ok: true,
        value: {
          content: '',
          finishReason: finishReason || 'stop',
          usage: {
            ...usage,
            models: ctx.requestLogger.getSummary(requestId).byModel,
            components: ctx.requestLogger.getSummary(requestId).byComponent,
            categories: ctx.requestLogger.getSummary(requestId).byCategory,
          },
          timing: timingLog,
        },
      });
      return true;
    };
    for (let iteration = 0; ; iteration++) {
      if (ctx.options?.signal?.aborted) {
        ctx.yield({
          ok: false,
          error: new OrchestratorError('Aborted', 'ABORTED'),
        });
        return false;
      }
      const earlyTaskFinish = readTaskFinish(ctx.options, iteration);
      if (earlyTaskFinish) {
        // Task output is authoritative: skip validation reprompts. Pipeline output
        // uses its normal events and finalization.
        emitFinalContent(earlyTaskFinish.output);
        ctx.yield({ ok: true, value: { content: '', iterationEnd: 'final' } });
        ctx.onPartial?.({ kind: 'iteration-end', outcome: 'final' });
        return finalize(earlyTaskFinish.output, 'stop');
      }
      if (iteration > 0 && ctx.options?.stopSignal?.aborted) {
        emitProgressFallback();
        ctx.stopped = true;
        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        ctx.timing.push(...timingLog);
        ctx.yield({
          ok: true,
          value: {
            content: '',
            finishReason: 'stop',
            stopped: true,
            usage: {
              ...usage,
              models: ctx.requestLogger.getSummary(requestId).byModel,
              components: ctx.requestLogger.getSummary(requestId).byComponent,
              categories: ctx.requestLogger.getSummary(requestId).byCategory,
            },
            timing: timingLog,
          },
        });
        return true;
      }
      if (maxIterations !== undefined && iteration >= maxIterations) {
        emitProgressFallback();
        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        ctx.timing.push(...timingLog);
        ctx.yield({
          ok: true,
          value: {
            content: '',
            finishReason: 'length',
            usage: {
              ...usage,
              models: ctx.requestLogger.getSummary(requestId).byModel,
              components: ctx.requestLogger.getSummary(requestId).byComponent,
            },
            timing: timingLog,
          },
        });
        return true;
      }

      // Refresh MCP tools on each iteration (when enabled)
      const prevSelectedTools = [...currentTools];
      if (iteration > 0 && ctx.config.refreshToolsPerIteration !== false) {
        const refreshSpan = ctx.tracer.startSpan('smart_agent.refresh_tools', {
          parent: parentSpan,
          attributes: { 'llm.iteration': iteration + 1 },
        });
        const prevNames = [...ctx.toolClientMap.keys()];
        ctx.toolClientMap.clear();
        ctx.mcpTools.length = 0;
        const settled = await Promise.allSettled(
          ctx.mcpClients.map(async (client) => ({
            client,
            result: await client.listTools(ctx.options),
          })),
        );
        const perClient = settled.flatMap((entry, i) =>
          entry.status === 'fulfilled' && entry.value.result.ok
            ? [
                {
                  slotIndex: ctx.mcpClientDescriptors?.[i]?.slotIndex ?? i,
                  label: ctx.mcpClientDescriptors?.[i]?.label,
                  client: entry.value.client,
                  tools: entry.value.result.value,
                },
              ]
            : [],
        );
        const { tools, toolClientMap } = buildNamespacedTools(
          perClient,
          ctx.toolNamespace ?? defaultToolNamespace,
        );
        ctx.mcpTools.push(...tools);
        for (const [name, client] of toolClientMap) {
          ctx.toolClientMap.set(name, client);
        }
        currentTools = mergeOfferedTools(
          ctx.mcpTools as LlmTool[],
          externalTools,
        );
        ctx.options?.sessionLogger?.logStep('tools_refreshed', {
          iteration: iteration + 1,
          previous: prevNames,
          current: currentTools.map((t) => t.name),
        });
        refreshSpan.end();
      }

      // Per-iteration RAG tool re-selection (when enabled)
      if (
        iteration > 0 &&
        ctx.config.toolReselectPerIteration &&
        ctx.ragStores?.tools
      ) {
        const reselectSpan = ctx.tracer.startSpan('smart_agent.tool_reselect', {
          parent: parentSpan,
          attributes: { 'llm.iteration': iteration + 1 },
        });

        try {
          // Extract last tool calls
          const lastAssistant = [...messages]
            .reverse()
            .find((m) => m.role === 'assistant');
          const toolCallNames: string[] = [];
          if (lastAssistant && 'tool_calls' in lastAssistant) {
            const tcs = lastAssistant.tool_calls;
            if (Array.isArray(tcs)) {
              for (const tc of tcs) {
                const name = tc?.function?.name || '';
                if (name) toolCallNames.push(name);
              }
            }
          }

          // Skip for read-only tools — they rarely need different tools on retry
          const readOnlyPrefixes = [
            'Search',
            'Read',
            'Get',
            'List',
            'Describe',
          ];
          const allReadOnly =
            toolCallNames.length > 0 &&
            toolCallNames.every((n) =>
              readOnlyPrefixes.some((p) => n.startsWith(p)),
            );

          if (allReadOnly) {
            // Read-only tools don't need re-selection — restore previous selection
            // to avoid sending all MCP tools after refresh
            currentTools = prevSelectedTools;
          } else {
            // Build context-aware query from error/result context
            const lastToolMsg = [...messages]
              .reverse()
              .find((m) => m.role === 'tool');
            const toolResult =
              typeof lastToolMsg?.content === 'string'
                ? lastToolMsg.content.slice(0, 200)
                : '';
            const isError =
              toolResult.toLowerCase().includes('error') ||
              toolResult.toLowerCase().includes('already exist') ||
              toolResult.toLowerCase().includes('failed');

            let reSelectQuery: string;
            if (toolCallNames.length > 0 && isError) {
              const updateHints = toolCallNames
                .filter((n) => n.startsWith('Create'))
                .map((n) => n.replace(/^Create/, 'Update'))
                .join(', ');
              const hints = updateHints ? ` Need ${updateHints}.` : '';
              reSelectQuery = `${toolCallNames.join(', ')} failed: ${toolResult.slice(0, 150)}.${hints} ${ctx.inputText.slice(0, 200)}`;
            } else if (toolCallNames.length > 0) {
              reSelectQuery = `After ${toolCallNames.join(', ')}: ${toolResult}\n${ctx.inputText.slice(0, 200)}`;
            } else {
              reSelectQuery = ctx.inputText;
            }

            // Query tools RAG
            const { QueryEmbedding, TextOnlyEmbedding } = await import(
              '@mcp-abap-adt/llm-agent'
            );
            const embedding = ctx.embedder
              ? new QueryEmbedding(reSelectQuery, ctx.embedder, ctx.options)
              : new TextOnlyEmbedding(reSelectQuery);

            const ragK = ctx.config.ragQueryK ?? 20;
            const ragStart = Date.now();
            const ragResult = await ownerBoundQuery(
              ctx.ragStores.tools,
              embedding,
              ragK,
              ctx.options ?? {},
              ctx.ragAccess ?? denyRagAccess,
            );
            if (!ragResult.ok) {
              ctx.error = ragResult.error;
              return false;
            }
            ctx.requestLogger.logRagQuery({
              store: 'tools',
              query: reSelectQuery.slice(0, 200),
              resultCount: ragResult.ok ? ragResult.value.length : 0,
              durationMs: Date.now() - ragStart,
            });

            if (ragResult.ok && ragResult.value.length > 0) {
              const newToolNames = new Set(
                ragResult.value
                  .map((r) => toolNameFromRecord(r.metadata))
                  .filter((n): n is string => n !== undefined),
              );

              if (newToolNames.size > 0) {
                const newMcpTools = ctx.mcpTools.filter((t) =>
                  newToolNames.has(t.name),
                );
                currentTools = mergeOfferedTools(
                  newMcpTools as LlmTool[],
                  externalTools,
                );

                ctx.options?.sessionLogger?.logStep('tools_reselected', {
                  iteration: iteration + 1,
                  query: reSelectQuery.slice(0, 100),
                  previousTools: toolCallNames,
                  newTools: [...newToolNames],
                });
              }
            }
          }
        } finally {
          reselectSpan.end();
        }
      }

      currentTools = await withSubmitReport(
        currentTools,
        ctx.toolClientMap,
        ctx.options,
        externalTools,
      );

      // Filter tools per iteration
      currentTools = filterAvailableTools(
        ctx.toolAvailabilityRegistry,
        identity,
        currentTools,
        iteration,
        ctx.options,
        localBlocks,
      );
      if (maxToolCalls !== undefined && toolCallCount >= maxToolCalls) {
        currentTools = [];
        ctx.yield({
          ok: true,
          value: {
            content: '',
            budgetExhausted: true,
            toolCallCount,
            maxToolCalls,
          },
        });
      }

      ctx.options?.sessionLogger?.logStep(
        `llm_request_iter_${iteration + 1}`,
        {
          messages,
          tools: currentTools,
        },
        'llm',
      );
      const iterationMessageSummary = summarizeIterationMessages(messages);
      const looksLikeFinalPass = messages.some(
        (msg) =>
          msg.role === 'tool' ||
          ('tool_calls' in msg &&
            Array.isArray(msg.tool_calls) &&
            msg.tool_calls.length > 0),
      );
      ctx.options?.sessionLogger?.logStep(
        'llm_request_iter_context_summary',
        {
          iteration: iteration + 1,
          toolCount: currentTools.length,
          looksLikeFinalPass,
          summary: iterationMessageSummary,
        },
        'llm',
      );
      ctx.logger?.log({
        type: 'warning',
        traceId: ctx.options?.trace?.traceId ?? 'tool-loop',
        message: `tool-loop iteration ${iteration + 1} context summary ${JSON.stringify(
          {
            iteration: iteration + 1,
            toolCount: currentTools.length,
            looksLikeFinalPass,
            summary: iterationMessageSummary,
          },
        )}`,
      });

      try {
        ctx.options?.onActivity?.('llm call');
      } catch {
        // Supervision is informational: an observer must never fail the work.
      }

      let content = '';
      let finishReason: LlmFinishReason | undefined;
      const toolCallsMap = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      // Track which streaming indices belong to external tools so that
      // argument-only continuation deltas (no name field) are forwarded too.

      const available = ctx.mcpTools.length + externalTools.length;
      if (
        currentTools.length !== lastToolsSelected ||
        available !== lastToolsAvailable
      ) {
        lastToolsSelected = currentTools.length;
        lastToolsAvailable = available;
        try {
          ctx.options?.onToolsSelected?.(currentTools.length, available);
        } catch {
          /* Observers cannot affect execution. */
        }
      }
      const taskFinish = readTaskFinish(ctx.options, iteration);
      if (taskFinish) {
        // Task output is authoritative: skip validation reprompts. Pipeline output
        // uses its normal events and finalization.
        emitFinalContent(taskFinish.output);
        ctx.yield({ ok: true, value: { content: '', iterationEnd: 'final' } });
        ctx.onPartial?.({ kind: 'iteration-end', outcome: 'final' });
        return finalize(taskFinish.output, 'stop');
      }
      const llmSpan = ctx.tracer.startSpan('smart_agent.llm_call', {
        parent: parentSpan,
        attributes: { 'llm.iteration': iteration + 1 },
      });
      ctx.metrics.llmCallCount.add();
      const llmCallStart = Date.now();
      // Delegate to ILlmCallStrategy — handles streaming, non-streaming, or fallback
      const llmStream = () =>
        ctx.llmCallStrategy.call(
          ctx.mainLlm,
          toModelToolMessages(messages, ctx.config.toolTrust),
          currentTools,
          {
            ...ctx.options,
            usage: scopedUsage(ctx.options?.usage, { component: 'tool-loop' }),
            includeStreamRetryUsage: true,
          },
        );

      const attemptUsage = new StreamAttemptUsage();
      const logAttempt = (
        reported?: LlmUsageAttribution,
        countEmpty = true,
      ) => {
        const calls = attemptUsage.records(
          'tool-loop',
          ctx.mainLlm.model,
          reported,
          ctx.options?.signal,
          countEmpty,
        );
        logToolLoopAttempt(ctx.requestLogger, calls, requestId, addUsage);
        return calls;
      };
      let chunksSeen = 0;
      for await (const chunkResult of recordThrownLlmUsage(
        llmStream,
        logAttempt,
      )) {
        if (!chunkResult.ok) {
          const failure: typeof chunkResult.error & LlmUsageAttribution =
            chunkResult.error;
          const error = withUsageCalls(failure, logAttempt(failure, false));
          llmSpan.setStatus('error', chunkResult.error.message);
          llmSpan.end();
          // The failure gets a response trace too (#290). This is the case the
          // tracing exists for — a successful call is reconstructable from the
          // ordinary logs, a provider or gateway dying mid-stream is not — and
          // leaving on the error path wrote the question without the answer.
          // `chunksSeen` separates a stream that never opened from one that
          // died halfway, which the partial content alone does not say.
          ctx.options?.sessionLogger?.logStep(
            `llm_response_iter_${iteration + 1}`,
            {
              error: {
                message: chunkResult.error.message,
                code: (chunkResult.error as { code?: unknown }).code,
                cause: describeCause(chunkResult.error),
              },
              partialContent: content,
              finishReason,
              chunksSeen,
            },
            'llm',
          );
          ctx.error = error;
          ctx.yield({ ok: false, error });
          return false;
        }
        chunksSeen += 1;
        const chunk = chunkResult.value;
        // Mid-stream retry or fallback reset: discard accumulated state
        if (chunk.reset) {
          logAttempt(chunk.retryUsage);
          attemptUsage.reset();
          ctx.yield({
            ok: true,
            value: { content: '', iterationEnd: 'retry' },
          });
          ctx.onPartial?.({ kind: 'iteration-end', outcome: 'retry' });
          content = '';
          toolCallsMap.clear();
          finishReason = undefined;
          continue;
        }
        attemptUsage.add(chunk.usage, ctx.mainLlm.model, chunk.usageCalls);
        if (chunk.content) {
          content += chunk.content;
          if (!ctx.clientAdapter && ctx.config.streamMode !== 'final') {
            ctx.yield({ ok: true, value: { content: chunk.content } });
          }
          if (
            ctx.onPartial &&
            !ctx.clientAdapter &&
            ctx.config.streamMode !== 'final'
          ) {
            ctx.onPartial({
              kind: 'content',
              delta: chunk.content,
              ephemeral: chunk.ephemeral,
            });
          }
        }
        if (chunk.toolCalls) {
          // Buffer calls until the complete response can be classified atomically.
          for (const [
            fallbackIndex,
            rawToolCall,
          ] of chunk.toolCalls.entries()) {
            const tc = toToolCallDelta(rawToolCall, fallbackIndex);
            if (!toolCallsMap.has(tc.index)) {
              toolCallsMap.set(tc.index, {
                id: tc.id || '',
                name: tc.name || '',
                arguments: tc.arguments || '',
              });
            } else {
              const ex = toolCallsMap.get(tc.index);
              if (ex) {
                if (tc.id) ex.id = tc.id;
                if (tc.name) ex.name = tc.name;
                if (tc.arguments) ex.arguments += tc.arguments;
              }
            }
            if (tc.name && ctx.onPartial) {
              ctx.onPartial({
                kind: 'mcp-call',
                source: { stepperId: tc.name, name: 'tool' },
                tool: tc.name,
                args: tc.arguments,
              });
            }
          }
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
      }

      llmSpan.setStatus('ok');
      llmSpan.end();
      const llmCallDuration = Date.now() - llmCallStart;
      ctx.metrics.llmCallLatency.record(llmCallDuration);
      timingLog.push({
        phase: `llm_call_${iteration + 1}`,
        duration: llmCallDuration,
      });

      logAttempt();

      const hasToolCalls =
        finishReason === 'tool_calls' && toolCallsMap.size > 0;
      const responseRound = new ToolResponseRound(
        content,
        toolCallsMap.values(),
        (name) => externalToolNames.has(name) && !ctx.toolClientMap.has(name),
      );
      const toolCalls = hasToolCalls ? responseRound.executableCalls() : [];

      ctx.options?.sessionLogger?.logStep(
        `llm_response_iter_${iteration + 1}`,
        { content, ...responseRound.diagnostics(toolCalls), finishReason },
        'llm',
      );

      if (finishReason === 'length') {
        ctx.error = new OrchestratorError(
          'LLM response was truncated at a token limit.',
          'LLM_OUTPUT_TRUNCATED',
        );
        ctx.yield({ ok: false, error: ctx.error });
        return false;
      }
      const val = hasToolCalls
        ? { reprompt: false, messages }
        : await runOutputValidationReprompt(
            ctx.outputValidator,
            content,
            messages,
            currentTools,
            ctx.options,
            ctx.config.toolTrust,
          );
      const iterationEnd = hasToolCalls
        ? 'tool_calls'
        : val.reprompt
          ? 'retry'
          : 'final';
      if (iterationEnd !== 'retry') {
        ctx.options?.onAssistantResponse?.(content);
      }
      if (iterationEnd === 'tool_calls') progressContent += content;
      else if (
        iterationEnd === 'final' &&
        (ctx.clientAdapter || ctx.config.streamMode === 'final')
      ) {
        emitFinalContent(content);
      }
      ctx.yield({ ok: true, value: { content: '', iterationEnd } });
      ctx.onPartial?.({ kind: 'iteration-end', outcome: iterationEnd });

      // -- No tool calls: validate and finish --------------------------------
      if (!hasToolCalls) {
        if (val.reprompt) {
          // Anchor the rejected reply and correction before any newer tool rounds.
          const appended = val.messages.slice(messages.length);
          controlHistory.append(appended);
          messages = controlHistory.restore(
            await strategy.form({
              prefix: staticPrefix,
              toolTrust: ctx.config.toolTrust,
              queryText: ctx.inputText,
            }),
          );
          continue;
        }
        return finalize(content, finishReason);
      }

      // -- Classify tool calls -----------------------------------------------
      const roundRejections =
        guardToolRound(toolCalls, ctx.options) ?? new Map<number, string>();
      const {
        internalCalls,
        validExternalCalls,
        blockedCalls,
        hallucinations,
      } = classifyToolCalls(
        toolCalls,
        ctx.toolClientMap,
        externalToolNames,
        ctx.toolAvailabilityRegistry,
        identity,
        localBlocks,
      );

      for (const tc of blockedCalls) {
        responseRound.resolve(
          tc,
          `Error: Tool "${tc.name}" is temporarily unavailable in this session.`,
          true,
        );
      }
      for (const tc of hallucinations) {
        responseRound.resolve(tc, `Error: Tool "${tc.name}" not found.`, true);
      }
      const externalCalls = validExternalCalls.filter((tc) => {
        const rejection = roundRejections.get(toolCalls.indexOf(tc));
        if (rejection === undefined) return true;
        responseRound.resolve(tc, `Error: ${rejection}`, true);
        return false;
      });
      // Check tool call budget
      const remaining =
        maxToolCalls !== undefined
          ? maxToolCalls - toolCallCount
          : internalCalls.length;
      const batch = internalCalls.slice(0, Math.max(0, remaining));
      const skipped = internalCalls.slice(batch.length);

      if (externalCalls.length > 0) {
        const pending = fireInternalToolsAsync(
          content,
          batch,
          ctx.pendingToolResults,
          identity,
          {
            toolClientMap: ctx.toolClientMap,
            toolCache: ctx.toolCache,
            metrics: ctx.metrics,
            options: ctx.options,
            roundCalls: toolCalls,
            roundRejections,
            skippedCalls: skipped,
            maxToolCalls: maxToolCalls,
            assistantMessage: responseRound.assistant,
            resolvedResults: responseRound.resolved(),
            precedingMessages: messages,
            sourceMessages: pendingSourceMessages(
              ctx.textOrMessages,
              staticPrefix,
              messages,
            ),
            externalCalls,
          },
        );
        toolCallCount += batch.length;
        if (batch.length > 0) {
          try {
            ctx.options?.onToolCallCount?.(toolCallCount, maxToolCalls);
          } catch {
            /* Observers cannot affect execution. */
          }
        }
        if (maxToolCalls !== undefined && toolCallCount >= maxToolCalls) {
          ctx.yield({
            ok: true,
            value: {
              content: '',
              budgetExhausted: true,
              toolCallCount,
              maxToolCalls: maxToolCalls,
            },
          });
        }
        ctx.options?.sessionLogger?.logStep('mixed_tool_calls', {
          internal: internalCalls.map((tc) => tc.name),
          external: externalCalls.map((tc) => tc.name),
        });

        // Return this suspension's unique IDs; keep model IDs internal.
        emitProgressFallback();
        ctx.yield({
          ok: true,
          value: {
            content: '',
            toolCalls: externalCalls.map((tc, index) => ({
              index,
              id: pending.externalCalls[index].returnedId,
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            })),
          },
        });

        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        ctx.timing.push(...timingLog);
        ctx.yield({
          ok: true,
          value: {
            content: '',
            finishReason: 'tool_calls',
            usage: {
              ...usage,
              models: ctx.requestLogger.getSummary(requestId).byModel,
              components: ctx.requestLogger.getSummary(requestId).byComponent,
            },
            timing: timingLog,
          },
        });
        return true;
      }

      // -- Execute internal MCP tool calls -----------------------------------
      // Capture the assistant message now; record the full round (assistant +
      // tool results) atomically after the batch completes so the strategy
      // always sees a complete ToolRound.
      // Yield progress messages
      for (const tc of batch) {
        ctx.yield({
          ok: true,
          value: {
            content: `\n\n[SmartAgent: Executing ${tc.name}...]\n`,
            ephemeral: true,
          },
        });
      }

      // Execute tool calls concurrently with heartbeat (shared core).
      const batchGen = executeToolBatchWithHeartbeat({
        callerResolution: identity,
        localBlocks,
        batch,
        roundCalls: toolCalls,
        roundRejections,
        toolClientMap: ctx.toolClientMap,
        toolCache: ctx.toolCache,
        tracer: ctx.tracer,
        metrics: ctx.metrics,
        parentSpan,
        toolAvailabilityRegistry: ctx.toolAvailabilityRegistry,
        sessionId: ctx.sessionId,
        externalToolNames,
        currentTools,
        toolCallCount,
        timingLog,
        heartbeatMs,
        options: ctx.options,
        onBatchComplete: async (outcome) => {
          outcome.toolMessages.forEach((message, index) => {
            responseRound.add(message, outcome.resultMeta[index]);
          });
          for (const tc of skipped) {
            responseRound.resolve(
              tc,
              `Error: not executed: tool-call budget of ${maxToolCalls} for this request is exhausted; return what you have and report what is missing`,
              true,
            );
          }
          const batchRound = responseRound.finish();
          await strategy.record(controlHistory.record(batchRound));
        },
        mcpFailureClassifier: ctx.mcpFailureClassifier,
        maxToolCalls,
        onToolExecuted: (r) => {
          // Stamp requestId so tool executions land in the per-traceId delta
          // bucket — without it, `getSummary(traceId).toolCalls` stays 0 even
          // when the request actually ran tools (only the session-cumulative
          // counter would tick).
          const traceId = ctx.options?.trace?.traceId ?? 'tool-loop';
          const isError = !r.res?.ok || (r.res.ok && !!r.res.value.isError);
          ctx.requestLogger.logToolCall({
            requestId: traceId,
            toolName: r.tc.name,
            success: !!r.res?.ok,
            durationMs: r.duration,
            cached: r.cached,
          });
          // Structured timing event — consumed by server logger; verbosity
          // is the logger implementation's concern (satisfies run-mode gate).
          ctx.logger?.log({
            type: 'tool_call',
            traceId,
            toolName: r.tc.name,
            isError,
            durationMs: r.duration,
          });
          // Per-session debug channel — lands in session artifacts alongside
          // coordinator_step_* entries. Include resolved timeout when available
          // so a durationMs ≈ timeoutMs clearly flags which tool to bump via
          // toolTimeouts config.
          ctx.options?.sessionLogger?.logStep(
            'mcp_tool_call',
            {
              toolName: r.tc.name,
              durationMs: r.duration,
              isError,
            },
            'mcp',
          );
        },
      });
      let step = await batchGen.next();
      while (!step.done) {
        ctx.yield(step.value);
        step = await batchGen.next();
      }
      const outcome = step.value;

      if (outcome.escalated) return false;
      if (outcome.toolCallCount !== toolCallCount) {
        toolCallCount = outcome.toolCallCount;
        try {
          ctx.options?.onToolCallCount?.(toolCallCount, maxToolCalls);
        } catch {
          /* Observers cannot affect execution. */
        }
      }
      currentTools = outcome.currentTools;
      if (maxToolCalls !== undefined && toolCallCount >= maxToolCalls) {
        ctx.yield({
          ok: true,
          value: {
            content: '',
            budgetExhausted: true,
            toolCallCount,
            maxToolCalls: maxToolCalls,
          },
        });
      }
      messages = controlHistory.restore(
        await strategy.form({
          prefix: staticPrefix,
          toolTrust: ctx.config.toolTrust,
          queryText: ctx.inputText,
        }),
      );
    }
  }
}
