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
 * | `heartbeatIntervalMs` | number | 5000     | SSE heartbeat interval (ms)     |
 *
 * ## Includes
 *
 * - Output validation (re-prompts on invalid LLM output)
 * - Tool call classification (internal / external / hallucinated / blocked)
 * - Concurrent tool execution with heartbeat
 * - Tool availability tracking (temporary blacklist)
 */

import type { Message } from '../../../types.js';
import { OrchestratorError } from '../../agent.js';
import type {
  LlmFinishReason,
  LlmTool,
  Result,
  TimingEntry,
} from '../../interfaces/types.js';
import { fireInternalToolsAsync } from '../../policy/mixed-tool-call-handler.js';
import { isToolContextUnavailableError } from '../../policy/tool-availability-registry.js';
import type { ISpan } from '../../tracer/types.js';
import {
  getStreamToolCallName,
  toToolCallDelta,
} from '../../utils/tool-call-deltas.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export class ToolLoopHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    parentSpan: ISpan,
  ): Promise<boolean> {
    const maxIterations =
      (config.maxIterations as number) ?? ctx.config.maxIterations;
    const maxToolCalls =
      (config.maxToolCalls as number) ?? ctx.config.maxToolCalls;
    const heartbeatMs =
      (config.heartbeatIntervalMs as number) ??
      ctx.config.heartbeatIntervalMs ??
      5000;

    const mode = ctx.config.mode || 'smart';
    const externalTools = mode === 'hard' ? [] : ctx.externalTools;
    const externalToolNames = new Set(externalTools.map((t) => t.name));

    let toolCallCount = 0;
    let messages = ctx.assembledMessages;
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const timingLog: TimingEntry[] = [];
    const loopStart = Date.now();
    let currentTools: LlmTool[] = ctx.activeTools;

    // Inject tool priority instruction when external tools are present
    if (externalTools.length > 0) {
      const systemIdx = messages.findIndex((m) => m.role === 'system');
      if (systemIdx >= 0) {
        const sys = messages[systemIdx];
        messages = [...messages];
        messages[systemIdx] = {
          ...sys,
          content: `${sys.content}\n\nIMPORTANT: You have internal tools and client-provided tools (marked [client-provided] in their description). Always prefer internal tools when they can accomplish the task. Use client-provided tools only when no internal tool can do the job.`,
        };
      }
    }

    // Inject pending internal tool results from previous mixed-call request
    if (ctx.pendingToolResults.has(ctx.sessionId)) {
      const pending = await ctx.pendingToolResults.consume(ctx.sessionId);
      if (pending) {
        messages = [
          ...messages,
          pending.assistantMessage,
          ...pending.results.map((r) => ({
            role: 'tool' as const,
            content: r.text,
            tool_call_id: r.toolCallId,
          })),
        ];
        ctx.options?.sessionLogger?.logStep('pending_tool_results_injected', {
          toolNames: pending.results.map((r) => r.toolName),
        });
      }
    }

    for (let iteration = 0; ; iteration++) {
      if (ctx.options?.signal?.aborted) {
        ctx.yield({
          ok: false,
          error: new OrchestratorError('Aborted', 'ABORTED'),
        });
        return false;
      }
      if (iteration >= maxIterations) {
        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        ctx.timing.push(...timingLog);
        ctx.yield({
          ok: true,
          value: {
            content: '',
            finishReason: 'length',
            usage: {
              ...usage,
              models: ctx.requestLogger.getSummary().byModel,
            },
            timing: timingLog,
          },
        });
        return true;
      }

      // Refresh MCP tools on each iteration (when enabled)
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
        for (const entry of settled) {
          if (entry.status === 'fulfilled' && entry.value.result.ok) {
            for (const t of entry.value.result.value) {
              if (!ctx.toolClientMap.has(t.name)) {
                ctx.toolClientMap.set(t.name, entry.value.client);
                ctx.mcpTools.push(t);
              }
            }
          }
        }
        currentTools = [...(ctx.mcpTools as LlmTool[]), ...externalTools];
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
            const tcs = (lastAssistant as any).tool_calls;
            if (Array.isArray(tcs)) {
              for (const tc of tcs) {
                const name = tc?.function?.name || tc?.name || '';
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

          if (!allReadOnly) {
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
              '../../rag/query-embedding.js'
            );
            const embedding = ctx.embedder
              ? new QueryEmbedding(reSelectQuery, ctx.embedder, ctx.options)
              : new TextOnlyEmbedding(reSelectQuery);

            const ragK = ctx.config.ragQueryK ?? 20;
            const ragStart = Date.now();
            const ragResult = await ctx.ragStores.tools.query(
              embedding,
              ragK,
              ctx.options,
            );
            ctx.requestLogger.logRagQuery({
              store: 'tools',
              query: reSelectQuery.slice(0, 200),
              resultCount: ragResult.ok ? ragResult.value.length : 0,
              durationMs: Date.now() - ragStart,
            });

            if (ragResult.ok && ragResult.value.length > 0) {
              const newToolNames = new Set(
                ragResult.value
                  .map((r) => (r.metadata?.id as string) || '')
                  .filter((id) => id.startsWith('tool:'))
                  .map((id) => id.slice(5)),
              );

              if (newToolNames.size > 0) {
                const newMcpTools = ctx.mcpTools.filter((t) =>
                  newToolNames.has(t.name),
                );
                currentTools = [
                  ...(newMcpTools as LlmTool[]),
                  ...externalTools,
                ];

                // Update system message "Available Tools" section
                const sysIdx = messages.findIndex((m) => m.role === 'system');
                if (
                  sysIdx >= 0 &&
                  typeof messages[sysIdx].content === 'string'
                ) {
                  const toolsSection = currentTools
                    .filter((t) => !externalToolNames.has(t.name))
                    .map((t) => `- ${t.name}: ${t.description || ''}`)
                    .join('\n');
                  messages[sysIdx] = {
                    ...messages[sysIdx],
                    content: (messages[sysIdx].content as string).replace(
                      /## Available Tools\n[\s\S]*?(?=\n##|$)/,
                      `## Available Tools\n${toolsSection}`,
                    ),
                  };
                }

                ctx.options?.sessionLogger?.logStep('tools_reselected', {
                  iteration: iteration + 1,
                  query: reSelectQuery.slice(0, 100),
                  previousTools: toolCallNames,
                  newTools: [...newToolNames],
                });
              }
            }
          } else {
            ctx.options?.sessionLogger?.logStep('tools_reselect_skipped', {
              iteration: iteration + 1,
              reason: 'read-only tools only',
              tools: toolCallNames,
            });
          }
        } finally {
          reselectSpan.end();
        }
      }

      // Filter tools per iteration
      const filteredForIteration = ctx.toolAvailabilityRegistry.filterTools(
        ctx.sessionId,
        currentTools,
      );
      currentTools = filteredForIteration.allowed;
      if (filteredForIteration.blocked.length > 0) {
        ctx.options?.sessionLogger?.logStep(
          'active_tools_filtered_in_iteration',
          { iteration: iteration + 1, blocked: filteredForIteration.blocked },
        );
      }

      let iterPromptTokens = 0;
      let iterCompletionTokens = 0;
      let iterTotalTokens = 0;

      ctx.options?.sessionLogger?.logStep(`llm_request_iter_${iteration + 1}`, {
        messages,
        tools: currentTools,
      });

      const llmSpan = ctx.tracer.startSpan('smart_agent.llm_call', {
        parent: parentSpan,
        attributes: { 'llm.iteration': iteration + 1 },
      });
      ctx.metrics.llmCallCount.add();
      const llmCallStart = Date.now();
      const stream = ctx.mainLlm.streamChat(
        messages,
        currentTools,
        ctx.options,
      );

      let content = '';
      let finishReason: LlmFinishReason | undefined;
      const toolCallsMap = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      for await (const chunkResult of stream) {
        if (!chunkResult.ok) {
          llmSpan.setStatus('error', chunkResult.error.message);
          llmSpan.end();
          ctx.yield({
            ok: false,
            error: new OrchestratorError(
              chunkResult.error.message,
              'LLM_ERROR',
            ),
          });
          return false;
        }
        const chunk = chunkResult.value;
        if (chunk.content) {
          content += chunk.content;
          ctx.yield({ ok: true, value: { content: chunk.content } });
        }
        if (chunk.toolCalls) {
          const externalDeltas = chunk.toolCalls.filter((tc) =>
            externalToolNames.has(getStreamToolCallName(tc) ?? ''),
          );
          if (externalDeltas.length > 0) {
            ctx.yield({
              ok: true,
              value: { content: '', toolCalls: externalDeltas },
            });
          }
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
          }
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.usage) {
          usage.promptTokens += chunk.usage.promptTokens;
          usage.completionTokens += chunk.usage.completionTokens;
          usage.totalTokens += chunk.usage.totalTokens;
          iterPromptTokens += chunk.usage.promptTokens;
          iterCompletionTokens += chunk.usage.completionTokens;
          iterTotalTokens += chunk.usage.totalTokens;
          ctx.sessionManager.addTokens(chunk.usage.totalTokens);
        }
      }

      llmSpan.setStatus('ok');
      llmSpan.end();
      const llmCallDuration = Date.now() - llmCallStart;
      ctx.metrics.llmCallLatency.record(llmCallDuration);
      timingLog.push({
        phase: `llm_call_${iteration + 1}`,
        duration: llmCallDuration,
      });

      ctx.requestLogger.logLlmCall({
        component: 'tool-loop',
        model: ctx.mainLlm.model ?? 'unknown',
        promptTokens: iterPromptTokens,
        completionTokens: iterCompletionTokens,
        totalTokens: iterTotalTokens,
        durationMs: llmCallDuration,
      });

      const toolCalls = Array.from(toolCallsMap.values()).map((tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments);
        } catch {
          args = {};
        }
        return { id: tc.id, name: tc.name, arguments: args };
      });

      ctx.options?.sessionLogger?.logStep(
        `llm_response_iter_${iteration + 1}`,
        { content, toolCalls, finishReason },
      );

      // -- No tool calls: validate and finish --------------------------------
      if (finishReason !== 'tool_calls' || toolCalls.length === 0) {
        const valResult = await ctx.outputValidator.validate(
          content,
          { messages, tools: currentTools },
          ctx.options,
        );
        if (valResult.ok && !valResult.value.valid) {
          const correction =
            valResult.value.correctedContent ?? valResult.value.reason;
          messages = [
            ...messages,
            { role: 'assistant' as const, content },
            {
              role: 'user' as const,
              content: `Your previous response was rejected by validation: ${correction}. Please try again.`,
            },
          ];
          continue;
        }
        ctx.options?.sessionLogger?.logStep('final_response', {
          content,
          usage,
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
              models: ctx.requestLogger.getSummary().byModel,
            },
            timing: timingLog,
          },
        });
        return true;
      }

      // -- Classify tool calls -----------------------------------------------
      const internalCalls = toolCalls.filter((tc) =>
        ctx.toolClientMap.has(tc.name),
      );
      const validExternalCalls = toolCalls.filter((tc) =>
        externalToolNames.has(tc.name),
      );
      const blockedToolNames = ctx.toolAvailabilityRegistry.getBlockedToolNames(
        ctx.sessionId,
      );
      const blockedCalls = toolCalls.filter((tc) =>
        blockedToolNames.has(tc.name),
      );
      const hallucinations = toolCalls.filter(
        (tc) =>
          !blockedToolNames.has(tc.name) &&
          !ctx.toolClientMap.has(tc.name) &&
          !externalToolNames.has(tc.name),
      );

      // -- Handle blocked tools ----------------------------------------------
      if (blockedCalls.length > 0) {
        messages = [
          ...messages,
          {
            role: 'assistant' as const,
            content: content || null,
            tool_calls: blockedCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          },
        ];
        for (const blocked of blockedCalls) {
          messages = [
            ...messages,
            {
              role: 'tool' as const,
              content: `Error: Tool "${blocked.name}" is temporarily unavailable in this session.`,
              tool_call_id: blocked.id,
            },
          ];
        }
        ctx.options?.sessionLogger?.logStep('blocked_tool_calls_intercepted', {
          toolNames: blockedCalls.map((tc) => tc.name),
        });
        continue;
      }

      // -- Handle hallucinated tools -----------------------------------------
      if (hallucinations.length > 0) {
        messages = [
          ...messages,
          {
            role: 'assistant' as const,
            content: content || null,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          },
        ];
        for (const h of hallucinations) {
          messages = [
            ...messages,
            {
              role: 'tool' as const,
              content: `Error: Tool "${h.name}" not found.`,
              tool_call_id: h.id,
            },
          ];
        }
        continue;
      }

      // -- Handle external tool calls (delegate to consumer) -----------------
      if (validExternalCalls.length > 0) {
        if (internalCalls.length > 0) {
          fireInternalToolsAsync(
            content,
            internalCalls,
            ctx.pendingToolResults,
            ctx.sessionId,
            {
              toolClientMap: ctx.toolClientMap,
              toolCache: ctx.toolCache,
              metrics: ctx.metrics,
              options: ctx.options,
            },
          );
          ctx.options?.sessionLogger?.logStep('mixed_tool_calls', {
            internal: internalCalls.map((tc) => tc.name),
            external: validExternalCalls.map((tc) => tc.name),
          });
        }

        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        ctx.timing.push(...timingLog);
        ctx.yield({
          ok: true,
          value: {
            content: '',
            finishReason: 'tool_calls',
            usage: {
              ...usage,
              models: ctx.requestLogger.getSummary().byModel,
            },
            timing: timingLog,
          },
        });
        return true;
      }

      // -- Execute internal MCP tool calls -----------------------------------
      if (content || internalCalls.length > 0) {
        messages = [
          ...messages,
          {
            role: 'assistant' as const,
            content: content || null,
            tool_calls: internalCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          },
        ];
      }

      // Check tool call budget
      const remaining =
        maxToolCalls !== undefined
          ? maxToolCalls - toolCallCount
          : internalCalls.length;
      if (remaining <= 0) {
        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        ctx.timing.push(...timingLog);
        ctx.yield({
          ok: true,
          value: {
            content: '',
            finishReason: 'length',
            usage: {
              ...usage,
              models: ctx.requestLogger.getSummary().byModel,
            },
            timing: timingLog,
          },
        });
        return true;
      }

      const batch = internalCalls.slice(0, remaining);

      // Yield progress messages
      for (const tc of batch) {
        ctx.yield({
          ok: true,
          value: { content: `\n\n[SmartAgent: Executing ${tc.name}...]\n` },
        });
      }

      // Execute tool calls concurrently with heartbeat
      type ToolExecResult = {
        tc: { id: string; name: string; arguments: Record<string, unknown> };
        text: string;
        res: Result<
          { content: string | Record<string, unknown>; isError?: boolean },
          { message: string }
        > | null;
        duration: number;
        cached: boolean;
      };

      const toolExecPromises = batch.map(
        async (tc): Promise<ToolExecResult> => {
          const toolStart = Date.now();
          ctx.options?.sessionLogger?.logStep(`mcp_call_${tc.name}`, {
            arguments: tc.arguments,
          });
          const client = ctx.toolClientMap.get(tc.name);
          if (!client)
            return { tc, text: '', res: null, duration: 0, cached: false };
          const toolSpan = ctx.tracer.startSpan('smart_agent.tool_call', {
            parent: parentSpan,
            attributes: { 'tool.name': tc.name },
          });
          const cachedValue = ctx.toolCache.get(tc.name, tc.arguments);
          const wasCached = !!cachedValue;
          const res = cachedValue
            ? (() => {
                ctx.metrics.toolCacheHitCount.add();
                toolSpan.setAttribute('cache', 'hit');
                return { ok: true as const, value: cachedValue };
              })()
            : await (async () => {
                const r = await client.callTool(
                  tc.name,
                  tc.arguments,
                  ctx.options,
                );
                if (r.ok) ctx.toolCache.set(tc.name, tc.arguments, r.value);
                return r;
              })();
          const text = !res.ok
            ? res.error.message
            : typeof res.value.content === 'string'
              ? res.value.content
              : JSON.stringify(res.value.content);
          toolSpan.setStatus(
            res.ok ? 'ok' : 'error',
            res.ok ? undefined : text,
          );
          toolSpan.end();
          return {
            tc,
            text,
            res,
            duration: Date.now() - toolStart,
            cached: wasCached,
          };
        },
      );

      // Race: tool execution vs periodic heartbeat
      const allDone = Promise.all(toolExecPromises);
      const pendingTools = new Set(batch.map((tc) => tc.name));
      const toolStartTime = Date.now();
      let results: ToolExecResult[] = [];
      let settled = false;

      for (const [i, p] of toolExecPromises.entries()) {
        p.then(() => pendingTools.delete(batch[i].name));
      }

      while (!settled) {
        const winner = await Promise.race([
          allDone.then((r) => ({ tag: 'done' as const, results: r })),
          new Promise<{ tag: 'tick' }>((resolve) =>
            setTimeout(() => resolve({ tag: 'tick' }), heartbeatMs),
          ),
        ]);
        if (winner.tag === 'done') {
          results = winner.results;
          settled = true;
        } else {
          for (const tool of pendingTools) {
            ctx.yield({
              ok: true,
              value: {
                content: '',
                heartbeat: { tool, elapsed: Date.now() - toolStartTime },
              },
            });
          }
        }
      }

      // Collect timing
      for (const r of results) {
        timingLog.push({ phase: `tool_${r.tc.name}`, duration: r.duration });
      }

      // Process results
      const toolMessages: Message[] = [];
      for (const r of results) {
        const { tc, text, res } = r;
        if (!res) continue;
        if (!res.ok && isToolContextUnavailableError(text)) {
          const entry = ctx.toolAvailabilityRegistry.block(
            ctx.sessionId,
            tc.name,
            text,
          );
          currentTools = currentTools.filter((t) => t.name !== tc.name);
          ctx.options?.sessionLogger?.logStep(`tool_blacklisted_${tc.name}`, {
            reason: text,
            blockedUntil: entry.blockedUntil,
          });
        }
        ctx.options?.sessionLogger?.logStep(`mcp_result_${tc.name}`, {
          result: text,
        });
        toolCallCount++;
        ctx.metrics.toolCallCount.add();
        toolMessages.push({
          role: 'tool' as const,
          content: text,
          tool_call_id: tc.id,
        });
        ctx.requestLogger.logToolCall({
          toolName: tc.name,
          success: !!res?.ok,
          durationMs: r.duration,
          cached: r.cached,
        });
      }
      messages = [...messages, ...toolMessages];
    }
  }
}
