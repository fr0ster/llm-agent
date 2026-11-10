import type {
  IRagAccessDecision,
  IRagCallerResolver,
  RagAccess,
  RagCaller,
} from '../interfaces/rag-access.js';
import { InMemoryRagRoleStore } from '../rag/access/in-memory-role-store.js';
import { InMemorySessionBindingStore } from '../rag/access/in-memory-session-binding-store.js';

export function allowAllDecision(): IRagAccessDecision {
  return { canRead: async () => true, canWrite: async () => true };
}

export function fixedCallerResolver(
  caller: Omit<RagCaller, 'sessionId'>,
): IRagCallerResolver {
  const identity = { ...caller };
  return { resolve: async () => ({ ok: true, value: { ...identity } }) };
}

export function testRagAccess(callers: readonly RagCaller[] = []): RagAccess {
  return {
    decision: allowAllDecision(),
    roles: new InMemoryRagRoleStore(() => false),
    bindings: new InMemorySessionBindingStore(callers),
  };
}
