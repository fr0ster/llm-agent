import { RagError } from '../../interfaces/types.js';
import {
  CollectionNotFoundError,
  ProviderNotFoundError,
} from '../corrections/errors.js';
import { ImmutableEditStrategy } from '../strategies/edit/immutable.js';
export class SimpleRagRegistry {
  entries = new Map();
  providerRegistry;
  mutationListener;
  setProviderRegistry(providerRegistry) {
    this.providerRegistry = providerRegistry;
  }
  setMutationListener(listener) {
    this.mutationListener = listener;
  }
  fireMutation() {
    this.mutationListener?.();
  }
  register(name, rag, editor, meta) {
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
        editable,
        scope: meta?.scope ?? 'global',
        sessionId: meta?.sessionId,
        userId: meta?.userId,
        providerName: meta?.providerName,
        tags: meta?.tags,
      },
    });
    this.fireMutation();
  }
  unregister(name) {
    const existed = this.entries.delete(name);
    if (existed) this.fireMutation();
    return existed;
  }
  get(name) {
    return this.entries.get(name)?.rag;
  }
  getEditor(name) {
    return this.entries.get(name)?.editor;
  }
  list() {
    return Array.from(this.entries.values()).map((e) => e.meta);
  }
  async createCollection(params) {
    if (!this.providerRegistry) {
      return {
        ok: false,
        error: new RagError(
          'No IRagProviderRegistry configured on SimpleRagRegistry',
          'RAG_NO_PROVIDER_REGISTRY',
        ),
      };
    }
    const provider = this.providerRegistry.getProvider(params.providerName);
    if (!provider) {
      return {
        ok: false,
        error: new ProviderNotFoundError(params.providerName),
      };
    }
    // Preflight duplicate-name check.
    if (this.entries.has(params.collectionName)) {
      return {
        ok: false,
        error: new RagError(
          `Collection '${params.collectionName}' already exists`,
          'RAG_DUPLICATE_COLLECTION',
        ),
      };
    }
    const created = await provider.createCollection(params.collectionName, {
      scope: params.scope,
      sessionId: params.sessionId,
      userId: params.userId,
    });
    if (!created.ok) return created;
    try {
      this.register(
        params.collectionName,
        created.value.rag,
        created.value.editor,
        {
          displayName: params.displayName ?? params.collectionName,
          description: params.description,
          scope: params.scope,
          sessionId: params.sessionId,
          userId: params.userId,
          providerName: params.providerName,
          tags: params.tags,
        },
      );
    } catch (err) {
      // Defense-in-depth rollback: the preflight check should prevent this,
      // but if register throws anyway (subclass or race), roll the backend back.
      if (provider.deleteCollection) {
        await provider.deleteCollection(params.collectionName).catch(() => {});
      }
      return {
        ok: false,
        error:
          err instanceof RagError
            ? err
            : new RagError(String(err), 'RAG_REGISTER_FAILED'),
      };
    }
    const registered = this.entries.get(params.collectionName);
    if (!registered) {
      return {
        ok: false,
        error: new RagError(
          `Collection '${params.collectionName}' vanished after registration`,
          'RAG_REGISTER_FAILED',
        ),
      };
    }
    return { ok: true, value: registered.meta };
  }
  async deleteCollection(name) {
    const entry = this.entries.get(name);
    if (!entry) {
      return { ok: false, error: new CollectionNotFoundError(name) };
    }
    if (entry.meta.providerName && this.providerRegistry) {
      const provider = this.providerRegistry.getProvider(
        entry.meta.providerName,
      );
      if (provider?.deleteCollection) {
        const res = await provider.deleteCollection(name);
        if (!res.ok) return res;
      }
    }
    this.unregister(name);
    return { ok: true, value: undefined };
  }
  async closeSession(sessionId) {
    const victims = Array.from(this.entries.values())
      .filter(
        (e) => e.meta.scope === 'session' && e.meta.sessionId === sessionId,
      )
      .map((e) => e.meta.name);
    for (const name of victims) {
      const res = await this.deleteCollection(name);
      if (!res.ok) return res;
    }
    return { ok: true, value: undefined };
  }
}
//# sourceMappingURL=simple-rag-registry.js.map
