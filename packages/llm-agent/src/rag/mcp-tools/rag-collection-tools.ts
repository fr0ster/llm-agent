import { z } from 'zod';
import type {
  IRagEditor,
  IRagProviderRegistry,
  IRagRegistry,
  RagCollectionMeta,
  RagCollectionOwner,
  RagCollectionScope,
  RagJsonValue,
} from '../../interfaces/rag.js';
import type {
  RagAccess,
  RagAccessMode,
  RagCaller,
} from '../../interfaces/rag-access.js';
import { checkRagAccess, visibleOwnerFilter } from '../access/check-access.js';
import {
  AmbiguousCollectionError,
  CollectionDataDeleteError,
} from '../corrections/errors.js';
import {
  buildCorrectionMetadata,
  deprecateMetadata,
} from '../corrections/metadata.js';

/**
 * Free-form per-call context. It carries no identity: the entries were built
 * for one caller, and a per-call value that disagreed would act as somebody
 * else. Call sites passing sessionId/userId still compile — the index
 * signature takes them — and nothing reads them.
 */
export interface RagToolContext {
  [key: string]: RagJsonValue | undefined;
}

export interface RagToolEntry {
  toolDefinition: {
    name: string;
    description: string;
    inputSchema: z.ZodRawShape;
  };
  handler: (
    context: RagToolContext,
    args: Record<string, RagJsonValue | undefined>,
  ) => Promise<RagJsonValue | object>;
}

export interface RagCollectionToolOptions {
  registry: IRagRegistry;
  caller: RagCaller;
  access: RagAccess;
  /** When given, rag_create_collection is offered, creating through these providers. */
  providerRegistry?: IRagProviderRegistry;
  /**
   * What a collection this caller creates through the tool is recorded with.
   * Called by rag_create_collection with what the model asked for; its result
   * is stored unread. Absent → the collection has no attributes. The model's
   * own input never supplies them: it would be writing the policy that later
   * decides who reads the collection.
   */
  attributesFor?: (
    created: { name: string } & RagCollectionOwner,
  ) => RagJsonValue | undefined;
}

type Refusal = { ok: false; error: string; code?: string };

const scopeArg = z
  .enum(['session', 'user', 'role', 'global'])
  .optional()
  .describe(
    'Which collection of that name, when several scopes hold one (rag_list_collections shows each scope).',
  );

