/**
 * Default pipeline definition — matches the current hardcoded SmartAgent flow.
 *
 * This serves two purposes:
 * 1. **Documentation** — shows exactly what stages the default pipeline runs.
 * 2. **Fallback** — used when no custom pipeline is defined.
 *
 * ## Default pipeline stages
 *
 * ```text
 * classify           — decompose user input into typed subprompts
 *   ↓
 * summarize          — condense history if too long (conditional)
 *   ↓
 * rag-retrieval      — parallel block (conditional on shouldRetrieve):
 *   ├─ translate      — translate non-ASCII to English
 *   └─ expand         — expand query with synonyms
 *   after:
 *   ├─ rag-query ×3   — query facts/feedback/state in parallel
 *   └─ rerank         — re-score RAG results
 *   ↓
 * skill-select        — select and load matched skills (conditional on skillManager)
 *   ↓
 * tool-select         — ALWAYS runs (queries facts RAG if retrieval was skipped)
 *   ↓
 * assemble           — build final LLM context
 *   ↓
 * tool-loop           — streaming LLM + tool execution loop
 * ```
 */

import type { StageDefinition, StructuredPipelineDefinition } from './types.js';

/**
 * Returns the default pipeline stage definitions.
 *
 * This matches the behavior of `SmartAgent.streamProcess()` when no
 * structured pipeline is configured.
 */
export function getDefaultPipelineDefinition(): StructuredPipelineDefinition {
  return {
    version: '1',
    stages: getDefaultStages(),
  };
}

/**
 * Returns the default stage list.
 * Exported separately for composition — consumers can use this as a base
 * and add/remove/reorder stages.
 */
export function getDefaultStages(): StageDefinition[] {
  return [
    {
      id: 'classify',
      type: 'classify',
    },
    {
      id: 'summarize',
      type: 'summarize',
    },
    {
      id: 'rag-retrieval',
      type: 'parallel',
      when: 'shouldRetrieve',
      stages: [
        {
          id: 'translate',
          type: 'translate',
        },
        {
          id: 'expand',
          type: 'expand',
        },
      ],
      after: [
        {
          id: 'rag-query',
          type: 'parallel',
          stages: [
            {
              id: 'rag-facts',
              type: 'rag-query',
              config: { store: 'facts' },
            },
            {
              id: 'rag-feedback',
              type: 'rag-query',
              config: { store: 'feedback' },
            },
            {
              id: 'rag-state',
              type: 'rag-query',
              config: { store: 'state' },
            },
          ],
        },
        {
          id: 'rerank',
          type: 'rerank',
        },
      ],
    },
    {
      id: 'skill-select',
      type: 'skill-select',
    },
    {
      id: 'tool-select',
      type: 'tool-select',
    },
    {
      id: 'assemble',
      type: 'assemble',
    },
    {
      id: 'tool-loop',
      type: 'tool-loop',
    },
    {
      id: 'history-upsert',
      type: 'history-upsert',
    },
  ];
}
