import { createHash } from 'node:crypto';
import type {
  IRag,
  IRagEditor,
  IRagProvider,
  IRagProviderRegistry,
  IRagRegistry,
  RagCollectionMeta,
  RagCollectionOwner,
  RagCollectionScope,
  RagRegistryCreateCollectionParams,
} from '../../interfaces/rag.js';
import { RagError, type Result } from '../../interfaces/types.js';
import {
  ragOwnerKeys,
  validateRagAttributes,
  validateRagOwner,
} from '../catalog/validation.js';
import {
  AmbiguousCollectionError,
  CollectionNotFoundError,
  DeleteUnsupportedError,
  DuplicateCollectionError,
  ProviderNotFoundError,
  SessionCloseIncompleteError,
} from '../corrections/errors.js';
import { ImmutableEditStrategy } from '../strategies/edit/immutable.js';
import { reservedGlobalNameError } from './store-key.js';

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

/** A collection is its scope and its name (§6.4); the owner is the registry's own. */
function keyOf(scope: RagCollectionScope, name: string): string {
  return JSON.stringify([scope, name]);
}

const SCOPES: readonly RagCollectionScope[] = ['global', 'user', 'session'];

type Found =
  | { ok: true; found?: { key: string; entry: Entry } }
  | { ok: false; error: AmbiguousCollectionError };

export class SimpleRagRegistry implements IRagRegistry {
  /** Keyed by keyOf(scope, name). */
  protected readonly entries = new Map<string, Entry>();
  /**
   * Store names whose deletion is still running, with that deletion. A store
   * name is released only once its deletion has finished: a collection created
   * under it meanwhile waits, so the deletion cannot remove what it writes.
   */
  protected readonly deletions = new Map<string, Promise<unknown>>();
  /** Keys (scope, name) being created, held until inserted or refused. */
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

  /**
   * The entry `name` addresses: with a scope, that scope's; without one, the
   * entry of the one scope holding it — or AmbiguousCollectionError naming
   * every scope that does. Never a silent precedence between scopes.
   */
  protected find(name: string, scope?: RagCollectionScope): Found {
    if (scope) {
      const key = keyOf(scope, name);
      const entry = this.entries.get(key);
      return { ok: true, found: entry ? { key, entry } : undefined };
    }
    const held = SCOPES.filter((s) => this.entries.has(keyOf(s, name)));
    if (held.length > 1) {
      return { ok: false, error: new AmbiguousCollectionError(name, held) };
    }
    if (held.length === 0) return { ok: true };
    const key = keyOf(held[0], name);
    const entry = this.entries.get(key) as Entry;
    return { ok: true, found: { key, entry } };
  }

  private findOrThrow(
    name: string,
    scope?: RagCollectionScope,
  ): { key: string; entry: Entry } | undefined {
    const f = this.find(name, scope);
    if (!f.ok) throw f.error;
    return f.found;
  }

  /** A key is taken while an entry holds it or a creation of it is running. */
  protected isTaken(key: string): boolean {
    return this.entries.has(key) || this.creating.has(key);
  }

  private insert(key: string, entry: Entry): void {
    this.entries.set(key, entry);
    this.fireMutation();
  }

  register(
    name: string,
    rag: IRag,
    editor?: IRagEditor,
    meta?: Omit<RagCollectionMeta, 'name' | 'editable'>,
  ): void {
    const scope = meta?.scope ?? 'global';
    const reserved = reservedGlobalNameError(scope, name);
    if (reserved) throw reserved;
    const key = keyOf(scope, name);
    if (this.isTaken(key)) {
      throw new DuplicateCollectionError(
        name,
        `already registered in scope '${scope}'`,
      );
    }
    const editable =
      Boolean(editor) && !(editor instanceof ImmutableEditStrategy);
    this.insert(key, {
      rag,
      editor,
      storeName: name,
      meta: {
        name,
        displayName: meta?.displayName ?? name,
        description: meta?.description,
        editable,
        scope,
        sessionId: meta?.sessionId,
        userId: meta?.userId,
        providerName: meta?.providerName,
        tags: meta?.tags,
      },
    });
  }

