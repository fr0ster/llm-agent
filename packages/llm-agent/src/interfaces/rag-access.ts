import type { RagCollectionOwner } from './rag.js';
import { RagError, type Result } from './types.js';

export interface RagCaller {
  readonly sessionId: string;
  readonly userId: string;
  readonly isAdmin: boolean;
}

export interface RagCollectionRef {
  readonly name: string;
  readonly owner: RagCollectionOwner;
}

export type RagAccessMode = 'read' | 'write';

export interface IRagAccessDecision {
  canRead(caller: RagCaller, ref: RagCollectionRef): Promise<boolean>;
  canWrite(caller: RagCaller, ref: RagCollectionRef): Promise<boolean>;
}

export interface RagRole {
  readonly roleId: string;
  readonly name: string;
  readonly description?: string;
}

export interface IRagRoleCheck {
  rolesOf(userId: string): Promise<Result<ReadonlySet<string>, RagError>>;
  collectionRoles(
    collectionName: string,
  ): Promise<Result<ReadonlySet<string>, RagError>>;
}

export interface IRagRoleAdmin {
  listRoles(): Promise<Result<readonly RagRole[], RagError>>;
  createRole(role: RagRole): Promise<Result<RagRole, RagError>>;
  deleteRole(roleId: string): Promise<Result<void, RagError>>;
  assign(userId: string, roleId: string): Promise<Result<void, RagError>>;
  revoke(userId: string, roleId: string): Promise<Result<void, RagError>>;
  bindCollection(
    collectionName: string,
    roleId: string,
  ): Promise<Result<void, RagError>>;
  unbindCollection(
    collectionName: string,
    roleId: string,
  ): Promise<Result<void, RagError>>;
}

export interface ISessionBindingStore {
  /** Read only: never creates a binding during access checks. */
  getUserId(sessionId: string): Promise<Result<string | undefined, RagError>>;
  /** Idempotent for the same pair; refuses rebinding to a different user. */
  bind(
    sessionId: string,
    userId: string,
  ): Promise<Result<void, SessionBindingConflictError | RagError>>;
}

export interface IRagCallerResolver {
  resolve(
    sessionId: string,
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  ): Promise<Result<Omit<RagCaller, 'sessionId'>, RagAccessDeniedError>>;
}

export interface RagAccess {
  readonly decision: IRagAccessDecision;
  readonly roles: IRagRoleCheck;
  readonly bindings: ISessionBindingStore;
}

export class RagAccessDeniedError extends RagError {
  constructor(message = 'RAG access denied') {
    super(message, 'RAG_ACCESS_DENIED');
    this.name = 'RagAccessDeniedError';
  }
}

export class SessionBindingConflictError extends RagError {
  constructor(message = 'Session is already bound to a different user') {
    super(message, 'RAG_SESSION_BINDING_CONFLICT');
    this.name = 'SessionBindingConflictError';
  }
}

export class RoleInUseError extends RagError {
  constructor(message = 'Role is assigned to a user or bound to a collection') {
    super(message, 'RAG_ROLE_IN_USE');
    this.name = 'RoleInUseError';
  }
}
