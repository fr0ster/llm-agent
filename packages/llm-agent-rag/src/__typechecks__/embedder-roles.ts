/**
 * Compile-time contract of the embedder roles (type-checked by
 * `npm run typecheck`, never run). The roles are told apart by their METHOD
 * NAMES — `embedDocument` vs `embedQuery` — so the compiler refuses one where
 * the other is expected, with no tag and no runtime check. Each
 * `@ts-expect-error` line MUST fail to compile.
 */
import type {
  IDocumentEmbedder,
  IEmbedder,
  IEmbedResult,
  IQueryEmbedder,
  IRetrievalEmbedder,
} from '@mcp-abap-adt/llm-agent';
import {
  asymmetricEmbedder,
  QueryEmbedding,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { VectorRagProvider } from '../providers/vector-rag-provider.js';
import { VectorRag } from '../vector-rag.js';

const result = async (): Promise<IEmbedResult> => ({ vector: [1] });
declare const provider: IEmbedder;
declare const documentOnly: IDocumentEmbedder;
declare const queryOnly: IQueryEmbedder;

const writes = (_e: IDocumentEmbedder) => undefined;
const searches = (_e: IQueryEmbedder) => undefined;

// A retrieval embedder does both jobs — built once, at the boundary.
const symmetric: IRetrievalEmbedder = symmetricEmbedder(provider);
const asymmetric: IRetrievalEmbedder = asymmetricEmbedder({
  document: provider,
  query: provider,
});
writes(symmetric);
searches(asymmetric);

// One role is not the other: different method names.
// @ts-expect-error — a document embedder cannot embed a query
searches(documentOnly);
// @ts-expect-error — a query embedder cannot embed a document
writes(queryOnly);
// @ts-expect-error — nor can the provider's IEmbedder, until it is given a role
searches(provider);
// @ts-expect-error — nor as a document embedder
writes(provider);

// A store needs both jobs: one role alone is refused.
new VectorRag(symmetric);
// @ts-expect-error — a store that only writes could not embed its own search text
new VectorRag(documentOnly);
// @ts-expect-error — a store that only searches could not write
new VectorRag(queryOnly);
// @ts-expect-error — a provider's IEmbedder has no role yet
new VectorRag(provider);
// @ts-expect-error — the collection provider needs both jobs too
new VectorRagProvider({ name: 'p', embedder: documentOnly });
new VectorRagProvider({ name: 'p', embedder: asymmetric });

// A query embedding takes the query role only.
new QueryEmbedding('q', queryOnly);
new QueryEmbedding('q', symmetric);
// @ts-expect-error — a document embedder cannot embed a query
new QueryEmbedding('q', documentOnly);

void result;
