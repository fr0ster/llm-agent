/**
 * MCP tool + skill vectorization — extracted from SmartAgentBuilder.build()
 * per docs/ARCHITECTURE.md tech-debt (the builder's MCP block: connect stays
 * in the builder; the vectorization is pulled into this small module).
 *
 * Pure coordinators of catalog components — no builder state, no private fields.
 */

import type {
  IEmbedder,
  ILogger,
  IMcpClient,
  IRag,
  IRequestLogger,
  ISkillManager,
} from '@mcp-abap-adt/llm-agent';
import { isBatchEmbedder } from '@mcp-abap-adt/llm-agent';

export async function vectorizeMcpTools(
  clients: IMcpClient[],
  toolsRag: IRag | undefined,
  requestLogger: IRequestLogger,
  logger: ILogger | undefined,
): Promise<void> {
  for (const adapter of clients) {
    try {
      // Vectorize tools into the tools RAG store
      if (toolsRag) {
        const toolsResult = await adapter.listTools();
        if (toolsResult.ok) {
          const tools = toolsResult.value;
          // Try to access the embedder from the store for batch embedding.
          // VectorRag and QdrantRag store their embedder as a private field.
          // biome-ignore lint/suspicious/noExplicitAny: accessing private embedder for batch optimization
          const storeEmbedder = (toolsRag as any).embedder as
            | IEmbedder
            | undefined;

          if (
            storeEmbedder &&
            isBatchEmbedder(storeEmbedder) &&
            toolsRag.writer?.()?.upsertPrecomputedRaw !== undefined
          ) {
            // Batch path: single HTTP call for all tools
            const texts = tools.map(
              (t) => `Tool: ${t.name} — ${t.description}`,
            );
            const batchStart = Date.now();
            try {
              const embedResults = await storeEmbedder.embedBatch(texts);
              const batchDuration = Date.now() - batchStart;
              for (let i = 0; i < tools.length; i++) {
                const toolWriter = toolsRag.writer?.();
                const result = toolWriter?.upsertPrecomputedRaw
                  ? await toolWriter.upsertPrecomputedRaw(
                      `tool:${tools[i].name}`,
                      texts[i],
                      embedResults[i].vector,
                      {},
                    )
                  : toolWriter
                    ? await toolWriter.upsertRaw(
                        `tool:${tools[i].name}`,
                        texts[i],
                        {},
                      )
                    : ({ ok: true, value: undefined } as const);
                if (!result.ok) {
                  logger?.log({
                    type: 'warning',
                    traceId: 'builder',
                    message: `Tool vectorization failed for "${tools[i].name}": ${result.error.message}`,
                  });
                }
              }
              const realUsage = embedResults.reduce<{
                promptTokens: number;
                totalTokens: number;
              } | null>((acc, r) => {
                if (!r.usage) return acc;
                return {
                  promptTokens: (acc?.promptTokens ?? 0) + r.usage.promptTokens,
                  totalTokens: (acc?.totalTokens ?? 0) + r.usage.totalTokens,
                };
              }, null);
              const totalEstTokens = texts.reduce(
                (sum, t) => sum + Math.ceil(t.length / 4),
                0,
              );
              requestLogger.logLlmCall({
                component: 'embedding',
                model: 'embedder',
                promptTokens: realUsage?.promptTokens ?? totalEstTokens,
                completionTokens: 0,
                totalTokens: realUsage?.totalTokens ?? totalEstTokens,
                durationMs: batchDuration,
                estimated: realUsage === null,
                scope: 'initialization',
                detail: 'tools',
              });
            } catch (err) {
              logger?.log({
                type: 'warning',
                traceId: 'builder',
                message: `Batch embedding failed, falling back to sequential: ${String(err)}`,
              });
              // Fallback to sequential
              const batchSize = 5;
              const batchDelayMs = 500;
              for (let i = 0; i < tools.length; i++) {
                const t = tools[i];
                const text = `Tool: ${t.name} — ${t.description}`;
                const embedStart = Date.now();
                const result = await toolsRag
                  .writer?.()
                  ?.upsertRaw(`tool:${t.name}`, text, {});
                if (result && !result.ok) {
                  logger?.log({
                    type: 'warning',
                    traceId: 'builder',
                    message: `Tool vectorization failed for "${t.name}": ${result.error.message}`,
                  });
                } else {
                  requestLogger.logLlmCall({
                    component: 'embedding',
                    model: 'embedder',
                    promptTokens: Math.ceil(text.length / 4),
                    completionTokens: 0,
                    totalTokens: Math.ceil(text.length / 4),
                    durationMs: Date.now() - embedStart,
                    estimated: true,
                    scope: 'initialization',
                    detail: 'tools',
                  });
                }
                if ((i + 1) % batchSize === 0 && i < tools.length - 1) {
                  await new Promise((r) => setTimeout(r, batchDelayMs));
                }
              }
            }
          } else {
            // Sequential path (no batch support)
            const batchSize = 5;
            const batchDelayMs = 500;
            for (let i = 0; i < tools.length; i++) {
              const t = tools[i];
              const text = `Tool: ${t.name} — ${t.description}`;
              const embedStart = Date.now();
              const result = await toolsRag
                .writer?.()
                ?.upsertRaw(`tool:${t.name}`, text, {});
              if (result && !result.ok) {
                logger?.log({
                  type: 'warning',
                  traceId: 'builder',
                  message: `Tool vectorization failed for "${t.name}": ${result.error.message}`,
                });
              } else {
                requestLogger.logLlmCall({
                  component: 'embedding',
                  model: 'embedder',
                  promptTokens: Math.ceil(text.length / 4),
                  completionTokens: 0,
                  totalTokens: Math.ceil(text.length / 4),
                  durationMs: Date.now() - embedStart,
                  estimated: true,
                  scope: 'initialization',
                  detail: 'tools',
                });
              }
              if ((i + 1) % batchSize === 0 && i < tools.length - 1) {
                await new Promise((r) => setTimeout(r, batchDelayMs));
              }
            }
          }
        }
      }
    } catch (err) {
      // Tool vectorization failed for this client — skip it; the agent
      // continues. (Connection failures are handled inside the strategy,
      // which skips a down target and reconnects it later.)
      logger?.log({
        type: 'warning',
        traceId: 'builder',
        message: `Tool vectorization failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

export async function vectorizeSkills(
  skillManager: ISkillManager,
  toolsRag: IRag,
  requestLogger: IRequestLogger,
  logger: ILogger | undefined,
): Promise<void> {
  const skillsResult = await skillManager.listSkills();
  if (skillsResult.ok) {
    for (const s of skillsResult.value) {
      const text = `Skill: ${s.name}\n${s.description}`;
      const embedStart = Date.now();
      const result = await toolsRag
        .writer?.()
        ?.upsertRaw(`skill:${s.name}`, text, {});
      if (result && !result.ok) {
        logger?.log({
          type: 'warning',
          traceId: 'builder',
          message: `Skill vectorization failed for "${s.name}": ${result.error.message}`,
        });
      } else {
        requestLogger.logLlmCall({
          component: 'embedding',
          model: 'embedder',
          promptTokens: Math.ceil(text.length / 4),
          completionTokens: 0,
          totalTokens: Math.ceil(text.length / 4),
          durationMs: Date.now() - embedStart,
          estimated: true,
          scope: 'initialization',
          detail: 'skills',
        });
      }
    }
  }
}
