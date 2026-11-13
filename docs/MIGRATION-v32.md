# Migrating to v32: collection roles

Version 32 of `@mcp-abap-adt/llm-agent` separates ownership and role-based access.
Upgrade the affected runtime and backend packages together using their major releases.

## Contracts

`RagCollectionOwner` is now exactly:

```ts
type RagCollectionOwner =
  | { readonly scope: 'session'; readonly sessionId: string }
  | { readonly scope: 'user'; readonly userId: string }
  | { readonly scope: 'global' };
```

The role owner kind and `roleId` record identity filter are removed. There is no
compatibility alias for the old combined role store.

```ts
interface IRagRoleCheck {
  rolesOf(userId: string): Promise<Result<ReadonlySet<string>, RagError>>;
  collectionRoles(collectionName: string): Promise<Result<ReadonlySet<string>, RagError>>;
}
interface IRagRoleAdmin {
  listRoles(): Promise<Result<readonly RagRole[], RagError>>;
  createRole(role: RagRole): Promise<Result<RagRole, RagError>>;
  deleteRole(roleId: string): Promise<Result<void, RagError>>;
  assign(userId: string, roleId: string): Promise<Result<void, RagError>>;
  revoke(userId: string, roleId: string): Promise<Result<void, RagError>>;
  bindCollection(collectionName: string, roleId: string): Promise<Result<void, RagError>>;
  unbindCollection(collectionName: string, roleId: string): Promise<Result<void, RagError>>;
}
```

`RagAccess` contains `decision: IRagAccessDecision`, `roles: IRagRoleCheck`, and
`bindings: ISessionBindingStore`. The core never manages roles. Hosts can implement
these contracts using their own identity system, or use a backend's internally
consistent implementation. `testRagAccess()` exposes `roleAdmin` separately.

## Host wiring

```ts
const migration = await migratePgVectorRagAccess(provider);
if (!migration.ok) throw migration.error;
for (const finding of migration.value.reported) reportForResolution(finding);
const { roles, roleAdmin, bindings } = createPgVectorRagAccessStores(provider);
const ragAccess = { decision, roles, bindings };
// Supply ragAccess to the builder/server. Retain roleAdmin in trusted admin tooling.
await roleAdmin.createRole({ roleId: 'reviewers', name: 'Reviewers' });
await roleAdmin.assign('reader-user-id', 'reviewers');
// Create docs with an explicit owner first, then bind it.
await roleAdmin.bindCollection('docs', 'reviewers');
```

HANA uses `createHanaVectorRagAccessStores` and `migrateHanaVectorRagAccess`.
Qdrant uses `createQdrantVectorRagAccessStores` and `migrateQdrantVectorRagAccess`.
All factories return `{ roles, roleAdmin, bindings }` over the same persistence.
Admin MCP tooling now requires an explicit `roleAdmin` argument; role tools can
bind and unbind collections instead of creating role-owned collections.
The local single-user CLI remains explicit process-local test access.

## Access and retrieval

The caller must match the owner or hold a role in the intersection of `rolesOf`
and `collectionRoles`, then pass `decision.canRead` or `decision.canWrite`.
Errors deny access. Every global read requires the read decision; creating or
writing global data also requires `caller.isAdmin`. Admin status never bypasses
another owner's boundary. Revocation and unbinding affect the next request,
including hydration and both retrieval paths. Retrieval always filters records
by the collection owner before top-k; sharing does not change record ownership.

Delete a role only after revoking all user assignments and removing every
collection binding; otherwise the backend returns `RoleInUseError`. Binding a
missing role or collection fails. PG/HANA serialize binding against deletion
with role row locks. Collection deletion locks the catalog row and removes its
role bindings in the same transaction, for both SQL layouts. Qdrant uses
persisted intents, role generations and revision CAS. Its collection deletion
marker identifies a catalog write generation; reads check both role and collection
generations, and delayed bindings compensate only their own generation. Deleting
and recreating a collection does not restore its previous role grants.
Qdrant removes the catalog record, data, and role bindings in that order.
Deleting the same Qdrant collection from two processes concurrently is not
supported; run deletions from one process. Retries, including from a new provider
after a crash, are safe. Existing owner handles and global readers may continue
reading during deletion until data removal, subject to the host decision.

Collection bindings use the logical collection name within the access store;
hosts must use the same name when administering and checking collection access.

## Migration and administrative reports

Run the backend migration before serving requests, inspect its `Result`, and
review every `value.reported` finding. Migrations create `rag_collection_roles`
with `(collection_name, role_id)` identity alongside existing role, assignment,
and session binding persistence. Repeating a migration is safe.

Legacy catalog rows whose scope is role are rejected by catalog reads and
reported. Their owner is not converted. Records with `ownerScope: 'role'` and
data under rejected catalog owners are reported and left unchanged. Do not
relabel them global: global data can be read by everyone subject to the host
decision. Administrators must choose an explicit session/user owner, repair the
record identities consistently, and bind the intended roles. Back up the data
before this application-specific repair. Migration never guesses the new owner.

## HANA HDI deployment

Deploy all eight artifacts (six tables and two foreign keys) from `hana-vector-rag/ddl`:

- `RAG_DOCUMENTS.hdbtable`
- `RAG_COLLECTIONS.hdbtable`
- `rag_roles.hdbtable`
- `rag_role_assignments.hdbtable`
- `rag_collection_roles.hdbtable`
- `rag_session_bindings.hdbtable`
- `rag_role_assignments_role_fk.hdbconstraint`
- `rag_collection_roles_role_fk.hdbconstraint`

Merge the shipped `.hdiconfig` table and constraint plugins into the db module configuration.

The required `.hdiconfig` entries are:

```json
{
  "file_suffixes": {
    "hdbtable": { "plugin_name": "com.sap.hana.di.table" },
    "hdbconstraint": { "plugin_name": "com.sap.hana.di.constraint" }
  }
}
```

Foreign keys are separate artifacts because HDI tables cannot reference other
objects. The quoted lowercase table names and uppercase `"ROLE_ID"` columns
match the runtime schema, where unquoted `role_id` becomes `ROLE_ID`.

Keep the quoted lowercase access table names. Adapt the catalog artifact when
customizing its name. The migration skips DDL when a table already exists,
including HDI-managed `rag_collection_roles`, then performs the data checks.
