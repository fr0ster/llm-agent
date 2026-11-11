# Migrating to v31: RAG collection isolation

This release changes public contracts in seven packages: `llm-agent`,
`llm-agent-libs`, `llm-agent-server-libs`, `llm-agent-server`, `pg-vector-rag`,
`hana-vector-rag`, and `qdrant-rag` (all under `@mcp-abap-adt`). Upgrade these
packages together. See [the threat model](SECURITY_THREAT_MODEL.md#as-6-cross-caller-access-through-the-rag-collection-tools).

## Before starting the upgraded application

1. Back up the catalog and vector data; stop application traffic and writers.
2. Rename existing collections named `history` or `tools` before upgrading.
   Both names are reserved in every scope, including user, session and role.
   Preserve their catalog ownership and associated records when renaming.
3. Run the appropriate exported migration once before starting the server:

   | Package | Migration | Persistent access stores |
   | --- | --- | --- |
   | `pg-vector-rag` | `migratePgVectorRagAccess(provider)` | `createPgVectorRagAccessStores(provider)` |
   | `hana-vector-rag` | `migrateHanaVectorRagAccess(provider)` | `createHanaVectorRagAccessStores(provider)` |
   | `qdrant-rag` | `migrateQdrantRagAccess(provider)` | `createQdrantRagAccessStores(provider)` |

   Each migration returns `Promise<Result<{ reported: readonly { storeName: string; reason: string }[] }, RagError>>`.
   Check `ok` and inspect every `value.reported` entry before admitting traffic.
   Migrations are idempotent and can be rerun after remediation; they are explicit
   startup prerequisites, not a promise that constructing a server migrates data.
4. Migrations create the access persistence and backfill a positive `ownerScope`
   tag and sole identity key from the collection catalog owner. Matching record
   identities are preserved; conflicts are tagged `invalid` (unmatched by scoped
   queries) and reported. Records without a catalog row retain metadata-based
   ownership and are reported. HANA and PostgreSQL read documents in bounded
   keyset batches. Rejected catalog owners and missing roles are reported too.
   Do not turn rejected data into global data. Resolve ownership administratively
   and rerun the migration.
5. Configure persistent role and binding stores from the same provider/catalog
   as the collections, plus the host's decision interface and trusted resolver.
   In-memory stores lose roles and bindings on restart.

For example, with an already configured PostgreSQL provider:

```ts
import {
  createPgVectorRagAccessStores,
  migratePgVectorRagAccess,
} from '@mcp-abap-adt/pg-vector-rag';

const migration = await migratePgVectorRagAccess(provider);
if (!migration.ok) throw migration.error;
if (migration.value.reported.length > 0) {
  throw new Error('Review RAG migration reports before startup');
}
const ragAccess = { ...createPgVectorRagAccessStores(provider), decision };
```

## Trusted caller and policy wiring

`SmartServerConfig` requires `callerResolver` and `ragAccess`. Missing dependencies
throw `ServerConfigError`. Supply them programmatically; YAML cannot authenticate
requests. `IRagCallerResolver.resolve(sessionId, headers)` returns
`Promise<Result<Omit<RagCaller, 'sessionId'>, RagAccessDeniedError>>`, where the
resolved value contains `userId` and `isAdmin`. Derive both from authenticated
server state, never a client-selected role or arbitrary identity header.

The cookie lifecycle supplies the session ID. SmartServer resolves the caller,
binds the session to its user in persistence, then acquires its graph. Rebinding
an existing session to another user is refused, including concurrent requests.
Resolver, binding and graph-acquisition failures refuse the request with HTTP 403.
There is no fallback session or shared user. A failure after a streaming response
starts terminates the response; it cannot replace an already sent HTTP status.

`RagAccess` contains `decision`, `roles`, and `bindings`. Implement
`IRagAccessDecision.canRead(caller, ref)` and `canWrite(caller, ref)` returning
`Promise<boolean>`. For every managed collection, access requires ownership AND
the decision. Roles come only from the library's assignments table. Admin status
does not bypass another owner's boundary. Global creation and writes require
both `caller.isAdmin` and a write decision. Decision failures deny access.

The `llm-agent` executable from `llm-agent-server` offers explicit local single-user mode:
pass `--local-user-id <userId>`. Without it the CLI refuses startup. This mode
uses test access helpers and is not for production. Production hosts must supply
the trusted resolver, real decision and persistent access stores via SmartServer.

## Builder and direct callers

Call `withRagAccess(ragAccess)` even when no custom collection is configured.
`build()` now returns `Promise<SmartAgentBuildResult>`, a `Result` containing the
handle or `BuilderConfigError | ReservedCollectionNameError`. Check `ok` before
using the handle; `unwrapBuilderResult` is exported for callers that propagate
configuration failures as exceptions. Other startup failures may still throw.

Every static `addRagCollection` needs explicit `meta.scope` and exactly the
matching owner identity:

```ts
const built = await builder
  .withRagAccess(ragAccess)
  .addRagCollection({
    name: 'notes',
    rag: notesRag,
    meta: { displayName: 'Notes', scope: 'user', userId },
  })
  .build();
if (!built.ok) throw built.error;
const handle = built.value;
```

Owners are a discriminated union: `{ scope: 'session', sessionId }`,
`{ scope: 'user', userId }`, `{ scope: 'role', roleId }`, or `{ scope: 'global' }`.
Session/user/role owners need their respective nonempty ID; globals carry no
private identity keys. Missing static scope no longer defaults to global.

Direct agent/pipeline calls must pass `CallOptions.caller` containing
`{ sessionId, userId, isAdmin }` from trusted host state. Direct pipeline calls
also require top-level `CallOptions.sessionId` equal to `caller.sessionId`;
`DefaultPipeline.execute` refuses missing or mismatched session IDs.
`DefaultPipeline.initialize` refuses missing `RagAccess` before installing stages;
every execute request requires a resolved caller, including requests without RAG.

```ts
const caller = { sessionId, userId, isAdmin: false };
const bound = await ragAccess.bindings.bind(caller.sessionId, caller.userId);
if (!bound.ok) throw bound.error;
const result = await pipeline.execute(
  input,
  [], // Message history for this call.
  { caller, sessionId: caller.sessionId },
  (chunk) => { /* Handle each Result<LlmStreamChunk, OrchestratorError>. */ },
);
```

Legacy `sessionId` or
`userId` options alone do not authenticate a call. Bind the session through
`ragAccess.bindings.bind` before direct use and handle refusal. The core checks
`bindings.getUserId(sessionId)`
before access or retrieval, including history. An unbound session, another bound
user, or a binding-store failure returns `RagAccessDeniedError`; reads never bind.
Custom `ISessionBindingStore` implementations must implement the read-only
`getUserId(sessionId): Promise<Result<string | undefined, RagError>>` method.
`ragFilter` cannot replace ownership or select another caller. Custom pipeline `ragStores` now carry
`{ name, rag, owner }` entries (`SmartAgentRagStores`) rather than bare stores;
provide `ragAccess` in the dependencies passed to `DefaultPipeline.initialize`.

Collection tool construction requires `RagCollectionToolOptions.caller` and
`RagCollectionToolOptions.access`. Bind both at construction; tool arguments and
`RagToolContext` are not identity sources. Admin tools are built only for trusted
admins, and non-admin direct calls are refused as unavailable tools. Hydration
and both retrieval paths recheck access; revocation hides a role collection on
the next request even in an existing session.

Built-in `history` is an implicit per-session store: its owner is the request's
session, never global. It requires a matching persisted session-to-user binding
and filters records by that session, but skips the server read decision. The internal `tools`
store bypasses the server decision while requiring a valid session binding
and is not a caller-managed collection. Neither name can be registered as a
custom collection. Copying history into a user collection may be a future feature;
it is not included in this release.

Registry-provided editors stamp `ownerScope` and the collection's sole owner ID
on every upsert, including add/correct/deprecate. Conflicting caller-supplied
owner keys are refused. Retain the editor returned by `registry.getEditor`;
it is an ownership wrapper and no longer preserves the original editor reference.
Library history writers use the same `stampRagOwner` function for record tags.
Low-level backend writers remain trusted storage primitives; direct integration
writers must stamp the recorded owner with `stampRagOwner(metadata, owner)`.

Coordinator, interpreter, context-builder, state-oracle and worker inputs now
carry the trusted `caller`; forward the same object through nested dispatch.
`ISubAgentInput.caller`, `ICoordinatorContext.caller`, `InterpretContext.caller`
and `DialogueSessionOptions.caller` are required. `TaskBoardOptions.caller` owns
every worker identity; base input cannot replace it. Controller diagnostic
options preserve the caller while excluding user generation settings.
Never rebuild a caller from a
session string. Tests can provision explicit bindings with
`testRagAccess([caller])`; an empty test access store is intentionally unbound.

## Backend behavior and operational limits

Every record carries a positive ownerScope tag; scoped queries require the
matching tag and identity before top-k and reject extra conflicting identity
keys. Globals require `ownerScope: 'global'` and no session/user/role ID. Custom
backends must honor the same contract; direct raw storage access remains the
host's responsibility.

Role deletion returns `RoleInUseError` while the role owns collections; it never
implicitly removes collections. PostgreSQL and HANA serialize deletion and role
collection creation with database row locks. Qdrant uses catalog intent followed
by active-role verification and an immutable revision-chain CAS; there is no
persistent lock or timeout/lease-based recovery. The Qdrant role revision chain
grows without compaction in this release. Follow the consistency requirements in
[its README](../packages/qdrant-rag/README.md#collection-access-persistence),
including Qdrant >= 1.17.0 for insert-only binding points; global filtering itself
has no exact-version restriction.

HANA scoped queries read all owner candidates before applying top-k in the
application, which can increase memory and latency for large owners. PostgreSQL
was exercised with PGlite; HANA and Qdrant were exercised with mocks/fakes only,
not live services. Validate those deployments against real infrastructure before
production rollout.

## Tests and embedded fixtures

Import `allowAllDecision()`, `fixedCallerResolver({ userId, isAdmin })`, and
`testRagAccess()` from
`@mcp-abap-adt/llm-agent/testing/rag-access-testing` for explicit test fixtures.
`testRagAccess()` provides process-local stores and an allowing decision; it is
not a production authorization policy or a catalog-aware role-deletion guard.
Pass the helpers explicitly to `withRagAccess` or SmartServer configuration.
`makeDefaultDeps` in `llm-agent-libs/testing` supplies test access for runtime
fixtures; production constructors do not inherit that convenience.

Backend implementers should run the exported shared suites in
`testing/rag-access-store-conformance`, `testing/rag-filter-conformance`, and
`testing/rag-migration-conformance`. They cover role ownership, global filtering,
creation/deletion races, idempotent migration and invalid-owner reporting.

## HANA HDI deployments

Before running the migration, include all five `hana-vector-rag/ddl/` artifacts
in the HDI db module: `RAG_COLLECTIONS.hdbtable`, `RAG_DOCUMENTS.hdbtable`,
`rag_roles.hdbtable`, `rag_role_assignments.hdbtable`, and
`rag_session_bindings.hdbtable`. Merge the shipped `.hdiconfig` table plugin entry
into the module configuration and deploy with the HDI deployer. Keep the quoted
lowercase access table names; adapt the catalog artifact for custom catalog names.
The catalog artifact already includes `role_id NVARCHAR(5000)`; document owner
tags live in `METADATA`, not a separate document `role_id` column. No standalone
index artifacts are needed by the runtime access schema.

Use the shared layout with `autoCreateSchema: false` for the runtime user.
`migrateHanaVectorRagAccess` checks the configured/current schema catalog and skips
CREATE/ALTER for existing tables and columns while still backfilling record owners.
Without predeployed objects it continues creating missing access persistence.
