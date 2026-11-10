import {
  type IRagRoleStore,
  type ISessionBindingStore,
  RagError,
  type RagRole,
  type Result,
  RoleInUseError,
  SessionBindingConflictError,
} from '@mcp-abap-adt/llm-agent';
import type { PgVectorRagProvider } from './pg-vector-rag-provider.js';
import { roleTransaction } from './role-transaction.js';
import { qualifiedTable } from './schema.js';

export function createPgVectorRagAccessStores(provider: PgVectorRagProvider): {
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
        const { client, schema } = await provider.accessPersistence();
        const { rows } = await client.query(
          `SELECT role_id, name, description FROM ${qualifiedTable('rag_roles', schema)} ORDER BY role_id`,
        );
        return rows.map((row) => {
          if (
            typeof row.role_id !== 'string' ||
            typeof row.name !== 'string' ||
            (row.description !== null && typeof row.description !== 'string')
          )
            throw new RagError(
              'Invalid persisted role',
              'RAG_ACCESS_STORE_ERROR',
            );
          return {
            roleId: row.role_id,
            name: row.name,
            ...(typeof row.description === 'string'
              ? { description: row.description }
              : {}),
          };
        });
      }),
    createRole: (role: RagRole) =>
      run(async () => {
        const { client, schema } = await provider.accessPersistence();
        await client.query(
          `INSERT INTO ${qualifiedTable('rag_roles', schema)} (role_id, name, description) VALUES ($1, $2, $3)`,
          [role.roleId, role.name, role.description ?? null],
        );
        return role;
      }),
    deleteRole: (roleId) =>
      run(async () => {
        const { client, schema, catalogTable } =
          await provider.accessPersistence();
        await roleTransaction(client, async (connection) => {
          await connection.query(
            `SELECT 1 FROM ${qualifiedTable('rag_roles', schema)} WHERE role_id = $1 FOR UPDATE`,
            [roleId],
          );
          const { rows } = await connection.query(
            `SELECT 1 FROM ${qualifiedTable(catalogTable, schema)} WHERE scope = 'role' AND role_id = $1`,
            [roleId],
          );
          if (rows.length) throw new RoleInUseError();
          await connection.query(
            `DELETE FROM ${qualifiedTable('rag_roles', schema)} WHERE role_id = $1`,
            [roleId],
          );
        });
      }),
    assign: (userId, roleId) =>
      run(async () => {
        const { client, schema } = await provider.accessPersistence();
        await client.query(
          `INSERT INTO ${qualifiedTable('rag_role_assignments', schema)} (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [userId, roleId],
        );
      }),
    revoke: (userId, roleId) =>
      run(async () => {
        const { client, schema } = await provider.accessPersistence();
        await client.query(
          `DELETE FROM ${qualifiedTable('rag_role_assignments', schema)} WHERE user_id = $1 AND role_id = $2`,
          [userId, roleId],
        );
      }),
    rolesOf: (userId) =>
      run(async () => {
        const { client, schema } = await provider.accessPersistence();
        const { rows } = await client.query(
          `SELECT role_id FROM ${qualifiedTable('rag_role_assignments', schema)} WHERE user_id = $1 ORDER BY role_id`,
          [userId],
        );
        return new Set(
          rows.map((row) => {
            if (typeof row.role_id !== 'string')
              throw new RagError(
                'Invalid persisted assignment',
                'RAG_ACCESS_STORE_ERROR',
              );
            return row.role_id;
          }),
        );
      }),
  };
  const bindings: ISessionBindingStore = {
    getUserId: (sessionId) =>
      run(async () => {
        const { client, schema } = await provider.accessPersistence();
        const { rows } = await client.query(
          `SELECT user_id FROM ${qualifiedTable('rag_session_bindings', schema)} WHERE session_id = $1`,
          [sessionId],
        );
        const userId = rows[0]?.user_id;
        if (userId !== undefined && typeof userId !== 'string')
          throw new RagError(
            'Invalid persisted binding',
            'RAG_ACCESS_STORE_ERROR',
          );
        return userId;
      }),
    bind: (sessionId, userId) =>
      run(async () => {
        const { client, schema } = await provider.accessPersistence();
        const table = qualifiedTable('rag_session_bindings', schema);
        const { rowCount } = await client.query(
          `INSERT INTO ${table} AS binding (session_id, user_id) VALUES ($1, $2) ON CONFLICT (session_id) DO UPDATE SET user_id = binding.user_id WHERE binding.user_id = EXCLUDED.user_id RETURNING session_id`,
          [sessionId, userId],
        );
        if (!rowCount) throw new SessionBindingConflictError();
      }),
  };
  return { roles, bindings };
}
