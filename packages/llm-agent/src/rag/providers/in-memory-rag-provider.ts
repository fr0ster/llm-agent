import type {
  IIdStrategy,
  IRag,
  IRagEditor,
  RagCatalogDescription,
  RagCollectionRecord,
  RagCollectionScope,
  RagProviderCreateCollectionOptions,
} from '../../interfaces/rag.js';
import type {
  IRagRoleAdmin,
  IRagRoleCheck,
} from '../../interfaces/rag-access.js';
import type { Result } from '../../interfaces/types.js';
import { RagError } from '../../interfaces/types.js';
import { InMemoryRagRoleStore } from '../access/in-memory-role-store.js';
import { InMemorySessionBindingStore } from '../access/in-memory-session-binding-store.js';
import { validateRagOwner } from '../catalog/validation.js';
import { InMemoryRag, type InMemoryRagConfig } from '../in-memory-rag.js';
import { AbstractRagProvider } from './base-provider.js';

export interface InMemoryRagProviderConfig {
  name: string;
  editable?: boolean;
  /**
   * Scopes this provider accepts. Default `['session']`: its stores live in
   * this process and are gone after a restart, so whether a longer-lived scope
   * fits is the host's call.
   */
  supportedScopes?: readonly RagCollectionScope[];
  inMemoryRagConfig?: InMemoryRagConfig;
  idStrategyFactory?: (opts: {
    scope: RagCollectionScope;
    sessionId?: string;
    userId?: string;
  }) => IIdStrategy;
}

export class InMemoryRagProvider extends AbstractRagProvider {
  readonly name: string;
  readonly kind = 'vector';
  readonly editable: boolean;
  readonly supportedScopes: readonly RagCollectionScope[];

  private readonly records = new Map<string, RagCollectionRecord>();
  private readonly stores = new Map<
    string,
    { rag: IRag; editor: IRagEditor }
  >();
  private readonly roleStore = new InMemoryRagRoleStore((name) =>
    [...this.records.values()].some((record) => record.name === name),
  );
  readonly roles: IRagRoleCheck = this.roleStore;
  readonly roleAdmin: IRagRoleAdmin = this.roleStore;
  readonly bindings = new InMemorySessionBindingStore();

  async describeCollections(): Promise<
    Result<RagCatalogDescription, RagError>
  > {
    return {
      ok: true,
      value: {
        records: [...this.records.values()].map((record) =>
          structuredClone(record),
        ),
        rejected: [],
      },
    };
  }

  async deleteCollection(name: string): Promise<Result<void, RagError>> {
    const record = this.records.get(name);
    if (record) this.roleStore.removeCollection(record.name);
    this.records.delete(name);
    const store = this.stores.get(name);
    this.stores.delete(name);
    if (store) {
      const writer = store.rag.writer?.();
      if (writer?.clearAll) return writer.clearAll();
    }
    return { ok: true, value: undefined };
  }

  async openCollection(
    record: RagCollectionRecord,
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>> {
    const stored = this.records.get(record.storeName);
    const store = this.stores.get(record.storeName);
    const owner = validateRagOwner(record);
    if (
      !stored ||
      !store ||
      !owner.ok ||
      JSON.stringify(validateRagOwner(stored)) !== JSON.stringify(owner)
    )
      return {
        ok: false,
        error: new RagError(
          'Collection does not exist for this owner',
          'RAG_COLLECTION_NOT_FOUND',
        ),
      };
    return { ok: true, value: store };
  }

  private readonly inMemoryCfg?: InMemoryRagConfig;

  constructor(cfg: InMemoryRagProviderConfig) {
    super();
    this.name = cfg.name;
    this.editable = cfg.editable ?? true;
    this.supportedScopes = cfg.supportedScopes ?? ['session'];
    this.inMemoryCfg = cfg.inMemoryRagConfig;
    if (cfg.idStrategyFactory) this.idStrategyFactory = cfg.idStrategyFactory;
  }

  async createCollection(
    name: string,
    opts: RagProviderCreateCollectionOptions,
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>> {
    const checked = this.checkCreateOptions(opts);
    if (!checked.ok) return checked;
    if (opts.adoptExisting === true) {
      return {
        ok: false,
        error: new RagError(
          `Provider '${this.name}' keeps no store outside this process, so there is nothing to adopt`,
          'RAG_CREATE_ERROR',
        ),
      };
    }
    if (this.records.has(name))
      return {
        ok: false,
        error: new RagError(
          'Collection already exists',
          'RAG_DUPLICATE_COLLECTION',
        ),
      };
    const rag = new InMemoryRag(this.inMemoryCfg);
    const editor = this.buildEditor(rag, this.pickIdStrategy(checked.value));
    // The role guard and catalog write are synchronous, so deletion cannot interleave.
    this.records.set(
      name,
      structuredClone({
        storeName: name,
        name: opts.collectionName ?? name,
        ...checked.value,
        ...(opts.attributes !== undefined
          ? { attributes: opts.attributes }
          : {}),
      }),
    );
    this.stores.set(name, { rag, editor });
    return { ok: true, value: { rag, editor } };
  }
}
