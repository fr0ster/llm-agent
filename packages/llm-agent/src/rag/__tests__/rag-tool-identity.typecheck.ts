// Compile-time assertions only; under __tests__ so the package build neither compiles nor ships it.
import type { IRagRegistry } from '../../interfaces/rag.js';
import {
  buildRagCollectionToolEntries,
  type RagCallerIdentity,
} from '../mcp-tools/rag-collection-tools.js';

declare const registry: IRagRegistry;

// @ts-expect-error — identity is required: an unnarrowed address space must not be reachable by omission
buildRagCollectionToolEntries({ registry });

const identity: RagCallerIdentity = { sessionId: 's' };
buildRagCollectionToolEntries({ registry, identity });

// llm-agent-libs' SessionGraphIdentity is the same shape and passes straight in
const fromLibs: { readonly sessionId: string; readonly userId?: string } = {
  sessionId: 's',
  userId: 'u',
};
buildRagCollectionToolEntries({ registry, identity: fromLibs });

// the consumer's attributes callback receives the owner union
buildRagCollectionToolEntries({
  registry,
  identity,
  attributesFor: (created) =>
    created.scope === 'user' ? { owner: created.userId } : undefined,
});
