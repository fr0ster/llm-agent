import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  retrievalEmbedderOf,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag } from '../in-memory-rag.js';
import { VectorRag } from '../vector-rag.js';

const embedder = symmetricEmbedder({ embed: async () => ({ vector: [1, 0] }) });

describe('VectorRag is an IRetrievalEmbedderOwner (spec §3.7)', () => {
  it('VectorRag exposes its embedder', () => {
    assert.equal(retrievalEmbedderOf(new VectorRag(embedder)), embedder);
  });
  it('InMemoryRag has none', () => {
    assert.equal(retrievalEmbedderOf(new InMemoryRag()), undefined);
  });
});
