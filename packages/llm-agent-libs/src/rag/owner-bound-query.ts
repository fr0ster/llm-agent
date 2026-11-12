import {
  type CallOptions,
  checkRagAccess,
  type IQueryEmbedding,
  matchesRagIdentity,
  type RagAccess,
  RagAccessDeniedError,
  type RagError,
  type RagResult,
  type Result,
  ragIdentityFilter,
  type SmartAgentRagStores,
} from '@mcp-abap-adt/llm-agent';

export type OwnedRagStore = SmartAgentRagStores[string];

/** Missing configuration must never grant collection access. */
export const denyRagAccess: RagAccess = {
  decision: { canRead: async () => false, canWrite: async () => false },
  roles: {
    collectionRoles: async () => ({
      ok: false,
      error: new RagAccessDeniedError(),
    }),
    rolesOf: async () => ({ ok: false, error: new RagAccessDeniedError() }),
  },
  bindings: {
    getUserId: async () => ({ ok: false, error: new RagAccessDeniedError() }),
    bind: async () => ({ ok: false, error: new RagAccessDeniedError() }),
  },
};

export async function ownerBoundQuery(
  store: OwnedRagStore,
  embedding: IQueryEmbedding,
  k: number,
  options: CallOptions,
  access: RagAccess,
): Promise<Result<RagResult[], RagError>> {
  const deny = (): Result<RagResult[], RagError> => ({
    ok: false,
    error: new RagAccessDeniedError(),
  });
  const caller = options.caller;
  if (!caller?.sessionId?.trim() || !caller.userId?.trim()) return deny();
  try {
    const binding = await access.bindings.getUserId(caller.sessionId);
    if (!binding.ok || binding.value !== caller.userId) return deny();
  } catch {
    return deny();
  }
  const filter = options.ragFilter;
  if (filter && 'roleId' in filter) return deny();
  if (filter?.owner !== undefined) return deny();
  if (filter?.sessionId !== undefined && filter.sessionId !== caller.sessionId)
    return deny();
  if (filter?.userId !== undefined && filter.userId !== caller.userId)
    return deny();
  const isHistory =
    store.owner.scope === 'session' && 'perRequest' in store.owner;
  const owner = isHistory
    ? { scope: 'session' as const, sessionId: caller.sessionId }
    : store.owner;
  // Built-in history keeps binding and session isolation, without a server decision.
  if (!isHistory && owner.scope !== 'internal') {
    const allowed = await checkRagAccess(
      caller,
      { name: store.name, owner },
      'read',
      access,
    );
    if (!allowed.ok) return allowed;
  }
  const ownerFilter =
    owner.scope === 'internal'
      ? {}
      : owner.scope === 'session'
        ? { owner, sessionId: owner.sessionId }
        : owner.scope === 'user'
          ? { owner, userId: owner.userId }
          : { owner };
  const result = await store.rag.query(embedding, k, {
    ...options,
    ragFilter: { ...filter, ...ownerFilter },
  });
  if (!result.ok) return result;
  // Keep untagged or foreign records closed if a custom backend returns them.
  return {
    ok: true,
    value: result.value.filter(
      (record) =>
        owner.scope === 'internal' ||
        matchesRagIdentity(
          record.metadata,
          ragIdentityFilter({ ragFilter: ownerFilter }),
        ),
    ),
  };
}
