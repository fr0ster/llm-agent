import {
  type ILogger,
  type IRagProvider,
  type IRagProviderRegistry,
  type IRagRegistry,
  type RagCollectionRecord,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import type { SessionGraphIdentity } from '@mcp-abap-adt/llm-agent-libs';
import { SimpleRagRegistry } from '@mcp-abap-adt/llm-agent-rag';

export interface SessionRagRegistryInput {
  readonly identity: SessionGraphIdentity;
  /**
   * The deployment's registry. Only its `global` entries are seen, by
   * reference: a user or session entry there belongs to one caller.
   */
  readonly globals: IRagRegistry;
  /** Providers whose catalogs are read, and which the new registry creates through. */
  readonly providers?: IRagProviderRegistry;
  /** Where rejected catalog rows and skipped globals are reported. */
  readonly logger?: ILogger;
  /**
   * Catalog findings already reported, keyed per provider and row. A rejected
   * row and a skipped global are facts about the catalog, not about a session,
   * so every session would repeat them; pass ONE set for the owner's lifetime
   * (`SmartServer` holds one) and each is logged once. Owned by the caller, so
   * two unrelated servers in one process never silence each other. Omitted,
   * every call reports everything. A failure to describe, open or adopt is
   * not reported here: it fails the session's creation (spec §10.5.9 V1).
   */
  readonly reported?: Set<string>;
}

/**
 * The registry one session owns (§6.4): the deployment's globals, plus what the
 * providers' catalogs hold for this identity — its own `user` and `session`
 * collections and the catalogued globals. Nothing is created, no schema is
 * ensured and no catalog row is written: describeCollections, then
 * openCollection and adopt for each record kept (§6.3). This server holds no
 * policy of its own, so every catalogued global is kept; a consumer that
 * decides which globals a caller may reach reads the record's attributes here.
 *
 * A catalog that cannot be read, or a collection of this identity that cannot
 * be opened or adopted, rejects with its `RagError` (spec §10.5.9 V1): the
 * session is not created without it.
 *
 * The globals are copied in ONCE, when the session is created: a global added
 * to the deployment registry afterwards is not seen by a session already
 * built (it is seen by the next session `buildSessionRagRegistry` builds).
 */
export async function buildSessionRagRegistry(
  input: SessionRagRegistryInput,
): Promise<IRagRegistry> {
  const { identity, globals, providers, logger, reported } = input;
  const warn = (message: string) =>
    logger?.log({
      type: 'warning',
      traceId: `session:${identity.sessionId}`,
      message,
    });
  /** Warn about a catalog finding once per `reported` set. */
  const warnOnce = (key: string, message: string) => {
    if (reported) {
      if (reported.has(key)) return;
      reported.add(key);
    }
    warn(message);
  };

  const registry = new SimpleRagRegistry();
  if (providers) registry.setProviderRegistry(providers);

  // The deployment's globals, by reference. No providerName: the session does
  // not own them, so deleting the entry here must not reach their store.
  for (const meta of globals.list()) {
    if ((meta.scope ?? 'global') !== 'global') continue;
    const rag = globals.get(meta.name, 'global');
    if (!rag) continue;
    registry.register(meta.name, rag, globals.getEditor(meta.name, 'global'), {
      displayName: meta.displayName,
      description: meta.description,
      scope: 'global',
      tags: meta.tags,
    });
  }

  if (!providers) return registry;
  for (const providerName of providers.listProviders()) {
    const provider = providers.getProvider(providerName);
    if (!provider?.describeCollections || !provider.openCollection) continue;
    // Spec §10.5.9 V1: a persisted collection that cannot be described,
    // opened or adopted fails the session's creation — never a session that
    // silently lacks it.
    let described: Awaited<
      ReturnType<NonNullable<IRagProvider['describeCollections']>>
    >;
    try {
      described = await provider.describeCollections();
    } catch (err) {
      throw hydrationError(err, `provider '${providerName}': describe`);
    }
    if (!described.ok) throw described.error;
    for (const row of described.value.rejected) {
      warnOnce(
        JSON.stringify(['rejected', providerName, row.storeName, row.reason]),
        `rag_catalog_row_rejected: provider '${providerName}'${
          row.storeName ? ` store '${row.storeName}'` : ''
        }: ${row.reason}`,
      );
    }
    for (const record of described.value.records) {
      if (!belongsTo(record, identity)) continue;
      if (record.scope === 'global' && registry.get(record.name, 'global')) {
        warnOnce(
          JSON.stringify(['skipped', providerName, record.storeName]),
          `rag_hydration_skipped: provider '${providerName}' global '${record.name}' (store '${record.storeName}') is already configured by the deployment`,
        );
        continue;
      }
      const where = `provider '${providerName}' collection '${record.name}' (store '${record.storeName}')`;
      let opened: Awaited<
        ReturnType<NonNullable<IRagProvider['openCollection']>>
      >;
      try {
        opened = await provider.openCollection(record);
      } catch (err) {
        throw hydrationError(err, `${where}: open`);
      }
      if (!opened.ok) throw opened.error;
      try {
        registry.adopt(
          record,
          opened.value.rag,
          opened.value.editor,
          providerName,
        );
      } catch (err) {
        throw hydrationError(err, `${where}: adopt`);
      }
    }
  }
  return registry;
}

/**
 * A failure thrown while hydrating: a `RagError` is the component's own typed
 * error and goes through unchanged (it names its collection); anything else
 * becomes a `RagError` naming where it failed, the original as its `cause`.
 */
function hydrationError(err: unknown, where: string): RagError {
  if (err instanceof RagError) return err;
  const wrapped = new RagError(
    `session RAG hydration failed — ${where}: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
  wrapped.cause = err;
  return wrapped;
}

function belongsTo(
  record: RagCollectionRecord,
  identity: SessionGraphIdentity,
): boolean {
  switch (record.scope) {
    case 'global':
      return true;
    case 'user':
      return identity.userId !== undefined && record.userId === identity.userId;
    case 'session':
      return record.sessionId === identity.sessionId;
  }
}
