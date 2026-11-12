import type { RagCollectionOwner } from '../../interfaces/rag.js';
import type {
  RagAccess,
  RagAccessMode,
  RagCaller,
  RagCollectionRef,
} from '../../interfaces/rag-access.js';
import { RagAccessDeniedError } from '../../interfaces/rag-access.js';
import type { Result } from '../../interfaces/types.js';

function hasCallerIdentity(caller: RagCaller): boolean {
  return (
    typeof caller === 'object' &&
    caller !== null &&
    typeof caller.sessionId === 'string' &&
    caller.sessionId.trim().length > 0 &&
    typeof caller.userId === 'string' &&
    caller.userId.trim().length > 0
  );
}

export function visibleOwnerFilter(
  caller: RagCaller,
): (owner: RagCollectionOwner) => boolean {
  return (owner) => {
    if (!hasCallerIdentity(caller)) return false;
    switch (owner.scope) {
      case 'session':
        return owner.sessionId === caller.sessionId;
      case 'user':
        return owner.userId === caller.userId;
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
    if (!hasCallerIdentity(caller)) return deny();
    const binding = await access.bindings.getUserId(caller.sessionId);
    if (!binding.ok || binding.value !== caller.userId) return deny();
    const memberships = await access.roles.rolesOf(caller.userId);
    const bound = await access.roles.collectionRoles(ref.name);
    if (!memberships.ok || !bound.ok) return deny();
    const shared = [...memberships.value].some((role) => bound.value.has(role));
    if (!visibleOwnerFilter(caller)(ref.owner) && !shared) return deny();
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
