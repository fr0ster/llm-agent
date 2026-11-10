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
        const ids = new Set(
          (await db.rows('rag_roles')).map((row) => row.role_id),
        );
        const current = await Promise.all(
          [...ids].map(async (id) => {
            if (typeof id !== 'string')
              throw new QdrantAccessRefusal('Invalid role id');
            return db.roleState(id);
          }),
        );
        return current
          .filter(
            (row): row is NonNullable<typeof row> => row?.state === 'active',
          )
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

        const current = await db.roleState(role.roleId);
        const token = crypto.randomUUID();
        const payload = {
          role_id: role.roleId,
          name: role.name,
          description: role.description,
          token,
          state: 'active',
          revision: '0',
        };
        if (current) {
          if (
            current.state !== 'deleted' ||
            !(await db.transitionRole(current, 'active', payload))
          )
            throw new QdrantAccessRefusal('Role already exists');
        } else {
          await db.insert('rag_roles', role.roleId, payload);
          if ((await db.roleState(role.roleId))?.token !== token)
            throw new QdrantAccessRefusal('Role already exists');
        }
        return role;
      }),
    deleteRole: (roleId) =>
      run(async () => {
        const db = await provider.accessPersistence();
        const role = await db.roleState(roleId);
        if (!role || role.state === 'deleted') return;
        let held = await db.transitionRole(role, 'deleting', {
          deletion_token: crypto.randomUUID(),
        });
        if (!held) throw new QdrantAccessRefusal('Role deletion fenced');
        const inUse = (await db.rows(db.catalog)).some(
          (row) => row.scope === 'role' && row.role_id === roleId,
        );
        const checked = await db.transitionRole(
          held,
          inUse ? 'active' : 'deleting',
        );
        if (!checked) throw new QdrantAccessRefusal('Role deletion fenced');
        held = checked;
        if (inUse) throw new RoleInUseError();
        const assignments = await db.rows('rag_role_assignments');
        const scanned = await db.transitionRole(held, 'deleting');
        if (!scanned) throw new QdrantAccessRefusal('Role deletion fenced');
        held = scanned;
        for (const row of assignments) {
          if (row.role_id !== roleId) continue;
          if (typeof row.user_id !== 'string')
            throw new QdrantAccessRefusal('Invalid persisted assignment');
          // A stale deletion can only reduce permissions; its next CAS prevents role removal.
          await db.remove(
            'rag_role_assignments',
            JSON.stringify([row.user_id, roleId]),
          );
          const removed = await db.transitionRole(held, 'deleting');
          if (!removed) throw new QdrantAccessRefusal('Role deletion fenced');
          held = removed;
        }
        if (!(await db.transitionRole(held, 'deleted')))
          throw new QdrantAccessRefusal('Role deletion fenced');
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
          const role = await db.roleState(row.role_id);
          if (
            role?.role_id === row.role_id &&
            role.state === 'active' &&
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
