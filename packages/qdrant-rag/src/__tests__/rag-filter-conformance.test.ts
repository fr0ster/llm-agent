import { after, before, describe, it } from 'node:test';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  conformanceEmbedder,
  ragFilterConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import { QdrantRag } from '../qdrant-rag.js';
import { type QdrantStub, startQdrantStub } from './qdrant-stub.js';

// The shared conformance kit over QdrantRag, against a stub that evaluates the
// search filter with Qdrant's documented semantics. The same cases run live
// against a real Qdrant in the release check.
describe('QdrantRag — filter conformance (stub)', () => {
  let stub: QdrantStub;
  let n = 0;
  before(async () => {
    stub = await startQdrantStub();
  });
  after(async () => {
    await stub.close();
  });

  for (const c of ragFilterConformanceCases) {
    it(c.name, () =>
      c.run(
        async () =>
          new QdrantRag({
            url: stub.baseUrl,
            collectionName: `conf_${n++}`,
            embedder: symmetricEmbedder(conformanceEmbedder()),
          }),
      ),
    );
  }
});
