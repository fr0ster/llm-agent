import type {
  IRag,
  IRagEditor,
  IRagRegistry,
  RagCollectionMeta,
} from '../../interfaces/rag.js';
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
}
