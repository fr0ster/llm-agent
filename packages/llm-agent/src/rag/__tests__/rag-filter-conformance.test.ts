import { describe, it } from 'node:test';
import {
  conformanceEmbedder,
  ragFilterConformanceCases,
} from '../../testing/rag-filter-conformance.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { VectorRag } from '../vector-rag.js';

describe('RAG identity filter conformance — InMemoryRag', () => {
  for (const c of ragFilterConformanceCases) {
    it(c.name, () => c.run(async () => new InMemoryRag()));
  }
});

describe('RAG identity filter conformance — VectorRag', () => {
  for (const c of ragFilterConformanceCases) {
    it(c.name, () => c.run(async () => new VectorRag(conformanceEmbedder())));
  }
});
