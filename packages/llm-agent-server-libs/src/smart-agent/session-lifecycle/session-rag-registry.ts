import {
  checkRagAccess,
  type ILogger,
  type IRagProvider,
  type IRagProviderRegistry,
  type IRagRegistry,
  type RagAccess,
  RagAccessDeniedError,
  type RagCaller,
  type RagCollectionRef,
  reservedGlobalNameError,
  SimpleRagRegistry,
  validateRagOwner,
  visibleOwnerFilter,
} from '@mcp-abap-adt/llm-agent';
import type { SessionGraphIdentity } from '@mcp-abap-adt/llm-agent-libs';

export interface SessionRagRegistryInput {
  readonly caller: RagCaller;
  readonly ragAccess: RagAccess;
  readonly registry?: IRagRegistry;
  readonly identity: SessionGraphIdentity;
  /**
   * The deployment's registry. Only its `global` entries are seen, by
   * reference: a user or session entry there belongs to one caller.
   */
  readonly globals: IRagRegistry;
  /** Providers whose catalogs are read, and which the new registry creates through. */
  readonly providers?: IRagProviderRegistry;
  /** Where rejected catalog rows and failed reads are reported. */
  readonly logger?: ILogger;
  /**
   * Catalog findings already reported, keyed per provider and row. A rejected
   * row and a skipped global are facts about the catalog, not about a session,
   * so every session would repeat them; pass ONE set for the owner's lifetime
   * (`SmartServer` holds one) and each is logged once. Owned by the caller, so
   * two unrelated servers in one process never silence each other. Omitted,
   * every call reports everything. Failures to read or open are not deduped:
   * they may be transient, and each one matters.
   */
  readonly reported?: Set<string>;
}

/**
 * Hydrate only collections allowed by ownership and the server decision.
 * Supplying an existing registry refreshes visibility without replacing the
 * registry reference held by an open session and its workers. Role membership
 * is read again on every request; retrieval also checks access at execution.
 */
export async function buildSessionRagRegistry(
  input: SessionRagRegistryInput,
): Promise<IRagRegistry> {
  const { identity, caller, ragAccess, globals, providers, logger, reported } =
    input;
  if (
    identity.sessionId !== caller.sessionId ||
    identity.userId !== caller.userId
  ) {
    throw new Error('Hydration caller identity mismatch');
  }
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

  const registry = input.registry ?? new SimpleRagRegistry();
  if (providers && registry instanceof SimpleRagRegistry)
    registry.setProviderRegistry(providers);
  const memberships = await ragAccess.roles.rolesOf(caller.userId);
  if (!memberships.ok) throw memberships.error;
  const roles = await ragAccess.roles.listRoles();
  if (!roles.ok) throw roles.error;
  const visible = visibleOwnerFilter(caller, memberships.value);
  const canRead = async (ref: RagCollectionRef): Promise<boolean> => {
    let decisionFailed = false;
    const result = await checkRagAccess(caller, ref, 'read', {
      ...ragAccess,
      decision: {
        canRead: async (identity, collection) => {
          try {
            return await ragAccess.decision.canRead(identity, collection);
          } catch {
            decisionFailed = true;
            return false;
          }
        },
        canWrite: (identity, collection) =>
          ragAccess.decision.canWrite(identity, collection),
      },
    });
    if (decisionFailed)
      throw new RagAccessDeniedError('RAG read decision failed');
    return result.ok;
  };
  for (const meta of registry.list()) {
    if (meta.name === 'history' || meta.name === 'tools') continue;
    const owner = validateRagOwner(meta);
    if (
      !owner.ok ||
      !(await canRead({ name: meta.name, owner: owner.value }))
    ) {
      registry.unregister(
        meta.name,
        meta.scope,
        owner.ok ? owner.value : undefined,
      );
    }
  }

  // The deployment's globals, by reference. No providerName: the session does
  // not own them, so deleting the entry here must not reach their store.
  for (const meta of globals.list()) {
    if ((meta.scope ?? 'global') !== 'global') continue;
    if (!(await canRead({ name: meta.name, owner: { scope: 'global' } })))
      continue;
    if (registry.get(meta.name, 'global')) continue;
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
    let described: Awaited<
      ReturnType<NonNullable<IRagProvider['describeCollections']>>
    >;
    try {
      described = await provider.describeCollections();
    } catch (err) {
      warn(
        `rag_hydration_failed: provider '${providerName}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    if (!described.ok) {
      warn(
        `rag_hydration_failed: provider '${providerName}': ${described.error.message}`,
      );
      continue;
    }
    for (const row of described.value.rejected) {
      warnOnce(
        JSON.stringify(['rejected', providerName, row.storeName, row.reason]),
        `rag_catalog_row_rejected: provider '${providerName}'${
          row.storeName ? ` store '${row.storeName}'` : ''
        }: ${row.reason}`,
      );
    }
    for (const record of described.value.records) {
      const reserved = reservedGlobalNameError(record.scope, record.name);
      if (reserved) {
        warnOnce(
          JSON.stringify(['reserved', providerName, record.storeName]),
          `rag_catalog_row_rejected: provider '${providerName}' store '${record.storeName}': ${reserved.name}: ${reserved.message}`,
        );
        continue;
      }
      if (
        record.scope === 'role' &&
        !roles.value.some((role) => role.roleId === record.roleId)
      ) {
        warnOnce(
          JSON.stringify(['missing-role', providerName, record.storeName]),
          `rag_catalog_row_rejected: provider '${providerName}' store '${record.storeName}': missing role '${record.roleId}'`,
        );
        continue;
      }
      const owner = validateRagOwner(record);
      if (!owner.ok || !visible(owner.value)) continue;
      if (!(await canRead({ name: record.name, owner: owner.value }))) continue;
      if (
        input.registry &&
        registry.get(record.name, record.scope, owner.value)
      )
        continue;
      if (record.scope === 'global' && registry.get(record.name, 'global')) {
        warnOnce(
          JSON.stringify(['skipped', providerName, record.storeName]),
          `rag_hydration_skipped: provider '${providerName}' global '${record.name}' (store '${record.storeName}') is already configured by the deployment`,
        );
        continue;
      }
      let opened: Awaited<
        ReturnType<NonNullable<IRagProvider['openCollection']>>
      >;
      try {
        opened = await provider.openCollection(record);
      } catch (err) {
        warn(
          `rag_hydration_open_failed: provider '${providerName}' store '${record.storeName}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      if (!opened.ok) {
        warn(
          `rag_hydration_open_failed: provider '${providerName}' store '${record.storeName}': ${opened.error.message}`,
        );
        continue;
      }
      try {
        registry.adopt?.(
          record,
          opened.value.rag,
          opened.value.editor,
          providerName,
        );
      } catch (err) {
        warn(
          `rag_hydration_adopt_failed: provider '${providerName}' store '${record.storeName}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
  return registry;
}
