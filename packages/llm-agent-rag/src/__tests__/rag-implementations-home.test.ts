// packages/llm-agent-rag/src/__tests__/rag-implementations-home.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as core from '@mcp-abap-adt/llm-agent';
import * as rag from '../index.js';

/** Spec §11.3 "moves" — every runtime name (types: Step 9's typecheck). */
const MOVED_VALUES = [
  'VectorRag',
  'InMemoryRag',
  'OverlayRag',
  'SessionScopedRag',
  'ActiveFilteringRag',
  'SimpleRagRegistry',
  'ragStoreKey',
  'InMemoryRagProvider',
  'VectorRagProvider',
  'SimpleRagProviderRegistry',
  'WeightedFusionStrategy',
  'RrfStrategy',
  'VectorOnlyStrategy',
  'Bm25OnlyStrategy',
  'CompositeStrategy',
  'NoopQueryPreprocessor',
  'NoopDocumentEnricher',
  'TranslatePreprocessor',
  'ExpandPreprocessor',
  'IntentEnricher',
  'PreprocessorChain',
  'LlmQueryExpander',
  'NoopQueryExpander',
  'buildRagCollectionToolEntries',
] as const;

describe('the RAG implementations live in llm-agent-rag (spec §11.3, D57)', () => {
  for (const name of MOVED_VALUES) {
    it(`${name}: exported by llm-agent-rag, not by llm-agent`, () => {
      assert.equal(
        typeof (rag as Record<string, unknown>)[name],
        'function',
        `${name} missing from llm-agent-rag`,
      );
      assert.equal(
        name in core,
        false,
        `${name} still exported by @mcp-abap-adt/llm-agent`,
      );
    });
  }
  it('the private helpers stay private', () => {
    assert.equal('InvertedIndex' in rag, false);
    assert.equal('tokenizeSearchText' in rag, false);
  });
});
