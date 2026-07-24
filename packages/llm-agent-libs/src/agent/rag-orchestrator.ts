import type {
  CallOptions,
  IMcpClient,
  LlmTool,
  McpTool,
  Message,
  RagResult,
  Result,
  Subprompt,
} from '@mcp-abap-adt/llm-agent';
import {
  OrchestratorError,
  QueryEmbedding,
  TextOnlyEmbedding,
  toolNameFromRecord,
} from '@mcp-abap-adt/llm-agent';
import type { ISpan } from '../tracer/types.js';
import { summarizeHistory, toEnglishForRag } from './rag-helpers.js';
import type {
  IRagOrchestrator,
  OrchestratedContext,
  OrchestrateOptions,
  RagOrchestratorDeps,
} from './rag-orchestrator-types.js';

export { summarizeHistory, toEnglishForRag } from './rag-helpers.js';
export type {
  IRagOrchestrator,
  OrchestratedContext,
  OrchestrateOptions,
  RagOrchestratorDeps,
} from './rag-orchestrator-types.js';

export class RagOrchestrator implements IRagOrchestrator {
  private readonly toEnglish: typeof toEnglishForRag;
  private readonly summarize: typeof summarizeHistory;

  constructor(private readonly deps: RagOrchestratorDeps) {
    this.toEnglish = deps.toEnglishForRag ?? toEnglishForRag;
    this.summarize = deps.summarizeHistory ?? summarizeHistory;
  }