export function buildRagCollectionToolEntries(
  opts: RagCollectionToolOptions,
): RagToolEntry[] {
  const { registry, caller, access } = opts;

  const scopeOf = (m: RagCollectionMeta): RagCollectionScope =>
    m.scope ?? 'global';

  const ownerOf = (m: RagCollectionMeta): RagCollectionOwner | undefined => {
    switch (scopeOf(m)) {
      case 'session':
        return m.sessionId
          ? { scope: 'session', sessionId: m.sessionId }
          : undefined;
      case 'user':
        return m.userId ? { scope: 'user', userId: m.userId } : undefined;
      case 'role':
        return m.roleId ? { scope: 'role', roleId: m.roleId } : undefined;
      case 'global':
        return { scope: 'global' };
    }
  };
  const addressable = async (): Promise<RagCollectionMeta[]> => {
    try {
      const roles = await access.roles.rolesOf(caller.userId);
      if (!roles.ok) return [];
      const visible = visibleOwnerFilter(caller, roles.value);
      return registry.list().filter((m) => {
        const owner = ownerOf(m);
        return owner !== undefined && visible(owner);
      });
    } catch {
      return [];
    }
  };
  const authorize = async (
    meta: RagCollectionMeta,
    mode: RagAccessMode,
    owner = ownerOf(meta),
  ): Promise<Refusal | undefined> => {
    if (!owner)
      return {
        ok: false,
        code: 'RAG_ACCESS_DENIED',
        error: 'RagAccessDeniedError: RAG access denied',
      };
    const result = await checkRagAccess(
      caller,
      { name: meta.name, owner },
      mode,
      access,
    );
    return result.ok
      ? undefined
      : {
          ok: false,
          code: result.error.code,
          error: `${result.error.name}: ${result.error.message}`,
        };
  };

  /**
   * The one addressable collection a name (and scope) means. Another caller's
   * collection neither resolves nor makes a name ambiguous: it is absent.
   */
  const resolve = async (
    name: RagJsonValue | undefined,
    scope: RagJsonValue | undefined,
  ): Promise<
    | {
        ok: true;
        meta: RagCollectionMeta;
        scope: RagCollectionScope;
        owner: RagCollectionOwner;
      }
    | Refusal
  > => {
    if (typeof name !== 'string' || name === '') {
      return { ok: false, error: 'collection is required' };
    }
    const wanted = typeof scope === 'string' ? scope : undefined;
    const matches = (await addressable()).filter(
      (m) => m.name === name && (wanted === undefined || scopeOf(m) === wanted),
    );
    if (matches.length === 0) {
      return {
        ok: false,
        error: wanted
          ? `Collection '${name}' not found in scope '${wanted}'`
          : `Collection '${name}' not found`,
      };
    }
    if (matches.length > 1) {
      // The registry's own error, so the tool and the registry word and code
      // an ambiguous name alike.
      const ambiguous = new AmbiguousCollectionError(
        name,
        matches.map(scopeOf),
      );
      return {
        ok: false,
        code: ambiguous.code,
        error: `${ambiguous.name}: ${ambiguous.message}`,
      };
    }
    const owner = ownerOf(matches[0]);
    if (!owner)
      return {
        ok: false,
        error: 'Collection owner is invalid',
        code: 'RAG_ACCESS_DENIED',
      };
    return { ok: true, meta: matches[0], scope: scopeOf(matches[0]), owner };
  };

  const resolveEditor = async (
    name: RagJsonValue | undefined,
    scope: RagJsonValue | undefined,
  ): Promise<{ ok: true; editor: IRagEditor } | Refusal> => {
    const r = await resolve(name, scope);
    if (!r.ok) return r;
    const denied = await authorize(r.meta, 'write', r.owner);
    if (denied) return denied;
    const editor = registry.getEditor(r.meta.name, r.scope, r.owner);
    if (!editor) {
      return { ok: false, error: `Collection '${r.meta.name}' is read-only` };
    }
    return { ok: true, editor };
  };

  const addTool: RagToolEntry = {
    toolDefinition: {
      name: 'rag_add',
      description: 'Add a new document to a RAG collection.',
      inputSchema: {
        collection: z.string(),
        scope: scopeArg,
        roleId: z.string().optional(),
        text: z.string(),
        canonicalKey: z.string(),
        tags: z.array(z.string()).optional(),
      },
    },
    handler: async (_ctx, args) => {
      const r = await resolveEditor(args.collection, args.scope);
      if (!r.ok) return r;
      const res = await r.editor.upsert(String(args.text), {
        canonicalKey: String(args.canonicalKey),
        tags: args.tags as string[] | undefined,
      });
      return res.ok
        ? { ok: true, id: res.value.id }
        : { ok: false, error: res.error.message };
    },
  };

  const correctTool: RagToolEntry = {
    toolDefinition: {
      name: 'rag_correct',
      description:
        'Supersede a document with a new corrected version. Marks the predecessor as superseded.',
      inputSchema: {
        collection: z.string(),
        scope: scopeArg,
        roleId: z.string().optional(),
        predecessorId: z.string(),
        predecessorCanonicalKey: z.string(),
        newText: z.string(),
        reason: z.string(),
      },
    },
    handler: async (_ctx, args) => {
      const r = await resolveEditor(args.collection, args.scope);
      if (!r.ok) return r;
      const predecessorMeta = {
        canonicalKey: String(args.predecessorCanonicalKey),
      };
      const newRes = await r.editor.upsert(String(args.newText), {
        canonicalKey: predecessorMeta.canonicalKey,
      });
      if (!newRes.ok) return { ok: false, error: newRes.error.message };

      const { predecessor } = buildCorrectionMetadata({
        predecessor: predecessorMeta,
        predecessorId: String(args.predecessorId),
        newEntryId: newRes.value.id,
        reason: String(args.reason),
      });
      const supRes = await r.editor.upsert('', {
        ...predecessor,
        id: String(args.predecessorId),
      });
      if (!supRes.ok) return { ok: false, error: supRes.error.message };
      return {
        ok: true,
        predecessorId: String(args.predecessorId),
        newId: newRes.value.id,
      };
    },
  };

  const deprecateTool: RagToolEntry = {
    toolDefinition: {
      name: 'rag_deprecate',
      description: 'Mark a document as deprecated (idempotent).',
      inputSchema: {
        collection: z.string(),
        scope: scopeArg,
        roleId: z.string().optional(),
        id: z.string(),
        canonicalKey: z.string(),
        reason: z.string(),
      },
    },
    handler: async (_ctx, args) => {
      const r = await resolveEditor(args.collection, args.scope);
      if (!r.ok) return r;
      const meta = deprecateMetadata(
        { canonicalKey: String(args.canonicalKey) },
        String(args.reason),
      );
      const res = await r.editor.upsert('', {
        ...meta,
        id: String(args.id),
      });
      return res.ok
        ? { ok: true, id: res.value.id }
        : { ok: false, error: res.error.message };
    },
  };

  const listTool: RagToolEntry = {
    toolDefinition: {
      name: 'rag_list_collections',
      description:
        'List the RAG collections you can address, each with its scope, with optional scope/provider filters.',
      inputSchema: {
        scope: z.enum(['session', 'user', 'role', 'global']).optional(),
        provider: z.string().optional(),
      },
    },
    handler: async (_ctx, args) => {
      const metas = (await addressable()).filter((m) => {
        if (args.scope && scopeOf(m) !== args.scope) return false;
        if (args.provider && m.providerName !== args.provider) return false;
        return true;
      });
      const collections: RagCollectionMeta[] = [];
      for (const meta of metas) {
        if (!(await authorize(meta, 'read'))) collections.push(meta);
      }
      return { ok: true, collections };
    },
  };

  const describeTool: RagToolEntry = {
    toolDefinition: {
      name: 'rag_describe_collection',
      description: 'Return the metadata of a RAG collection by name.',
      inputSchema: {
        name: z.string(),
        scope: scopeArg,
        roleId: z.string().optional(),
      },
    },
    handler: async (_ctx, args) => {
      const r = await resolve(args.name, args.scope);
      if (!r.ok) return r;
      return (await authorize(r.meta, 'read')) ?? { ok: true, meta: r.meta };
    },
  };

  const deleteTool: RagToolEntry = {
    toolDefinition: {
      name: 'rag_delete_collection',
      description: 'Delete a RAG collection you are permitted to manage.',
      inputSchema: {
        name: z.string(),
        scope: scopeArg,
        roleId: z.string().optional(),
      },
    },
    handler: async (_ctx, args) => {
      // Owner keys are compared by resolve(): a collection that is not this
      // caller's is not in its address space.
      const r = await resolve(args.name, args.scope);
      if (!r.ok) return r;
      const denied = await authorize(r.meta, 'write', r.owner);
      if (denied) return denied;
      const name = r.meta.name;
      const res = await registry.deleteCollection(name, r.scope, r.owner);
      if (res.ok) return { ok: true };
      if (res.error instanceof CollectionDataDeleteError) {
        return {
          ok: true,
          warning: `Collection '${name}' was removed, but its data could not be deleted: ${res.error.message}`,
        };
      }
      return { ok: false, code: res.error.code, error: res.error.message };
    },
  };

  const tools: RagToolEntry[] = [
    addTool,
    correctTool,
    deprecateTool,
    listTool,
    describeTool,
    deleteTool,
  ];

  if (opts.providerRegistry) {
    const providerRegistry = opts.providerRegistry;
    const createTool: RagToolEntry = {
      toolDefinition: {
        name: 'rag_create_collection',
        description: 'Create a RAG collection in an authorized scope.',
        inputSchema: {
          provider: z.string(),
          name: z.string(),
          scope: z.enum(['session', 'user', 'role', 'global']),
          roleId: z.string().optional(),
          displayName: z.string().optional(),
          description: z.string().optional(),
          tags: z.array(z.string()).optional(),
        },
      },
      handler: async (_ctx, args) => {
        const providerName = String(args.provider);
        if (!providerRegistry.getProvider(providerName)) {
          return {
            ok: false,
            error: `RAG provider '${providerName}' is not registered`,
          };
        }
        // The owner comes from the bound identity and nowhere else; the scope
        // is checked here too, for a caller that did not apply the schema.
        let owner: RagCollectionOwner;
        if (args.scope === 'session') {
          owner = { scope: 'session', sessionId: caller.sessionId };
        } else if (args.scope === 'user') {
          if (!caller.userId) {
            return {
              ok: false,
              error:
                'A user collection needs a caller with a userId, and this one has none',
            };
          }
          owner = { scope: 'user', userId: caller.userId };
        } else if (args.scope === 'role' && typeof args.roleId === 'string') {
          if (!caller.isAdmin)
            return {
              ok: false,
              code: 'RAG_ACCESS_DENIED',
              error:
                'RagAccessDeniedError: Role collection creation requires an admin',
            };
          owner = { scope: 'role', roleId: args.roleId };
        } else if (args.scope === 'global') {
          owner = { scope: 'global' };
        } else {
          return { ok: false, error: 'A valid scope and owner are required' };
        }
        const name = String(args.name);
        const permission = await checkRagAccess(
          caller,
          { name, owner },
          'write',
          access,
        );
        if (!permission.ok)
          return {
            ok: false,
            code: permission.error.code,
            error: `${permission.error.name}: ${permission.error.message}`,
          };
        const attributes = opts.attributesFor?.({ name, ...owner });
        const res = await registry.createCollection({
          providerName,
          collectionName: name,
          displayName: args.displayName as string | undefined,
          description: args.description as string | undefined,
          tags: args.tags as string[] | undefined,
          ...owner,
          ...(attributes !== undefined ? { attributes } : {}),
        });
        return res.ok
          ? { ok: true, meta: res.value }
          : { ok: false, code: res.error.code, error: res.error.message };
      },
    };
    tools.push(createTool);
  }

  return tools;
}
