import { describe, it } from 'node:test';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  conformanceEmbedder,
  ragFilterConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import { InMemoryRag } from '../in-memory-rag.js';
import { VectorRag } from '../vector-rag.js';

describe('RAG identity filter conformance — InMemoryRag', () => {
  for (const c of ragFilterConformanceCases) {
    it(c.name, () => c.run(async () => new InMemoryRag()));
  }
});

describe('RAG identity filter conformance — VectorRag', () => {
  for (const c of ragFilterConformanceCases) {
    it(c.name, () =>
      c.run(
        async () => new VectorRag(symmetricEmbedder(conformanceEmbedder())),
      ),
    );
  }
});
