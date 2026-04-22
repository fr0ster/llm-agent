import type {
  IRag,
  IRagEditor,
  IRagRegistry,
  RagCollectionMeta,
  RagCollectionScope,
} from '../../interfaces/rag.js';
import type { Result } from '../../interfaces/types.js';
import { RagError } from '../../interfaces/types.js';
import { ImmutableEditStrategy } from '../strategies/edit/immutable.js';

interface Entry {
  rag: IRag;
  editor?: IRagEditor;
  meta: RagCollectionMeta;
}

export class SimpleRagRegistry implements IRagRegistry {
  protected readonly entries = new Map<string, Entry>();

  register(
    name: string,
    rag: IRag,
    editor?: IRagEditor,
    meta?: Omit<RagCollectionMeta, 'name' | 'editable'>,
  ): void {
    if (this.entries.has(name)) {
      throw new Error(`Collection '${name}' is already registered`);
    }
    const editable =
      Boolean(editor) && !(editor instanceof ImmutableEditStrategy);
    this.entries.set(name, {
      rag,
      editor,
      meta: {
        name,
        displayName: meta?.displayName ?? name,
        description: meta?.description,
        tags: meta?.tags,
        editable,
      },
    });
  }

  unregister(name: string): boolean {
    return this.entries.delete(name);
  }

  get(name: string): IRag | undefined {
    return this.entries.get(name)?.rag;
  }

  getEditor(name: string): IRagEditor | undefined {
    return this.entries.get(name)?.editor;
  }

  list(): readonly RagCollectionMeta[] {
    return Array.from(this.entries.values()).map((e) => e.meta);
  }

  async createCollection(_params: {
    providerName: string;
    collectionName: string;
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
    displayName?: string;
    description?: string;
    tags?: readonly string[];
  }): Promise<Result<RagCollectionMeta, RagError>> {
    return {
      ok: false,
      error: new RagError(
        'createCollection not implemented yet',
        'RAG_NOT_IMPLEMENTED',
      ),
    };
  }

  async deleteCollection(_name: string): Promise<Result<void, RagError>> {
    return {
      ok: false,
      error: new RagError(
        'deleteCollection not implemented yet',
        'RAG_NOT_IMPLEMENTED',
      ),
    };
  }

  async closeSession(_sessionId: string): Promise<Result<void, RagError>> {
    return {
      ok: false,
      error: new RagError(
        'closeSession not implemented yet',
        'RAG_NOT_IMPLEMENTED',
      ),
    };
  }
}
