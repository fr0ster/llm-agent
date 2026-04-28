#!/usr/bin/env node
/**
 * E2E RAG search: 4-way comparison of indexing strategies.
 *
 * 1. baseline:  original description only
 * 2. +synonym:  original + synonym variants (deterministic)
 * 3. +intent:   original + LLM intent keywords
 * 4. all:       original + synonym + intent (triple index)
 *
 * All use TranslatePreprocessor on queries + RRF strategy.
 *
 * Run:
 *   node --import tsx/esm scripts/e2e-rag-search.ts
 */
export {};
//# sourceMappingURL=e2e-rag-search.d.ts.map
