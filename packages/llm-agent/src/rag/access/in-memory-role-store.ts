import {
  type IRagRoleAdmin,
  type IRagRoleCheck,
  type RagRole,
  RoleInUseError,
} from '../../interfaces/rag-access.js';
import { RagError, type Result } from '../../interfaces/types.js';

export class InMemoryRagRoleStore implements IRagRoleCheck, IRagRoleAdmin {
  private readonly roles = new Map<string, RagRole>();
  private readonly assignments = new Map<string, Set<string>>();

  private readonly collectionBindings = new Map<string, Set<string>>();

  constructor(
    private readonly collectionExists: (collectionName: string) => boolean,
  ) {}

  async collectionRoles(
    collectionName: string,
  ): Promise<Result<ReadonlySet<string>, RagError>> {
    return {
      ok: true,
      value: new Set(this.collectionBindings.get(collectionName)),
    };
  }

  async bindCollection(
    collectionName: string,
    roleId: string,
  ): Promise<Result<void, RagError>> {
    if (!this.roles.has(roleId) || !this.collectionExists(collectionName))
      return {
        ok: false,
        error: new RagError(
          'Role or collection does not exist',
          'RAG_BINDING_NOT_FOUND',
        ),
      };
    const bound =
      this.collectionBindings.get(collectionName) ?? new Set<string>();
    bound.add(roleId);
    this.collectionBindings.set(collectionName, bound);
    return { ok: true, value: undefined };
  }

  async unbindCollection(
    collectionName: string,
    roleId: string,
  ): Promise<Result<void, RagError>> {
    this.collectionBindings.get(collectionName)?.delete(roleId);
    return { ok: true, value: undefined };
  }

  removeCollection(collectionName: string): void {
    this.collectionBindings.delete(collectionName);
  }

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
      if (
        [
          ...this.assignments.values(),
          ...this.collectionBindings.values(),
        ].some((roles) => roles.has(roleId))
      )
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
