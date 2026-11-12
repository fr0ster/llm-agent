import {
  type IRagRoleAdmin,
  type IRagRoleCheck,
  type ISessionBindingStore,
  RagError,
  type Result,
  RoleInUseError,
  SessionBindingConflictError,
} from '@mcp-abap-adt/llm-agent';
import { QdrantAccessRefusal } from './access-persistence.js';
import type { QdrantRagProvider } from './qdrant-rag-provider.js';

export function createQdrantVectorRagAccessStores(
  provider: QdrantRagProvider,
): {
  roles: IRagRoleCheck;
  roleAdmin: IRagRoleAdmin;
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
  const roles: IRagRoleCheck & IRagRoleAdmin = {
    collectionRoles: (collectionName) =>
      run(async () => {
        const db = await provider.accessPersistence();
        const result = new Set<string>();
        const catalogs = await db.rows(db.catalog);
        for (const row of await db.rows('rag_collection_roles')) {
          if (row.collection_name !== collectionName) continue;
          // Only a complete deletion marker may bypass binding validation.
          if (
            typeof row.store_name === 'string' &&
            typeof row.write_id === 'string' &&
            row.deletion_intent ===
              JSON.stringify(['deleting', row.store_name, row.write_id]) &&
            row.role_id === undefined &&
            row.role_token === undefined &&
            row.catalog_write_id === undefined
          )
            continue;
          if (typeof row.role_id !== 'string')
            throw new QdrantAccessRefusal('Invalid collection role');
          const role = await db.roleState(row.role_id);
          const collection = catalogs.find(
            (catalog) =>
              catalog.collection_name === collectionName &&
              catalog.write_id === row.catalog_write_id &&
              ['session', 'user', 'global'].includes(catalog.scope ?? ''),
          );
          if (
            role?.state === 'active' &&
            role.token === row.role_token &&
            collection &&
            typeof collection.store_name === 'string' &&
            typeof collection.write_id === 'string' &&
            !(await db.collectionDeleting(
              collection.store_name,
              collection.write_id,
            ))
          )
            result.add(row.role_id);
        }
        return result;
      }),
    bindCollection: (collectionName, roleId) =>
      run(async () => {
        const db = await provider.accessPersistence();
        const role = await db.requireRole(roleId);
        const collection = (await db.rows(db.catalog)).find(
          (row) =>
            row.collection_name === collectionName &&
            ['session', 'user', 'global'].includes(row.scope ?? ''),
        );
        if (!collection)
          throw new QdrantAccessRefusal('Collection does not exist');
        if (
          typeof role.token !== 'string' ||
          typeof collection.write_id !== 'string'
        )
          throw new QdrantAccessRefusal('Invalid role or catalog identity');
        if (
          typeof collection.store_name !== 'string' ||
          (await db.collectionDeleting(
            collection.store_name,
            collection.write_id,
          ))
        )
          throw new QdrantAccessRefusal('Collection is being deleted');
        const key = JSON.stringify([collectionName, roleId]);
        const payload = {
          collection_name: collectionName,
          role_id: roleId,
          role_token: role.token,
          catalog_write_id: collection.write_id,
        };
        try {
          await db.insert('rag_collection_roles', key, payload);
          const current = await db.requireRole(roleId);
          const stored = await db.read('rag_collection_roles', key);
          const catalog = await db.read(
            db.catalog,
            collection.store_name ?? '',
          );
          if (
            current.token !== role.token ||
            stored?.role_token !== role.token ||
            stored.catalog_write_id !== collection.write_id ||
            catalog?.write_id !== collection.write_id ||
            (await db.collectionDeleting(
              collection.store_name,
              collection.write_id,
            ))
          )
            throw new QdrantAccessRefusal(
              'Role or collection changed during binding',
            );
        } catch (error) {
          await db.removeWhere('rag_collection_roles', payload);
          throw error;
        }
      }),
    unbindCollection: (collectionName, roleId) =>
      run(async () => {
        const db = await provider.accessPersistence();
        await db.remove(
          'rag_collection_roles',
          JSON.stringify([collectionName, roleId]),
        );
      }),
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
        const inUse = [
          ...(await db.rows('rag_role_assignments')),
          ...(await db.rows('rag_collection_roles')),
        ].some((row) => row.role_id === roleId);
        const checked = await db.transitionRole(
          held,
          inUse ? 'active' : 'deleting',
        );
        if (!checked) throw new QdrantAccessRefusal('Role deletion fenced');
        held = checked;
        if (inUse) throw new RoleInUseError();
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
    getUserId: (sessionId) =>
      run(async () => {
        const db = await provider.accessPersistence();
        const stored = await db.read('rag_session_bindings', sessionId);
        if (!stored) return undefined;
        if (
          stored.session_id !== sessionId ||
          typeof stored.user_id !== 'string'
        )
          throw new RagError(
            'Invalid persisted binding',
            'RAG_ACCESS_STORE_ERROR',
          );
        return stored.user_id;
      }),
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
  return {
    roles: { rolesOf: roles.rolesOf, collectionRoles: roles.collectionRoles },
    roleAdmin: roles,
    bindings,
  };
}
