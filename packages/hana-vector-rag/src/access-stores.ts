import {
  type IRagRoleStore,
  type ISessionBindingStore,
  RagError,
  type Result,
  RoleInUseError,
  SessionBindingConflictError,
} from '@mcp-abap-adt/llm-agent';
import type { HanaVectorRagProvider } from './hana-vector-rag-provider.js';
import { roleTransaction } from './role-transaction.js';
import { quoteIdent } from './schema.js';

export function createHanaVectorRagAccessStores(
  provider: HanaVectorRagProvider,
): { roles: IRagRoleStore; bindings: ISessionBindingStore } {
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
        const { client } = await provider.accessPersistence();
        const rows = await client.query(
          'SELECT role_id AS "roleId", name AS "name", description AS "description" FROM "rag_roles" ORDER BY role_id',
        );
        return rows.map((row) => {
          if (
            typeof row.roleId !== 'string' ||
            typeof row.name !== 'string' ||
            (row.description !== null && typeof row.description !== 'string')
          )
            throw new RagError(
              'Invalid persisted role',
              'RAG_ACCESS_STORE_ERROR',
            );
          return {
            roleId: row.roleId,
            name: row.name,
            ...(typeof row.description === 'string'
              ? { description: row.description }
              : {}),
          };
        });
      }),
    createRole: (role) =>
      run(async () => {
        const { client } = await provider.accessPersistence();
        await client.exec(
          'INSERT INTO "rag_roles" (role_id, name, description) VALUES (?, ?, ?)',
          [role.roleId, role.name, role.description ?? null],
        );
        return role;
      }),
    deleteRole: (roleId) =>
      run(async () => {
        const { client, catalogTable } = await provider.accessPersistence();
        await roleTransaction(client, async (connection) => {
          await connection.query(
            'SELECT role_id FROM "rag_roles" WHERE role_id = ? FOR UPDATE',
            [roleId],
          );
          const rows = await connection.query(
            `SELECT 1 FROM ${quoteIdent(catalogTable)} WHERE scope = 'role' AND role_id = ?`,
            [roleId],
          );
          if (rows.length) throw new RoleInUseError();
          await connection.exec(
            'DELETE FROM "rag_role_assignments" WHERE role_id = ?',
            [roleId],
          );
          await connection.exec('DELETE FROM "rag_roles" WHERE role_id = ?', [
            roleId,
          ]);
        });
      }),
    assign: (userId, roleId) =>
      run(async () => {
        const { client } = await provider.accessPersistence();
        await roleTransaction(client, async (connection) => {
          const roles = await connection.query(
            'SELECT role_id FROM "rag_roles" WHERE role_id = ? FOR UPDATE',
            [roleId],
          );
          if (!roles.length)
            throw new RagError('Role does not exist', 'RAG_ROLE_NOT_FOUND');
          const rows = await connection.query(
            'SELECT role_id FROM "rag_role_assignments" WHERE user_id = ? AND role_id = ?',
            [userId, roleId],
          );
          if (!rows.length)
            await connection.exec(
              'INSERT INTO "rag_role_assignments" (user_id, role_id) VALUES (?, ?)',
              [userId, roleId],
            );
        });
      }),
    revoke: (userId, roleId) =>
      run(async () => {
        const { client } = await provider.accessPersistence();
        await client.exec(
          'DELETE FROM "rag_role_assignments" WHERE user_id = ? AND role_id = ?',
          [userId, roleId],
        );
      }),
    rolesOf: (userId) =>
      run(async () => {
        const { client } = await provider.accessPersistence();
        const rows = await client.query(
          'SELECT role_id AS "roleId" FROM "rag_role_assignments" WHERE user_id = ? ORDER BY role_id',
          [userId],
        );
        return new Set(
          rows.map((row) => {
            if (typeof row.roleId !== 'string')
              throw new RagError(
                'Invalid persisted assignment',
                'RAG_ACCESS_STORE_ERROR',
              );
            return row.roleId;
          }),
        );
      }),
  };
  const bindings: ISessionBindingStore = {
    bind: (sessionId, userId) =>
      run(async () => {
        const { client } = await provider.accessPersistence();
        await roleTransaction(client, async (connection) => {
          // A duplicate insert waits on the primary key even when the row did not exist at transaction start.
          try {
            await connection.exec(
              'INSERT INTO "rag_session_bindings" (session_id, user_id) VALUES (?, ?)',
              [sessionId, userId],
            );
          } catch (error) {
            const rows = await connection.query(
              'SELECT user_id AS "userId" FROM "rag_session_bindings" WHERE session_id = ? FOR UPDATE',
              [sessionId],
            );
            if (!rows.length) throw error;
            if (rows[0].userId !== userId)
              throw new SessionBindingConflictError();
          }
        });
      }),
  };
  return { roles, bindings };
}
