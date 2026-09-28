/**
 * Compile-time contract of the embedder roles (type-checked by
 * `npm run typecheck`, never run). Each `@ts-expect-error` line MUST fail to
 * compile — if one starts compiling, the role check has stopped working.
 */
import type {
  IDocumentEmbedder,
  IEmbedder,
  IEmbedResult,
  IQueryEmbedder,
} from '../../interfaces/rag.js';
import { CircuitBreaker } from '../../resilience/circuit-breaker.js';
import { withCircuitBreaker } from '../../resilience/circuit-breaker-embedder.js';
import { composeResilientEmbedder } from '../../resilience/embedder-resilience.js';
import { withRetry } from '../../resilience/retry-embedder.js';
import { VectorRag } from '../vector-rag.js';

const vector = async (): Promise<IEmbedResult> => ({ vector: [1] });

class DocumentHalf implements IDocumentEmbedder {
  declare readonly embedderRole: 'document';
  embed = vector;
}
class QueryHalf implements IQueryEmbedder {
  declare readonly embedderRole: 'query';
  embed = vector;
}
const plain: IEmbedder = { embed: vector };

const writes = (_e: IDocumentEmbedder) => undefined;
const searches = (_e: IQueryEmbedder) => undefined;

// A role-free embedder fits both slots.
writes(plain);
searches(plain);
// Each half fits its own slot only.
writes(new DocumentHalf());
searches(new QueryHalf());
// @ts-expect-error — a query half is not a document embedder
writes(new QueryHalf());
// @ts-expect-error — a document half is not a query embedder
searches(new DocumentHalf());

// Wrappers keep the role of what they wrap.
// @ts-expect-error — retry-wrapped query half stays a query half
writes(withRetry(new QueryHalf()));
// @ts-expect-error — composed document half stays a document half
searches(composeResilientEmbedder(new DocumentHalf()));
// @ts-expect-error — breaker-wrapped query half stays a query half
writes(withCircuitBreaker(new QueryHalf(), new CircuitBreaker()));
searches(withRetry(new QueryHalf()));

// A store takes one symmetric embedder, or the asymmetric pair.
new VectorRag(plain);
new VectorRag(new DocumentHalf(), { queryEmbedder: new QueryHalf() });
// @ts-expect-error — a document half alone would embed search text as documents
new VectorRag(new DocumentHalf());
// @ts-expect-error — the halves swapped
new VectorRag(new QueryHalf(), { queryEmbedder: new DocumentHalf() });
