import { createHash } from 'node:crypto';
import type {
  IRag,
  IRagEditor,
  IRagProvider,
  IRagProviderRegistry,
  IRagRegistry,
  RagCollectionMeta,
  RagCollectionScope,
} from '../../interfaces/rag.js';
import { RagError, type Result } from '../../interfaces/types.js';
import {
  CollectionNotFoundError,
  DeleteUnsupportedError,
  ProviderNotFoundError,
  SessionCloseIncompleteError,
} from '../corrections/errors.js';
import { ImmutableEditStrategy } from '../strategies/edit/immutable.js';

/**
 * The name a provider keeps a collection's data under.
 *
 * The collection name and a digest of its scope, its owner (the session for a
 * session collection, the user for a user one) and the name. The same
 * collection of the same owner gets the same store, so a user or global
 * collection finds its data again after a restart; another session or user
 * gets another one, so none opens a store someone else's deletion left. It fits
 * the strictest provider rules: letters, digits and underscores, not starting
 * with a digit, at most 63 characters (PostgreSQL, HANA).
 */
function storeNameFor(params: {
  collectionName: string;
  scope: RagCollectionScope;
  sessionId?: string;
  userId?: string;
}): string {
  const owner =
    params.scope === 'session'
      ? (params.sessionId ?? '')
      : params.scope === 'user'
        ? (params.userId ?? '')
        : '';
  const digest = createHash('sha256')
    .update(JSON.stringify([params.scope, owner, params.collectionName]))
    .digest('hex')
    .slice(0, 12);
  let base = params.collectionName.replace(/[^a-zA-Z0-9_]/g, '_');
  if (!/^[a-zA-Z_]/.test(base)) base = `_${base}`;
  return `${base.slice(0, 63 - digest.length - 1)}_${digest}`;
}

interface Entry {
  rag: IRag;
  editor?: IRagEditor;
  meta: RagCollectionMeta;
  /** The name its provider knows the store by; see createCollection. */
  storeName: string;
}

export class SimpleRagRegistry implements IRagRegistry {
  protected readonly entries = new Map<string, Entry>();
  /**
   * Store names whose deletion is still running, with that deletion. A store
   * name is released only once its deletion has finished: a collection created
   * under it meanwhile waits, so the deletion cannot remove what it writes.
   */
  protected readonly deletions = new Map<string, Promise<unknown>>();
  /** Collection names being created, held until registered or refused. */
  protected readonly creating = new Set<string>();
  protected providerRegistry?: IRagProviderRegistry;
  protected mutationListener?: () => void;

  setProviderRegistry(providerRegistry: IRagProviderRegistry): void {
    this.providerRegistry = providerRegistry;
  }

  setMutationListener(listener: () => void): void {
    this.mutationListener = listener;
  }

  private fireMutation(): void {
    this.mutationListener?.();
  }

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
      storeName: name,
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

  unregister(name: string): boolean {
    const existed = this.entries.delete(name);
    if (existed) this.fireMutation();
    return existed;
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

  async createCollection(params: {
    providerName: string;
    collectionName: string;
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
    displayName?: string;
    description?: string;
    tags?: readonly string[];
  }): Promise<Result<RagCollectionMeta, RagError>> {
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

    // Preflight duplicate-name check, counting creations still running: two at
    // once would share one store, and the loser's rollback would delete it.
    if (
      this.entries.has(params.collectionName) ||
      this.creating.has(params.collectionName)
    ) {
      return {
        ok: false,
        error: new RagError(
          `Collection '${params.collectionName}' already exists`,
          'RAG_DUPLICATE_COLLECTION',
        ),
      };
    }

    this.creating.add(params.collectionName);
    try {
      return await this.createUnder(provider, params);
    } finally {
      this.creating.delete(params.collectionName);
    }
  }

  private async createUnder(
    provider: IRagProvider,
    params: Parameters<IRagRegistry['createCollection']>[0],
  ): Promise<Result<RagCollectionMeta, RagError>> {
    // A provider that keeps stores by name (Qdrant, a database) opens whatever
    // is there, so each owner gets a store name of its own; see storeNameFor.
    const storeName = storeNameFor(params);
    // Released only when a deletion under it has finished; see deletions.
    await this.deletions.get(storeName);

    const created = await provider.createCollection(storeName, {
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
        await provider.deleteCollection(storeName).catch(() => {});
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
    registered.storeName = storeName;
    return { ok: true, value: registered.meta };
  }

  /**
   * Delete a collection.
   *
   * It is unregistered first, whatever follows, so nothing can reach it again.
   * Then its data goes: a collection a provider created is deleted by that
   * provider's `deleteCollection` or, where the provider has none, emptied
   * through its store's `writer().clearAll()`. A collection registered directly,
   * with no provider, is only unregistered — its store belongs to whoever
   * registered it. Nothing is retried. A failure comes back as the error, with
   * the collection already unregistered; its data may remain in the backend,
   * under a store name no other session or user is given (see storeNameFor).
   * The store name itself is held until the deletion has finished (see
   * deletions).
   */
  async deleteCollection(name: string): Promise<Result<void, RagError>> {
    const entry = this.entries.get(name);
    if (!entry) {
      return { ok: false, error: new CollectionNotFoundError(name) };
    }
    this.unregister(name);
    const deletion: Promise<Result<void, RagError>> = this.deleteData(
      name,
      entry,
    ).finally(() => {
      if (this.deletions.get(entry.storeName) === deletion) {
        this.deletions.delete(entry.storeName);
      }
    });
    this.deletions.set(entry.storeName, deletion);
    return deletion;
  }

  private async deleteData(
    name: string,
    entry: Entry,
  ): Promise<Result<void, RagError>> {
    const providerName = entry.meta.providerName;
    if (!providerName) return { ok: true, value: undefined };
    const provider = this.providerRegistry?.getProvider(providerName);
    if (!provider) {
      return {
        ok: false,
        error: new DeleteUnsupportedError(
          name,
          `provider '${providerName}' is not registered`,
        ),
      };
    }
    try {
      if (provider.deleteCollection) {
        return await provider.deleteCollection(entry.storeName);
      }
      const writer = entry.rag.writer?.();
      if (writer?.clearAll) return await writer.clearAll();
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof RagError
            ? err
            : new RagError(
                `Deleting the data of collection '${name}' failed: ${err instanceof Error ? err.message : String(err)}`,
                'RAG_DELETE_ERROR',
              ),
      };
    }
    return {
      ok: false,
      error: new DeleteUnsupportedError(
        name,
        `provider '${providerName}' has no deleteCollection, and its store no writer().clearAll()`,
      ),
    };
  }

  /**
   * Delete every session-scoped collection of this session. Goes through all of
   * them even when one fails — each is unregistered regardless (see
   * deleteCollection) — and returns the failures together.
   */
  async closeSession(sessionId: string): Promise<Result<void, RagError>> {
    const victims = Array.from(this.entries.values())
      .filter(
        (e) => e.meta.scope === 'session' && e.meta.sessionId === sessionId,
      )
      .map((e) => e.meta.name);
    const failures: Array<{ name: string; error: RagError }> = [];
    for (const name of victims) {
      const res = await this.deleteCollection(name);
      if (!res.ok) failures.push({ name, error: res.error });
    }
    if (failures.length > 0) {
      return {
        ok: false,
        error: new SessionCloseIncompleteError(sessionId, failures),
      };
    }
    return { ok: true, value: undefined };
  }
}
