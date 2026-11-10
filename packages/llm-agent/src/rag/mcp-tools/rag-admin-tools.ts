import { z } from 'zod';
import type {
  IRagProviderRegistry,
  IRagRegistry,
} from '../../interfaces/rag.js';
import type { RagAccess, RagCaller } from '../../interfaces/rag-access.js';
import { RoleInUseError } from '../../interfaces/rag-access.js';
import { checkRagAccess } from '../access/check-access.js';
import {
  buildRagCollectionToolEntries,
  type RagToolEntry,
} from './rag-collection-tools.js';

/** Role management is a global administrative operation; decisions receive the tool name. */
export function buildRagAdminToolEntries(opts: {
  caller: RagCaller;
  access: RagAccess;
  registry: IRagRegistry;
  providerRegistry: IRagProviderRegistry;
}): RagToolEntry[] {
  const { caller, access, registry } = opts;
  if (!caller.isAdmin) return [];
  const create = buildRagCollectionToolEntries(opts).find(
    (entry) => entry.toolDefinition.name === 'rag_create_collection',
  );
  const entry = (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    run: RagToolEntry['handler'],
  ): RagToolEntry => ({
    toolDefinition: { name, description, inputSchema },
    handler: async (context, args) => {
      const permission = await checkRagAccess(
        caller,
        { name, owner: { scope: 'global' } },
        name === 'rag_role_list' ? 'read' : 'write',
        access,
      );
      if (!caller.isAdmin || !permission.ok)
        return {
          ok: false,
          code: 'RAG_ACCESS_DENIED',
          error: 'RagAccessDeniedError: RAG access denied',
        };
      // Validate direct calls too: MCP schema validation is not the security boundary.
      const parsed = z.object(inputSchema).strict().safeParse(args);
      if (!parsed.success)
        return { ok: false, error: 'Invalid admin tool arguments' };
      try {
        return await run(context, args);
      } catch {
        return {
          ok: false,
          code: 'RAG_ADMIN_ERROR',
          error: 'RAG admin operation failed',
        };
      }
    },
  });
  const roleId = z.string().trim().min(1);
  return [
    entry('rag_role_list', 'List library RAG roles.', {}, async () => {
      const result = await access.roles.listRoles();
      return result.ok
        ? { ok: true, roles: result.value }
        : refusal(result.error);
    }),
    entry(
      'rag_role_create',
      'Create a library RAG role.',
      { roleId, name: z.string().min(1), description: z.string().optional() },
      async (_context, args) => {
        if (typeof args.roleId !== 'string' || typeof args.name !== 'string')
          return { ok: false, error: 'roleId and name are required' };
        const result = await access.roles.createRole({
          roleId: args.roleId,
          name: args.name,
          ...(typeof args.description === 'string'
            ? { description: args.description }
            : {}),
        });
        return result.ok
          ? { ok: true, role: result.value }
          : refusal(result.error);
      },
    ),
    entry(
      'rag_role_delete',
      'Delete a role only when it owns no collections.',
      { roleId },
      async (_context, args) => {
        if (typeof args.roleId !== 'string')
          return { ok: false, error: 'roleId is required' };
        const isRoleInUse = registry
          .list()
          .some((meta) => meta.scope === 'role' && meta.roleId === args.roleId);
        if (isRoleInUse) return refusal(new RoleInUseError());
        const result = await access.roles.deleteRole(args.roleId);
        return result.ok ? { ok: true } : refusal(result.error);
      },
    ),
    entry(
      'rag_role_assign',
      'Assign a library RAG role to a user.',
      { roleId, userId: z.string().min(1) },
      async (_context, args) => {
        if (typeof args.roleId !== 'string' || typeof args.userId !== 'string')
          return { ok: false, error: 'roleId and userId are required' };
        const result = await access.roles.assign(args.userId, args.roleId);
        return result.ok ? { ok: true } : refusal(result.error);
      },
    ),
    entry(
      'rag_role_revoke',
      'Revoke a library RAG role from a user.',
      { roleId, userId: z.string().min(1) },
      async (_context, args) => {
        if (typeof args.roleId !== 'string' || typeof args.userId !== 'string')
          return { ok: false, error: 'roleId and userId are required' };
        const result = await access.roles.revoke(args.userId, args.roleId);
        return result.ok ? { ok: true } : refusal(result.error);
      },
    ),
    entry(
      'rag_create_shared_collection',
      'Create an authorized role or global RAG collection.',
      {
        providerName: z.string().min(1),
        collectionName: z.string().min(1),
        scope: z.enum(['role', 'global']),
        roleId: roleId.optional(),
      },
      async (context, args) => {
        if (args.scope === 'role') {
          const roles = await access.roles.listRoles();
          if (!roles.ok) return refusal(roles.error);
          if (!roles.value.some((role) => role.roleId === args.roleId))
            return {
              ok: false,
              code: 'RAG_ROLE_NOT_FOUND',
              error: 'Role does not exist',
            };
        }
        if (!create)
          return { ok: false, error: 'Collection creation is unavailable' };
        return create.handler(context, {
          provider: args.providerName,
          name: args.collectionName,
          scope: args.scope,
          roleId: args.roleId,
        });
      },
    ),
  ];
}

function refusal(error: { name: string; code: string; message: string }) {
  return {
    ok: false,
    code: error.code,
    error: `${error.name}: ${error.message}`,
  };
}
