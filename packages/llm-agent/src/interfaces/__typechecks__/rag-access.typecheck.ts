import type {
  IRagAccessDecision,
  IRagCallerResolver,
  IRagRoleStore,
  ISessionBindingStore,
  RagAccess,
  RagAccessMode,
  RagCaller,
  RagCollectionRef,
  RagRole,
} from '../../index.js';
import type { RagCollectionOwner } from '../rag.js';

export const roleOwner: RagCollectionOwner = { scope: 'role', roleId: 'r1' };
// @ts-expect-error Role ownership requires roleId.
export const missingRoleId: RagCollectionOwner = { scope: 'role' };
// @ts-expect-error A user key cannot identify a role owner.
export const wrongRoleKey: RagCollectionOwner = { scope: 'role', userId: 'u' };

export const caller: RagCaller = {
  sessionId: 's',
  userId: 'u',
  isAdmin: false,
};
export const ref: RagCollectionRef = { name: 'docs', owner: roleOwner };
export const mode: RagAccessMode = 'read';
export const role: RagRole = { roleId: 'r1', name: 'Team' };
export const decision: IRagAccessDecision = {
  async canRead() {
    return false;
  },
  async canWrite() {
    return false;
  },
};
export const roles: IRagRoleStore = {
  async listRoles() {
    return { ok: true, value: [role] };
  },
  async createRole(value) {
    return { ok: true, value };
  },
  async deleteRole() {
    return { ok: true, value: undefined };
  },
  async assign() {
    return { ok: true, value: undefined };
  },
  async revoke() {
    return { ok: true, value: undefined };
  },
  async rolesOf() {
    return { ok: true, value: new Set<string>() };
  },
};
export const bindings: ISessionBindingStore = {
  async bind() {
    return { ok: true, value: undefined };
  },
};
export const resolver: IRagCallerResolver = {
  async resolve() {
    return { ok: true, value: { userId: 'u', isAdmin: false } };
  },
};
export const access: RagAccess = { decision, roles, bindings };

export function incompleteOwnerSwitch(owner: RagCollectionOwner): string {
  switch (owner.scope) {
    case 'global':
      return '';
    case 'session':
      return owner.sessionId;
    case 'user':
      return owner.userId;
    default: {
      // @ts-expect-error A switch without role is not exhaustive.
      const exhaustive: never = owner;
      return exhaustive;
    }
  }
}