  unregister(name: string, scope?: RagCollectionScope): boolean {
    const found = this.findOrThrow(name, scope);
    if (!found) return false;
    this.entries.delete(found.key);
    this.fireMutation();
    return true;
  }

  get(name: string, scope?: RagCollectionScope): IRag | undefined {
    return this.findOrThrow(name, scope)?.entry.rag;
  }

  getEditor(name: string, scope?: RagCollectionScope): IRagEditor | undefined {
    return this.findOrThrow(name, scope)?.entry.editor;
  }

  list(): readonly RagCollectionMeta[] {
    return Array.from(this.entries.values()).map((e) => e.meta);
  }

  async createCollection(
    params: RagRegistryCreateCollectionParams,
  ): Promise<Result<RagCollectionMeta, RagError>> {
    // Checked before anything else: an untyped caller's owner without its key
    // would digest to a store every such caller shares (storeNameFor), and
    // attributes JSON would change could not come back as given (§6.3).
    const owner = validateRagOwner(params);
    if (!owner.ok) return owner;
    const attributes = validateRagAttributes(params.attributes);
    if (!attributes.ok) return attributes;
    const reserved = reservedGlobalNameError(
      owner.value.scope,
      params.collectionName,
    );
    if (reserved) return { ok: false, error: reserved };

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

    // Preflight duplicate check, counting creations still running: two at
    // once would share one store.
    const key = keyOf(owner.value.scope, params.collectionName);
    if (this.isTaken(key)) {
      return {
        ok: false,
        error: new DuplicateCollectionError(
          params.collectionName,
          `the name is taken in scope '${owner.value.scope}'`,
        ),
      };
    }

    this.creating.add(key);
    try {
      return await this.createUnder(provider, key, params, owner.value);
    } finally {
      this.creating.delete(key);
    }
  }

  private async createUnder(
    provider: IRagProvider,
    key: string,
    params: RagRegistryCreateCollectionParams,
    owner: RagCollectionOwner,
  ): Promise<Result<RagCollectionMeta, RagError>> {
    // A provider that keeps stores by name (Qdrant, a database) opens whatever
    // is there, so each owner gets a store name of its own; see storeNameFor.
    const storeName = storeNameFor({
      collectionName: params.collectionName,
      ...owner,
    });
    // Released only when a deletion under it has finished; see deletions.
    await this.deletions.get(storeName);

    const created = await provider.createCollection(storeName, {
      ...owner,
      collectionName: params.collectionName,
      attributes: params.attributes,
      adoptExisting: params.adoptExisting,
    });
    if (!created.ok) return created;

    // Inserted directly: the key has been held in `creating` since the
    // preflight, so nothing can have taken it, and there is nothing to roll
    // back — a rollback would delete a store whose catalog record the provider
    // has just committed (§6.3).
    const editor = created.value.editor;
    const entry: Entry = {
      rag: created.value.rag,
      editor,
      storeName,
      meta: {
        name: params.collectionName,
        displayName: params.displayName ?? params.collectionName,
        description: params.description,
        editable: Boolean(editor) && !(editor instanceof ImmutableEditStrategy),
        scope: owner.scope,
        ...ragOwnerKeys(owner),
        providerName: params.providerName,
        tags: params.tags,
      },
    };
    this.insert(key, entry);
    return { ok: true, value: entry.meta };
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
  async deleteCollection(
    name: string,
    scope?: RagCollectionScope,
  ): Promise<Result<void, RagError>> {
    const f = this.find(name, scope);
    if (!f.ok) return { ok: false, error: f.error };
    if (!f.found) {
      return { ok: false, error: new CollectionNotFoundError(name) };
    }
    const { key, entry } = f.found;
    this.entries.delete(key);
    this.fireMutation();
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
      const res = await this.deleteCollection(name, 'session');
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
