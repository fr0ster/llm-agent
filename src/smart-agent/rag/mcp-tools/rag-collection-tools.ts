import { z } from 'zod';
import type { IRagRegistry } from '../../interfaces/rag.js';
import {
  buildCorrectionMetadata,
  deprecateMetadata,
} from '../corrections/metadata.js';

export interface RagToolEntry {
  toolDefinition: {
    name: string;
    description: string;
    inputSchema: z.ZodRawShape;
  };
  handler: (context: object, args: Record<string, unknown>) => Promise<unknown>;
}

export function buildRagCollectionToolEntries(opts: {
  registry: IRagRegistry;
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

  return [addTool, correctTool, deprecateTool];
}
