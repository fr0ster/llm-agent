import type { RagCollectionOwner } from '../../interfaces/rag.js';
import type {
  RagAccess,
  RagAccessMode,
  RagCaller,
  RagCollectionRef,
} from '../../interfaces/rag-access.js';
import { RagAccessDeniedError } from '../../interfaces/rag-access.js';
import type { Result } from '../../interfaces/types.js';

export function visibleOwnerFilter(
  caller: RagCaller,
  roles: ReadonlySet<string>,
): (owner: RagCollectionOwner) => boolean {
  return (owner) => {
    switch (owner.scope) {
      case 'session':
        return owner.sessionId === caller.sessionId;
      case 'user':
        return owner.userId === caller.userId;
      case 'role':
        return roles.has(owner.roleId);
      case 'global':
        return true;
    }
  };
}

export async function checkRagAccess(
  caller: RagCaller,
  ref: RagCollectionRef,
  mode: RagAccessMode,
  access: RagAccess,
): Promise<Result<void, RagAccessDeniedError>> {
  const deny = (): Result<void, RagAccessDeniedError> => ({
    ok: false,
    error: new RagAccessDeniedError(),
  });
  try {
    let roles: ReadonlySet<string> = new Set();
    if (ref.owner.scope === 'role') {
      const result = await access.roles.rolesOf(caller.userId);
      if (!result.ok) return deny();
      roles = result.value;
    }
    if (!visibleOwnerFilter(caller, roles)(ref.owner)) return deny();
    if (ref.owner.scope === 'global' && mode === 'write' && !caller.isAdmin)
      return deny();
    const allowed =
      mode === 'read'
        ? await access.decision.canRead(caller, ref)
        : await access.decision.canWrite(caller, ref);
    return allowed === true ? { ok: true, value: undefined } : deny();
  } catch {
    return deny();
  }
}
