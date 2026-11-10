// Compile-time assertions: caller and access are mandatory.
import type { IRagRegistry } from '../../interfaces/rag.js';
import type { RagCaller } from '../../interfaces/rag-access.js';
import { testRagAccess } from '../../testing/rag-access-testing.js';
import { buildRagCollectionToolEntries } from '../mcp-tools/rag-collection-tools.js';

declare const registry: IRagRegistry;
const caller: RagCaller = { sessionId: 's', userId: 'u', isAdmin: false };
const access = testRagAccess();
// @ts-expect-error caller and access are required
buildRagCollectionToolEntries({ registry });
// @ts-expect-error access is required
buildRagCollectionToolEntries({ registry, caller });
// @ts-expect-error caller is required
buildRagCollectionToolEntries({ registry, access });
// @ts-expect-error an incomplete caller is refused
buildRagCollectionToolEntries({ registry, caller: { sessionId: 's' }, access });
// @ts-expect-error identity is no longer an option
buildRagCollectionToolEntries({ registry, identity: caller, access });
buildRagCollectionToolEntries({
  registry,
  caller,
  access,
  attributesFor: (created) =>
    created.scope === 'user' ? { owner: created.userId } : undefined,
});
