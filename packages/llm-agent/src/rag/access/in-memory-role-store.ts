import {
  type IRagRoleStore,
  type RagRole,
  RoleInUseError,
} from '../../interfaces/rag-access.js';
import { RagError, type Result } from '../../interfaces/types.js';

export class InMemoryRagRoleStore implements IRagRoleStore {
  private readonly roles = new Map<string, RagRole>();
  private readonly assignments = new Map<string, Set<string>>();

  constructor(private readonly isRoleInUse: (roleId: string) => boolean) {}

  /** Synchronous guard for catalog writes in this process; no await may split check and write. */
  hasRole(roleId: string): boolean {
    return this.roles.has(roleId);
  }

  async listRoles(): Promise<Result<readonly RagRole[], RagError>> {
    return {
      ok: true,
      value: [...this.roles.values()].map((role) => ({ ...role })),
    };
  }

  async createRole(role: RagRole): Promise<Result<RagRole, RagError>> {
    if (this.roles.has(role.roleId))
      return {
        ok: false,
        error: new RagError('Role already exists', 'RAG_ROLE_EXISTS'),
      };
    this.roles.set(role.roleId, { ...role });
    return { ok: true, value: { ...role } };
  }

  async deleteRole(roleId: string): Promise<Result<void, RagError>> {
    try {
      if (this.isRoleInUse(roleId))
        return { ok: false, error: new RoleInUseError() };
    } catch {
      return {
        ok: false,
        error: new RagError(
          'Unable to check role ownership',
          'RAG_ROLE_STORE_ERROR',
        ),
      };
    }
    this.roles.delete(roleId);
    for (const roles of this.assignments.values()) roles.delete(roleId);
    return { ok: true, value: undefined };
  }

  async assign(
    userId: string,
    roleId: string,
  ): Promise<Result<void, RagError>> {
    if (!this.roles.has(roleId))
      return {
        ok: false,
        error: new RagError('Role does not exist', 'RAG_ROLE_NOT_FOUND'),
      };
    let roles = this.assignments.get(userId);
    if (!roles) {
      roles = new Set();
      this.assignments.set(userId, roles);
    }
    roles.add(roleId);
    return { ok: true, value: undefined };
  }

  async revoke(
    userId: string,
    roleId: string,
  ): Promise<Result<void, RagError>> {
    this.assignments.get(userId)?.delete(roleId);
    return { ok: true, value: undefined };
  }

  async rolesOf(
    userId: string,
  ): Promise<Result<ReadonlySet<string>, RagError>> {
    return { ok: true, value: new Set(this.assignments.get(userId)) };
  }
}
