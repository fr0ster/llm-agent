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
import {
  AmbiguousCollectionError,
  CatalogRecordDeleteError,
  CollectionNotFoundError,
  DeleteUnsupportedError,
} from '../corrections/errors.js';
import {
  buildCorrectionMetadata,
  deprecateMetadata,
} from '../corrections/metadata.js';

/**
 * The caller these entries were built for (§5.1). Declared here rather than
 * imported: llm-agent-libs' SessionGraphIdentity is the same shape, but the
 * dependency runs libs → llm-agent, one way. A consumer hands one straight in.
 */
export interface RagCallerIdentity {
  readonly sessionId: string;
  readonly userId?: string;
}

/**
 * Free-form per-call context. It carries no identity: the entries were built
 * for one caller, and a per-call value that disagreed would act as somebody
 * else. Call sites passing sessionId/userId still compile — the index
 * signature takes them — and nothing reads them.
 */
export interface RagToolContext {
  [key: string]: unknown;
}

export interface RagToolEntry {
  toolDefinition: {
    name: string;
    description: string;
    inputSchema: z.ZodRawShape;
  };
  handler: (
    context: RagToolContext,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

export interface RagCollectionToolOptions {
  registry: IRagRegistry;
  /**
   * Required. It narrows the address space to this caller's collections and
   * the globals the registry holds; an absent identity would mean "do not
   * narrow", which is everyone's address space reached by forgetting a field.
   */
  identity: RagCallerIdentity;
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
  .enum(['session', 'user', 'global'])
  .optional()
  .describe(
    'Which collection of that name, when several scopes hold one (rag_list_collections shows each scope).',
  );

export function buildRagCollectionToolEntries(
  opts: RagCollectionToolOptions,
): RagToolEntry[] {
  const { registry, identity } = opts;

  const scopeOf = (m: RagCollectionMeta): RagCollectionScope =>
    m.scope ?? 'global';

  /** This caller's collections, and the globals it was given (§5.1). */
  const addressable = (): RagCollectionMeta[] =>
    registry.list().filter((m) => {
      const scope = scopeOf(m);
      if (scope === 'session') return m.sessionId === identity.sessionId;
      if (scope === 'user') {
        return identity.userId !== undefined && m.userId === identity.userId;
      }
      return true;
    });

  /**
   * The one addressable collection a name (and scope) means. Another caller's
   * collection neither resolves nor makes a name ambiguous: it is absent.
   */
  const resolve = (
    name: unknown,
    scope: unknown,
  ):
    | { ok: true; meta: RagCollectionMeta; scope: RagCollectionScope }
    | Refusal => {
    if (typeof name !== 'string' || name === '') {
      return { ok: false, error: 'collection is required' };
    }
    const wanted = typeof scope === 'string' ? scope : undefined;
    const matches = addressable().filter(
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
      return { ok: false, code: ambiguous.code, error: ambiguous.message };
    }
    return { ok: true, meta: matches[0], scope: scopeOf(matches[0]) };
  };

  const resolveEditor = (
    name: unknown,
    scope: unknown,
  ): { ok: true; editor: IRagEditor } | Refusal => {
    const r = resolve(name, scope);
    if (!r.ok) return r;
    // Reachable licenses reading, never writing: no framework tool mutates a
    // global, whatever its authorization value (§5.1).
    if (r.scope === 'global') {
      return {
        ok: false,
        error: 'Global collections cannot be modified via MCP',
      };
    }
    const editor = registry.getEditor(r.meta.name, r.scope);
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
        text: z.string(),
        canonicalKey: z.string(),
        tags: z.array(z.string()).optional(),
      },
    },
    handler: async (_ctx, args) => {
      const r = resolveEditor(args.collection, args.scope);
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
        predecessorId: z.string(),
        predecessorCanonicalKey: z.string(),
        newText: z.string(),
        reason: z.string(),
      },
    },
    handler: async (_ctx, args) => {
      const r = resolveEditor(args.collection, args.scope);
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
        id: z.string(),
        canonicalKey: z.string(),
        reason: z.string(),
      },
    },
    handler: async (_ctx, args) => {
      const r = resolveEditor(args.collection, args.scope);
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
        scope: z.enum(['session', 'user', 'global']).optional(),
        provider: z.string().optional(),
      },
    },
    handler: async (_ctx, args) => {
      const metas = addressable().filter((m) => {
        if (args.scope && scopeOf(m) !== args.scope) return false;
        if (args.provider && m.providerName !== args.provider) return false;
        return true;
      });
      return { ok: true, collections: metas };
    },
  };

  const describeTool: RagToolEntry = {
    toolDefinition: {
      name: 'rag_describe_collection',
      description: 'Return the metadata of a RAG collection by name.',
      inputSchema: { name: z.string(), scope: scopeArg },
    },
    handler: async (_ctx, args) => {
      const r = resolve(args.name, args.scope);
      return r.ok ? { ok: true, meta: r.meta } : r;
    },
  };

  const deleteTool: RagToolEntry = {
    toolDefinition: {
      name: 'rag_delete_collection',
      description: 'Delete a RAG collection you own (session or user scope).',
      inputSchema: { name: z.string(), scope: scopeArg },
    },
    handler: async (_ctx, args) => {
      // Owner keys are compared by resolve(): a collection that is not this
      // caller's is not in its address space.
      const r = resolve(args.name, args.scope);
      if (!r.ok) return r;
      if (r.scope === 'global') {
        return {
          ok: false,
          error: 'Global collections cannot be deleted via MCP',
        };
      }
      const name = r.meta.name;
      const res = await registry.deleteCollection(name, r.scope);
      if (res.ok) return { ok: true };
      if (res.error instanceof CollectionNotFoundError) {
        return { ok: false, error: res.error.message };
      }
      if (res.error instanceof CatalogRecordDeleteError) {
        // Its record could not be removed, so nothing was: record and data are
        // intact and the registry has it again. A failed deletion to retry —
        // not a removal with a data problem.
        return { ok: false, error: res.error.message };
      }
      if (res.error instanceof DeleteUnsupportedError) {
        // Nothing could reach the collection's store: its provider is not
        // registered, or has no way to delete. Its catalog record was never
        // touched, so the collection is not gone — it comes back on the next
        // hydration. Reporting ok:true would claim a removal that did not happen.
        return { ok: false, code: res.error.code, error: res.error.message };
      }
      // The record is gone and the collection unregistered: it is gone for the
      // caller, and the orphaned data is reported as what it is.
      return {
        ok: true,
        warning: `Collection '${name}' was removed, but its data could not be deleted: ${res.error.message}`,
      };
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
        description:
          'Create a new RAG collection of your own, for this session or for you.',
        inputSchema: {
          provider: z.string(),
          name: z.string(),
          // No 'global': creating one would put a collection into every
          // caller's address space, and that is a consumer's decision (§5.1).
          scope: z.enum(['session', 'user']),
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
          owner = { scope: 'session', sessionId: identity.sessionId };
        } else if (args.scope === 'user') {
          if (!identity.userId) {
            return {
              ok: false,
              error:
                'A user collection needs a caller with a userId, and this one has none',
            };
          }
          owner = { scope: 'user', userId: identity.userId };
        } else {
          return { ok: false, error: "scope must be 'session' or 'user'" };
        }
        const name = String(args.name);
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
