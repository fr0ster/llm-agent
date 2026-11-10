import {
  type IRagRoleStore,
  type ISessionBindingStore,
  RagError,
  type Result,
  RoleInUseError,
  SessionBindingConflictError,
} from '@mcp-abap-adt/llm-agent';
import { QdrantAccessRefusal } from './access-persistence.js';
import type { QdrantRagProvider } from './qdrant-rag-provider.js';

export function createQdrantRagAccessStores(provider: QdrantRagProvider): {
  roles: IRagRoleStore;
  bindings: ISessionBindingStore;
} {
  async function run<T>(work: () => Promise<T>): Promise<Result<T, RagError>> {
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof RagError
            ? error
            : new RagError(String(error), 'RAG_ACCESS_STORE_ERROR'),
      };
    }
  }
  const roles: IRagRoleStore = {
    listRoles: () =>
      run(async () => {
        const db = await provider.accessPersistence();
        return (await db.rows('rag_roles'))
          .filter((row) => row.tombstone !== 'true')
          .map((row) => {
            if (
              typeof row.role_id !== 'string' ||
              typeof row.name !== 'string' ||
              (row.description != null && typeof row.description !== 'string')
            )
              throw new RagError(
                'Invalid persisted role',
                'RAG_ACCESS_STORE_ERROR',
              );
            return {
              roleId: row.role_id,
              name: row.name,
              ...(row.description == null
                ? {}
                : { description: row.description }),
            };
          })
          .sort((a, b) => a.roleId.localeCompare(b.roleId));
      }),
    createRole: (role) =>
      run(async () => {
        const db = await provider.accessPersistence();

        if (await db.read('rag_roles', role.roleId))
          throw new QdrantAccessRefusal('Role already exists');
        const token = crypto.randomUUID();
        await db.insert('rag_roles', role.roleId, {
          role_id: role.roleId,
          name: role.name,
          description: role.description,
          token,
        });
        if ((await db.read('rag_roles', role.roleId))?.token !== token)
          throw new RagError('Role already exists', 'RAG_ACCESS_STORE_ERROR');
        return role;
      }),
    deleteRole: (roleId) =>
      run(async () => {
        const db = await provider.accessPersistence();
        const role = await db.read('rag_roles', roleId);
        if (!role) return;
        await db.patch('rag_roles', roleId, { tombstone: 'true' });
        if (
          (await db.rows(db.catalog)).some(
            (row) => row.scope === 'role' && row.role_id === roleId,
          )
        ) {
          await db.patch('rag_roles', roleId, { tombstone: null });
          throw new RoleInUseError();
        }
        for (const row of await db.rows('rag_role_assignments')) {
          if (row.role_id === roleId) {
            if (typeof row.user_id !== 'string')
              throw new RagError(
                'Invalid persisted assignment',
                'RAG_ACCESS_STORE_ERROR',
              );
            await db.remove(
              'rag_role_assignments',
              JSON.stringify([row.user_id, roleId]),
            );
          }
        }
        await db.remove('rag_roles', roleId);
      }),
    assign: (userId, roleId) =>
      run(async () => {
        const db = await provider.accessPersistence();
        const role = await db.requireRole(roleId);
        const token = role.token;
        if (typeof token !== 'string')
          throw new QdrantAccessRefusal('Invalid role identity');
        const key = JSON.stringify([userId, roleId]);
        await db.insert('rag_role_assignments', key, {
          user_id: userId,
          role_id: roleId,
          role_token: token,
        });
        try {
          const current = await db.requireRole(roleId);
          const stored = await db.read('rag_role_assignments', key);
          if (current.token !== token || stored?.role_token !== token)
            throw new QdrantAccessRefusal(
              'Role identity changed during assignment',
            );
        } catch (error) {
          await db.removeWhere('rag_role_assignments', {
            user_id: userId,
            role_id: roleId,
            role_token: token,
          });
          throw error;
        }
      }),
    revoke: (userId, roleId) =>
      run(async () => {
        const db = await provider.accessPersistence();
        await db.remove(
          'rag_role_assignments',
          JSON.stringify([userId, roleId]),
        );
      }),
    rolesOf: (userId) =>
      run(async () => {
        const db = await provider.accessPersistence();
        const result = new Set<string>();
        for (const row of await db.rows('rag_role_assignments')) {
          if (row.user_id !== userId) continue;
          if (typeof row.role_id !== 'string')
            throw new RagError(
              'Invalid persisted assignment',
              'RAG_ACCESS_STORE_ERROR',
            );
          // A partial failed deletion must never grant membership in a missing role.
          const role = await db.read('rag_roles', row.role_id);
          if (
            role?.role_id === row.role_id &&
            role.tombstone !== 'true' &&
            typeof role.token === 'string' &&
            role.token === row.role_token
          )
            result.add(row.role_id);
        }
        return result;
      }),
  };
  const bindings: ISessionBindingStore = {
    bind: (sessionId, userId) =>
      run(async () => {
        const db = await provider.accessPersistence();
        await db.insert('rag_session_bindings', sessionId, {
          session_id: sessionId,
          user_id: userId,
        });
        const stored = await db.read('rag_session_bindings', sessionId);
        if (stored?.session_id !== sessionId || stored.user_id !== userId)
          throw new SessionBindingConflictError();
      }),
  };
  return { roles, bindings };
}