  async orchestrate(
    input: string | Message[],
    options: OrchestrateOptions,
  ): Promise<Result<OrchestratedContext, OrchestratorError>> {
    const { opts, rootSpan, sessionId, mode, externalTools } = options;

    // 1. Unified Preparation (default hardcoded flow)
    const initResult = await this._preparePipeline(input, opts, rootSpan);
    if (!initResult.ok) {
      return initResult;
    }
    let { processedHistory } = initResult.value;
    const { subprompts, toolClientMap } = initResult.value;

    // Token budget check — summarize if over budget
    if (this.deps.sessionManager.isOverBudget()) {
      const sumResult = await this.summarize(
        {
          helperLlm: this.deps.helperLlm,
          requestLogger: this.deps.requestLogger,
          historySummaryPrompt: this.deps.config.historySummaryPrompt,
        },
        processedHistory,
        opts,
      );
      if (sumResult.ok) processedHistory = sumResult.value;
      this.deps.sessionManager.reset();
    }

    // 2. Decide context and tools for the WHOLE request
    await this.deps.mcpToolRegistry.resolveActiveClients(opts);
    const actions = subprompts.filter((sp) => sp.type === 'action');
    const hasActions = actions.length > 0;
    const hasMcpClients =
      this.deps.mcpToolRegistry.getActiveClients().length > 0;
    const hasRagStores = Object.keys(this.deps.ragStores).length > 0;
    const shouldRetrieve =
      mode === 'hard' || (hasActions && (hasMcpClients || hasRagStores));

    let finalTools: LlmTool[] = [];
    let retrieved: {
      ragResults: Record<string, RagResult[]>;
      tools: McpTool[];
    } = {
      ragResults: {},
      tools: [],
    };
    let skillContent = '';

    if (shouldRetrieve) {
      // Collect all action texts for RAG
      const combinedActionText = actions.map((a) => a.text).join(' ');

      // Translate + expand once (only used for stores in translateQueryStores)
      const translateStores = this.deps.translateQueryStores;
      let translatedText: string | undefined;
      if (translateStores && translateStores.size > 0) {
        translatedText = await this.toEnglish(
          {
            helperLlm: this.deps.helperLlm,
            mainLlm: this.deps.mainLlm,
            ragTranslatePrompt: this.deps.config.ragTranslatePrompt,
          },
          combinedActionText,
          opts,
        );
        if (this.deps.config.queryExpansionEnabled) {
          const expandResult = await this.deps.queryExpander.expand(
            translatedText,
            opts,
          );
          if (expandResult.ok) translatedText = expandResult.value;
        }
      }

      const k = this.deps.config.ragQueryK ?? 10;
      const ragSpan = this.deps.tracer.startSpan('smart_agent.rag_query', {
        parent: rootSpan,
        attributes: { 'rag.k': k },
      });
      const storeEntries = Object.entries(this.deps.ragStores);

      // Build per-store embedding: translated for translateQuery stores, original for others
      const mkEmbed = (text: string) =>
        this.deps.embedder
          ? new QueryEmbedding(text, this.deps.embedder, opts)
          : new TextOnlyEmbedding(text);
      // Cache embeddings to avoid duplicate embed calls
      const originalEmbedding = mkEmbed(combinedActionText);
      const translatedEmbedding =
        translatedText && translatedText !== combinedActionText
          ? mkEmbed(translatedText)
          : originalEmbedding;

      const ragQueryResults = await Promise.all(
        storeEntries.map(([name, store]) => {
          const emb =
            translateStores?.has(name) && translatedText
              ? translatedEmbedding
              : originalEmbedding;
          return store.query(emb, k, opts).then((r) => ({ name, result: r }));
        }),
      );
      ragSpan.end();
      const ragResultsMap: Record<string, RagResult[]> = {};
      for (const { name, result: r } of ragQueryResults) {
        ragResultsMap[name] = r.ok ? r.value : [];
        this.deps.metrics.ragQueryCount.add(1, {
          store: name,
          hit: String(r.ok && r.value.length > 0),
        });
      }

      // Rerank results
      // Rerank all stores in parallel, using matching query text per store
      const rerankedEntries = await Promise.all(
        Object.entries(ragResultsMap).map(async ([name, results]) => {
          if (results.length > 0) {
            const rerankText =
              translateStores?.has(name) && translatedText
                ? translatedText
                : combinedActionText;
            const rr = await this.deps.reranker.rerank(
              rerankText,
              results,
              opts,
            );
            return { name, results: rr.ok ? rr.value : results };
          }
          return { name, results };
        }),
      );
      const rerankedMap: Record<string, RagResult[]> = {};
      for (const { name, results } of rerankedEntries) {
        rerankedMap[name] = results;
      }

      const { tools: mcpTools } = await this.deps.mcpToolRegistry.resolve(opts);

      // Collect all RAG results for tool discovery
      const allRagResults = Object.values(rerankedMap).flat();

      // Log RAG results with scores for diagnostics
      for (const [storeName, results] of Object.entries(rerankedMap)) {
        const logQuery =
          translateStores?.has(storeName) && translatedText
            ? translatedText
            : combinedActionText;
        opts?.sessionLogger?.logStep(
          `rag_query_${storeName}`,
          {
            query: logQuery.slice(0, 200),
            k,
            resultCount: results.length,
            results: results.map((r) => ({
              id: r.metadata.id,
              score: r.score,
              text: r.text.slice(0, 120),
            })),
          },
          'rag',
        );
      }

      const ragToolNames = new Set(
        allRagResults
          .map((r) => toolNameFromRecord(r.metadata))
          .filter((n): n is string => n !== undefined),
      );
      const selectedMcpTools =
        ragToolNames.size > 0
          ? mcpTools.filter((t) => ragToolNames.has(t.name))
          : mode === 'hard'
            ? mcpTools
            : [];

      // Log tool selection diagnostics
      opts?.sessionLogger?.logStep('tools_selected', {
        totalMcp: mcpTools.length,
        ragMatchedTools: [...ragToolNames],
        selectedCount: selectedMcpTools.length + externalTools.length,
        selectedNames: [
          ...selectedMcpTools.map((t) => t.name),
          ...externalTools.map((t) => t.name),
        ],
      });

      retrieved = {
        ragResults: rerankedMap,
        tools: selectedMcpTools,
      };
      // D4: external (client) tools are always offered regardless of mode;
      // mode governs only the worker's INTERNAL execution posture.
      finalTools = [...(selectedMcpTools as LlmTool[]), ...externalTools];
      opts?.sessionLogger?.logStep('external_tools_merge', {
        mode,
        mcpCount: selectedMcpTools.length,
        externalCount: externalTools.length,
        externalNames: externalTools.map((t) => t.name),
        finalCount: finalTools.length,
      });

      // Skill injection (when enabled and skillManager configured)
      if (
        this.deps.config.skillInjectionEnabled !== false &&
        this.deps.skillManager
      ) {
        const ragSkillNames = new Set(
          allRagResults
            .map((r) => r.metadata.id as string)
            .filter((id) => id?.startsWith('skill:'))
            .map((id) => id.slice(6)),
        );

        // Fallback: dedicated RAG query when no skill:* in existing results
        if (ragSkillNames.size === 0) {
          const k = this.deps.config.ragQueryK ?? 15;
          const storeEntries = Object.entries(this.deps.ragStores);
          const fallbackResults = await Promise.all(
            storeEntries.map(([name, store]) => {
              const text =
                translateStores?.has(name) && translatedText
                  ? translatedText
                  : combinedActionText;
              const emb = this.deps.embedder
                ? new QueryEmbedding(text, this.deps.embedder, opts)
                : new TextOnlyEmbedding(text);
              return store.query(emb, k, opts);
            }),
          );
          for (const result of fallbackResults) {
            if (result.ok) {
              for (const r of result.value) {
                const id = r.metadata.id as string;
                if (id?.startsWith('skill:')) {
                  ragSkillNames.add(id.slice(6));
                }
              }
            }
          }
          if (ragSkillNames.size > 0) {
            opts?.sessionLogger?.logStep('skill_select_rag_fallback', {
              query: combinedActionText.slice(0, 200),
              k,
              matchedSkills: [...ragSkillNames],
            });
          }
        }

        const allSkillsResult = await this.deps.skillManager.listSkills(opts);
        if (allSkillsResult.ok) {
          const allSkills = allSkillsResult.value;
          const matched =
            ragSkillNames.size > 0
              ? allSkills.filter((s) => ragSkillNames.has(s.name))
              : mode === 'hard'
                ? allSkills
                : [];
          const contentParts: string[] = [];
          for (const skill of matched) {
            const contentResult = await skill.getContent(undefined, opts);
            if (contentResult.ok && contentResult.value) {
              contentParts.push(
                `### Skill: ${skill.name}\n${contentResult.value}`,
              );
            }
          }
          skillContent = contentParts.join('\n\n');
          opts?.sessionLogger?.logStep('skills_selected', {
            totalSkills: allSkills.length,
            ragMatchedSkills: [...ragSkillNames],
            selectedCount: matched.length,
            selectedNames: matched.map((s) => s.name),
          });
        }
      }
    } else {
      // If we're here, mode is definitely 'smart' (not 'hard' or 'pass')
      finalTools = externalTools;
    }
    const filteredTools = this.deps.toolAvailabilityRegistry.filterTools(
      sessionId,
      finalTools,
    );
    finalTools = filteredTools.allowed;
    if (filteredTools.blocked.length > 0) {
      opts?.sessionLogger?.logStep('active_tools_filtered_by_registry', {
        blocked: filteredTools.blocked,
      });
    }

    // 3. Assemble Context once
    const mainAction =
      actions.length > 1
        ? {
            type: 'action' as const,
            text: actions.map((a) => a.text).join('\n'),
            context: actions.find((a) => a.context)?.context,
            dependency: 'independent' as const,
          }
        : actions.length === 1
          ? actions[0]
          : subprompts.find((sp) => sp.type === 'chat') || subprompts[0];

    if (actions.length > 1) {
      opts?.sessionLogger?.logStep('actions_merged', {
        count: actions.length,
        actions: actions.map((a) => ({
          text: a.text,
          dependency: a.dependency,
        })),
      });
    }
    const assembleSpan = this.deps.tracer.startSpan('smart_agent.assemble', {
      parent: rootSpan,
    });
    const assembleResult = await this.deps.assembler.assemble(
      mainAction,
      retrieved,
      processedHistory,
      opts,
    );
    if (!assembleResult.ok) {
      assembleSpan.setStatus('error', assembleResult.error.message);
      assembleSpan.end();
      return {
        ok: false,
        error: new OrchestratorError(
          assembleResult.error.message,
          'ASSEMBLER_ERROR',
        ),
      };
    }
    assembleSpan.setStatus('ok');
    assembleSpan.end();

    // Inject skill content into system message (post-assembly)
    if (skillContent) {
      const sysMsg = assembleResult.value.find((m) => m.role === 'system');
      if (sysMsg) {
        sysMsg.content += `\n\n## Active Skills\n${skillContent}`;
      } else {
        assembleResult.value.unshift({
          role: 'system' as const,
          content: `## Active Skills\n${skillContent}`,
        });
      }
    }

    opts?.sessionLogger?.logStep(`final_context_assembled`, {
      messages: assembleResult.value,
      tools: finalTools.map((t) => t.name),
    });

    return {
      ok: true,
      value: {
        retrieved,
        finalTools,
        skillContent,
        assembledMessages: assembleResult.value,
        mainAction,
        toolClientMap,
      },
    };
  }

