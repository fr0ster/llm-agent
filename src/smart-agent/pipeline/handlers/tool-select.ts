/**
 * ToolSelectHandler — selects MCP tools based on RAG results.
 *
 * Reads: `ctx.ragResults.facts`, `ctx.mcpTools`, `ctx.externalTools`, `ctx.toolClientMap`
 * Writes: `ctx.selectedTools`, `ctx.activeTools`
 *
 * Uses RAG fact IDs with the `tool:` prefix to identify relevant MCP tools.
 *
 * If RAG retrieval was skipped (e.g. `shouldRetrieve` was false), the handler
 * performs its own facts RAG query to discover tools. This ensures tools are
 * always discoverable regardless of domain context detection.
 *
 * Falls back to all MCP tools in `hard` mode or external-only in `smart` mode.
 */

import type { LlmTool } from '../../interfaces/types.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export class ToolSelectHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
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
      for (const entry of settled) {
        if (entry.status === 'fulfilled' && entry.value.result.ok) {
          for (const t of entry.value.result.value) {
            if (!ctx.toolClientMap.has(t.name)) {
              ctx.mcpTools.push(t);
              ctx.toolClientMap.set(t.name, entry.value.client);
            }
          }
        }
      }
    }

    // If RAG retrieval was skipped, query facts store directly for tool discovery.
    // Tools should always be discoverable regardless of shouldRetrieve flag.
    let factsResults = ctx.ragResults.facts;
    if (factsResults.length === 0 && ctx.mcpTools.length > 0) {
      const k = (config.k as number) ?? ctx.config.ragQueryK ?? 20;
      const queryText = ctx.ragText || ctx.inputText;
      const result = await ctx.ragStores.facts.query(queryText, k, ctx.options);

      if (result.ok) {
        factsResults = result.value;
        // Also populate ctx.ragResults.facts so assemble can use them
        ctx.ragResults.facts = result.value;

        ctx.options?.sessionLogger?.logStep('tool_select_rag_fallback', {
          reason:
            'RAG retrieval was skipped, querying facts for tool discovery',
          query: queryText.slice(0, 200),
          k,
          resultCount: result.value.length,
          results: result.value.map((r) => ({
            id: r.metadata.id,
            score: r.score,
            text: r.text.slice(0, 120),
          })),
        });
      }
    }

    // Select tools based on RAG results
    const ragToolNames = new Set(
      factsResults
        .map((r) => r.metadata.id as string)
        .filter((id) => id?.startsWith('tool:'))
        .map((id) => id.slice(5)),
    );

    const selectedMcpTools =
      ragToolNames.size > 0
        ? ctx.mcpTools.filter((t) => ragToolNames.has(t.name))
        : mode === 'hard'
          ? ctx.mcpTools
          : [];

    ctx.selectedTools =
      mode === 'hard'
        ? (selectedMcpTools as LlmTool[])
        : [...(selectedMcpTools as LlmTool[]), ...ctx.externalTools];

    // Apply availability filtering
    const filtered = ctx.toolAvailabilityRegistry.filterTools(
      ctx.sessionId,
      ctx.selectedTools,
    );
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
      ragMatchedTools: [...ragToolNames],
      selectedCount: ctx.selectedTools.length,
      selectedNames: ctx.selectedTools.map((t) => t.name),
      activeCount: ctx.activeTools.length,
    });

    return true;
  }
}
