import {
  buildNamespacedTools,
  contextOverflowInSettled,
  defaultToolNamespace,
  mergeOfferedTools,
  type Result,
  type SmartAgentError,
  type StageDefinition,
  type ToolRetrievalResult,
} from '@mcp-abap-adt/llm-agent';
import {
  callerResolutionKey,
  resolveCallerIdentity,
} from '../../policy/caller-identity.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';
import { RagToolRetriever } from '../tool-retrieval/rag-tool-retriever.js';
import { toolRetrievalError } from '../tool-retrieval/tool-retrieval-error.js';

export class ToolSelectHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: NonNullable<StageDefinition['config']>,
    span: ISpan,
  ): Promise<boolean> {
    const mode = ctx.config.mode || 'smart';

    // List all MCP tools if not already done
    if (ctx.mcpTools.length === 0 && ctx.mcpClients.length > 0) {
      const settled = await Promise.allSettled(
        ctx.mcpClients.map(async (client) => ({
          client,
          result: await client.listTools(ctx.options),
        })),
      );
      const overflow = contextOverflowInSettled(settled, ({ result }) =>
        result.ok ? undefined : result.error,
      );
      if (overflow) throw overflow;
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
    }

    const candidateFilter = ctx.toolCandidateFilter;
    const candidates = candidateFilter
      ? ctx.mcpTools.filter((tool) => candidateFilter(tool, ctx.options))
      : ctx.mcpTools;
    if (candidateFilter) {
      const candidateNames = new Set(candidates.map(({ name }) => name));
      for (const name of ctx.toolClientMap.keys()) {
        if (!candidateNames.has(name)) ctx.toolClientMap.delete(name);
      }
    }

    const retriever =
      ctx.toolRetriever ??
      new RagToolRetriever({
        ragStores: ctx.ragStores,
        ragAccess: ctx.ragAccess,
        embedder: ctx.embedder,
        toolSelectionStrategy: ctx.toolSelectionStrategy,
        k: (config.k as number) ?? ctx.config.ragQueryK,
        hardMode: mode === 'hard',
      });
    const configuredText =
      typeof config.queryText === 'string'
        ? config.queryText === 'toolQueryText'
          ? (ctx.toolQueryText ?? ctx.ragText)
          : config.queryText
        : undefined;
    const text =
      configuredText ??
      (ctx.toolRetriever
        ? ctx.inputText
        : (ctx.toolQueryText ?? ctx.ragText ?? ctx.inputText));
    const request = ctx.toolRetriever
      ? { text, candidates }
      : { text, candidates, ragResults: ctx.ragResults };
    const options = ctx.toolRetriever
      ? { ...ctx.options, requestLogger: ctx.requestLogger }
      : ctx.options;
    let result: Result<ToolRetrievalResult, SmartAgentError>;
    try {
      result = await retriever.retrieve(request, options);
    } catch (error) {
      ctx.error = toolRetrievalError(error, options?.signal);
      return false;
    }
    if (!result.ok) {
      ctx.error = result.error;
      return false;
    }
    const retrievedNames = new Set(result.value.names);
    const selectedMcpTools = candidates.filter((tool) =>
      retrievedNames.has(tool.name),
    );
    if (ctx.toolRetriever) {
      ctx.retrievedToolNames = new Set(
        selectedMcpTools.map(({ name }) => name),
      );
    }

    ctx.selectedTools =
      mode === 'hard'
        ? selectedMcpTools
        : mergeOfferedTools(selectedMcpTools, ctx.externalTools);

    // Apply availability filtering
    const identity =
      ctx.callerResolution ?? resolveCallerIdentity(ctx.options, ctx.sessionId);
    const filtered =
      identity.kind === 'caller'
        ? ctx.toolAvailabilityRegistry.filterTools(
            callerResolutionKey(identity),
            ctx.selectedTools,
          )
        : { allowed: ctx.selectedTools, blocked: [] };
    ctx.activeTools = filtered.allowed;

    if (filtered.blocked.length > 0) {
      ctx.options?.sessionLogger?.logStep('active_tools_filtered_by_registry', {
        blocked: filtered.blocked,
      });
    }

    span.setAttribute('mcp_tools', ctx.mcpTools.length);
    span.setAttribute('selected', ctx.selectedTools.length);
    span.setAttribute('active', ctx.activeTools.length);

    // Log tool selection diagnostics
    ctx.options?.sessionLogger?.logStep('tools_selected', {
      totalMcp: ctx.mcpTools.length,
      ...('ragDiagnostics' in result.value &&
      typeof result.value.ragDiagnostics === 'object'
        ? result.value.ragDiagnostics
        : {}),
      selectedCount: ctx.selectedTools.length,
      selectedNames: ctx.selectedTools.map((t) => t.name),
      activeCount: ctx.activeTools.length,
      retriever: retriever.name,
    });

    return true;
  }
}