  private async _preparePipeline(
    textOrMessages: string | Message[],
    opts: CallOptions | undefined,
    parentSpan: ISpan,
  ): Promise<
    Result<
      {
        subprompts: Subprompt[];
        processedHistory: Message[];
        toolClientMap: Map<string, IMcpClient>;
      },
      OrchestratorError
    >
  > {
    opts?.sessionLogger?.logStep('client_request', { textOrMessages });
    const text =
      typeof textOrMessages === 'string'
        ? textOrMessages
        : (textOrMessages.filter((m) => m.role === 'user').slice(-1)[0]
            ?.content ?? '');
    const history = typeof textOrMessages === 'string' ? [] : textOrMessages;
    let processedHistory = history;
    const summarizeLimit = this.deps.config.historyAutoSummarizeLimit ?? 10;
    if (this.deps.helperLlm && history.length > summarizeLimit) {
      const res = await this.summarize(
        {
          helperLlm: this.deps.helperLlm,
          requestLogger: this.deps.requestLogger,
          historySummaryPrompt: this.deps.config.historySummaryPrompt,
        },
        history,
        opts,
      );
      if (res.ok) processedHistory = res.value;
    }

    let subprompts: Subprompt[];

    if (this.deps.config.classificationEnabled === false) {
      // Skip classification — treat entire input as a single action
      subprompts = [
        { type: 'action', text, dependency: 'independent' as const },
      ];
      opts?.sessionLogger?.logStep('classification_skipped', { text });
    } else {
      const classifySpan = this.deps.tracer.startSpan('smart_agent.classify', {
        parent: parentSpan,
      });
      const classifyResult = await this.deps.classifier.classify(text, opts);
      if (!classifyResult.ok) {
        classifySpan.setStatus('error', classifyResult.error.message);
        classifySpan.end();
        return {
          ok: false,
          error: new OrchestratorError(
            classifyResult.error.message,
            'CLASSIFIER_ERROR',
          ),
        };
      }
      classifySpan.setStatus('ok');
      classifySpan.end();
      opts?.sessionLogger?.logStep('classifier_response', {
        subprompts: classifyResult.value,
      });
      subprompts = classifyResult.value;
    }
    for (const sp of subprompts) {
      this.deps.metrics.classifierIntentCount.add(1, { intent: sp.type });
    }
    const { toolClientMap } = await this.deps.mcpToolRegistry.resolve(opts);
    return { ok: true, value: { subprompts, processedHistory, toolClientMap } };
  }
}
