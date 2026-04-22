import { z } from 'zod';
import type {
  IRagProviderRegistry,
  IRagRegistry,
} from '../../interfaces/rag.js';
import {
  buildCorrectionMetadata,
  deprecateMetadata,
} from '../corrections/metadata.js';

export interface RagToolContext {
  sessionId?: string;
  userId?: string;
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

export function buildRagCollectionToolEntries(opts: {
  registry: IRagRegistry;
  providerRegistry?: IRagProviderRegistry;
}): RagToolEntry[] {
  const { registry } = opts;

  const resolveEditor = (name: unknown) => {
    if (typeof name !== 'string') {
      return { ok: false as const, error: 'collection is required' };
    }
    const editor = registry.getEditor(name);
    if (!editor) {
      return {
        ok: false as const,
        error: `Collection '${name}' is read-only or unknown`,
      };
    }
    return { ok: true as const, editor };
  };

  const addTool: RagToolEntry = {
    toolDefinition: {
      name: 'rag_add',
      description: 'Add a new document to a RAG collection.',
      inputSchema: {
        collection: z.string(),
        text: z.string(),
        canonicalKey: z.string(),
        tags: z.array(z.string()).optional(),
      },
    },
    handler: async (_ctx, args) => {
      const r = resolveEditor(args.collection);
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
        predecessorId: z.string(),
        predecessorCanonicalKey: z.string(),
        newText: z.string(),
        reason: z.string(),
      },
    },
    handler: async (_ctx, args) => {
      const r = resolveEditor(args.collection);
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
        id: z.string(),
        canonicalKey: z.string(),
        reason: z.string(),
      },
    },
    handler: async (_ctx, args) => {
      const r = resolveEditor(args.collection);
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
        'List known RAG collections with optional scope/provider filters.',
      inputSchema: {
        scope: z.enum(['session', 'user', 'global']).optional(),
        provider: z.string().optional(),
      },
    },
    handler: async (_ctx, args) => {
      const metas = registry.list().filter((m) => {
        if (args.scope && m.scope !== args.scope) return false;
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
      inputSchema: { name: z.string() },
    },
    handler: async (_ctx, args) => {
      const name = String(args.name);
      const meta = registry.list().find((m) => m.name === name);
      if (!meta) {
        return { ok: false, error: `Collection '${name}' not found` };
      }
      return { ok: true, meta };
    },
  };

  const deleteTool: RagToolEntry = {
    toolDefinition: {
      name: 'rag_delete_collection',
      description: 'Delete a RAG collection you own (session or user scope).',
      inputSchema: { name: z.string() },
    },
    handler: async (ctx, args) => {
      const name = String(args.name);
      const meta = registry.list().find((m) => m.name === name);
      if (!meta) {
        return { ok: false, error: `Collection '${name}' not found` };
      }
      if (meta.scope === 'global' || !meta.scope) {
        return {
          ok: false,
          error: `Global collections cannot be deleted via MCP`,
        };
      }
      if (meta.scope === 'session') {
        if (!ctx.sessionId || ctx.sessionId !== meta.sessionId) {
          return {
            ok: false,
            error: `sessionId mismatch for collection '${name}'`,
          };
        }
      }
      if (meta.scope === 'user') {
        if (!ctx.userId || ctx.userId !== meta.userId) {
          return {
            ok: false,
            error: `userId mismatch for collection '${name}'`,
          };
        }
      }
      const res = await registry.deleteCollection(name);
      return res.ok ? { ok: true } : { ok: false, error: res.error.message };
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
        description: 'Create a new RAG collection via a provider.',
        inputSchema: {
          provider: z.string(),
          name: z.string(),
          scope: z.enum(['session', 'user', 'global']),
          displayName: z.string().optional(),
          description: z.string().optional(),
          tags: z.array(z.string()).optional(),
        },
      },
      handler: async (ctx, args) => {
        const providerName = String(args.provider);
        const provider = providerRegistry.getProvider(providerName);
        if (!provider) {
          return {
            ok: false,
            error: `RAG provider '${providerName}' is not registered`,
          };
        }
        const res = await registry.createCollection({
          providerName,
          collectionName: String(args.name),
          scope: args.scope as 'session' | 'user' | 'global',
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          displayName: args.displayName as string | undefined,
          description: args.description as string | undefined,
          tags: args.tags as string[] | undefined,
        });
        return res.ok
          ? { ok: true, meta: res.value }
          : { ok: false, error: res.error.message };
      },
    };
    tools.push(createTool);
  }

  return tools;
}
