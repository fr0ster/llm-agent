import {
  type CallOptions,
  checkRagAccess,
  type IQueryEmbedding,
  type RagAccess,
  RagAccessDeniedError,
  type RagError,
  type RagResult,
  type Result,
  type SmartAgentRagStores,
} from '@mcp-abap-adt/llm-agent';

export type OwnedRagStore = SmartAgentRagStores[string];

/** Missing configuration must never grant collection access. */
export const denyRagAccess: RagAccess = {
  decision: { canRead: async () => false, canWrite: async () => false },
  roles: {
    listRoles: async () => ({ ok: false, error: new RagAccessDeniedError() }),
    createRole: async () => ({ ok: false, error: new RagAccessDeniedError() }),
    deleteRole: async () => ({ ok: false, error: new RagAccessDeniedError() }),
    assign: async () => ({ ok: false, error: new RagAccessDeniedError() }),
    revoke: async () => ({ ok: false, error: new RagAccessDeniedError() }),
    rolesOf: async () => ({ ok: false, error: new RagAccessDeniedError() }),
  },
  bindings: {
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
  const filter = options.ragFilter;
  if (filter?.sessionId !== undefined && filter.sessionId !== caller.sessionId)
    return deny();
  if (filter?.userId !== undefined && filter.userId !== caller.userId)
    return deny();
  if (filter?.roleId !== undefined) {
    if (typeof filter.roleId !== 'string') return deny();
    try {
      const roles = await access.roles.rolesOf(caller.userId);
      if (!roles.ok || !roles.value.has(filter.roleId)) return deny();
    } catch {
      return deny();
    }
  }
  const perRequest =
    store.owner.scope === 'session' && 'perRequest' in store.owner;
  const owner =
    store.owner.scope === 'session' && 'perRequest' in store.owner
      ? { scope: 'session' as const, sessionId: caller.sessionId }
      : store.owner;
  if (!perRequest && owner.scope !== 'internal') {
    const allowed = await checkRagAccess(
      caller,
      { name: store.name, owner },
      'read',
      access,
    );
    if (!allowed.ok) return allowed;
  }
  const ownerFilter =
    owner.scope === 'session'
      ? { sessionId: owner.sessionId }
      : owner.scope === 'user'
        ? { userId: owner.userId }
        : owner.scope === 'role'
          ? { roleId: owner.roleId }
          : owner.scope === 'global'
            ? { owner: { scope: 'global' as const } }
            : {};
  const result = await store.rag.query(embedding, k, {
    ...options,
    ragFilter: { ...filter, ...ownerFilter },
  });
  if (!result.ok) return result;
  // Keep untagged or foreign records closed even before every backend implements
  // the mandatory owner filter before top-k (Task 7).
  return {
    ok: true,
    value: result.value.filter((record) => {
      switch (owner.scope) {
        case 'session':
          return record.metadata.sessionId === owner.sessionId;
        case 'user':
          return record.metadata.userId === owner.userId;
        case 'role':
          return record.metadata.roleId === owner.roleId;
        case 'global':
          return (
            !('sessionId' in record.metadata) &&
            !('userId' in record.metadata) &&
            !('roleId' in record.metadata)
          );
        case 'internal':
          return true;
        default:
          return false;
      }
    }),
  };
}
