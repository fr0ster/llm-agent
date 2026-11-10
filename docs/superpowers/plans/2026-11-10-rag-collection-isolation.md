# RAG Collection Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The library isolates every RAG collection (session, user, role and global) through one owner model and one enforcement path. The consumer server only makes the permission decisions.

**Architecture:**
- A new access core in `llm-agent` defines:
  - the caller (`RagCaller`);
  - the server's decision interface (`IRagAccessDecision`);
  - the role and session-binding stores;
  - one check, `checkRagAccess`, which applies ownership AND the server's decision.
- Every path that touches a collection calls that check. That covers the collection tools, the admin tools, both retrieval paths, session-registry hydration and the builder's store projection.
- Backends persist roles, assignments and session bindings next to their collection catalog. A one-time, idempotent migration adds what existing deployments lack.

**Tech Stack:**
- TypeScript monorepo.
- `node:test` run through tsx, with `node:assert/strict`.
- biome.
- Changesets.

**Spec:** `docs/superpowers/specs/2026-11-10-rag-collection-isolation-design.md`

## Global Constraints

- **Static typing.** No `any` or `unknown`, except a narrowed caught error. No `as unknown as`, no `as never`. Owners and identities are discriminated unions.
- **No timeouts in work paths.** Concurrency tests use controlled promises or barriers, never sleeps.
- **Fail closed.** A missing resolver, a missing decision interface or a missing caller refuses. So does a decision call that throws or resolves to an error. Nothing is served.
- **No implicit fallback** to another session, another user or a shared identity. `options?.sessionId ?? 'default'` is removed.
- **Roles come only from the library's assignments table,** never from the request, the prompt or a tool argument.
- **The server decision only narrows access.** Access = ownership check AND decision. Global writes and global creation require `caller.isAdmin` AND the decision.
- **Release.** Breaking changes ship as major versions (changesets `major`) of:
  - `@mcp-abap-adt/llm-agent`, `llm-agent-libs`, `llm-agent-server-libs`, `llm-agent-server`;
  - `pg-vector-rag`, `hana-vector-rag`, `qdrant-rag`.
- **Commands:**
  - tests: `npm test -w packages/<pkg>`;
  - full: `npm run build && npm run typecheck && npm run lint:check && npm test`.

## Review Focus

1. **A role revoked while a session is open.** The next request must not see the role collection, including collections already adopted into that session's registry. The test lives in Task 8.
2. **The same collection name in `user` and `role` scope.** A call without an explicit scope returns `AmbiguousCollectionError`, never the first match. The test lives in Task 3.
3. **A catalog row with `scope: 'role'` whose role was deleted out of band.** Hydration skips it and reports it, and it is never exposed. The test lives in Task 8.
4. **The server decision throws.** The request is refused with `RagAccessDeniedError`, and the throw does not propagate as a crash. The test lives in Task 2.
5. **Two concurrent first requests for one `sessionId` with different `userId`s.** Exactly one binds and the other is refused, also across two binding-store instances sharing one backend. The test lives in Task 7.

---

### Task 1: Owner model with `role`, caller and access interfaces

**Files:**
- Modify:
  - `packages/llm-agent/src/interfaces/rag.ts:223-251` (scope and owner unions, `RagCollectionMeta`)
  - `packages/llm-agent/src/interfaces/plugin.ts:32` (`RagScope`)
  - `packages/llm-agent/src/rag/catalog/validation.ts:82,122,145,168`
  - `packages/llm-agent/src/rag/registry/store-key.ts`
  - `packages/llm-agent/src/rag/registry/simple-rag-registry.ts:47-75`
- Create:
  - `packages/llm-agent/src/interfaces/rag-access.ts`
- Test:
  - `packages/llm-agent/src/rag/__tests__/rag-owner-role.test.ts`
  - `packages/llm-agent/src/interfaces/__typechecks__/rag-access.typecheck.ts`

**Interfaces:**
- Produces, in `rag.ts`:
  - `RagCollectionScope = 'session' | 'user' | 'role' | 'global'`
  - `RagCollectionOwner` gains `| { readonly scope: 'role'; readonly roleId: string }`
  - `RagCollectionMeta` gains `roleId?: string`
- Produces, in `rag-access.ts`:
  - `interface RagCaller { readonly sessionId: string; readonly userId: string; readonly isAdmin: boolean }`
  - `interface RagCollectionRef { readonly name: string; readonly owner: RagCollectionOwner }`
  - `type RagAccessMode = 'read' | 'write'`
  - `interface IRagAccessDecision { canRead(caller: RagCaller, ref: RagCollectionRef): Promise<boolean>; canWrite(caller: RagCaller, ref: RagCollectionRef): Promise<boolean> }`
  - `interface RagRole { readonly roleId: string; readonly name: string; readonly description?: string }`
  - `interface IRagRoleStore`:
    - `listRoles(): Promise<Result<readonly RagRole[], RagError>>`
    - `createRole(role: RagRole): Promise<Result<RagRole, RagError>>`
    - `deleteRole(roleId: string): Promise<Result<void, RagError>>`
    - `assign(userId: string, roleId: string): Promise<Result<void, RagError>>`
    - `revoke(userId: string, roleId: string): Promise<Result<void, RagError>>`
    - `rolesOf(userId: string): Promise<Result<ReadonlySet<string>, RagError>>`
  - `interface ISessionBindingStore { bind(sessionId: string, userId: string): Promise<Result<void, SessionBindingConflictError | RagError>> }`. It is idempotent for the same pair and refuses a different `userId`.
  - `interface IRagCallerResolver { resolve(sessionId: string, headers: Readonly<Record<string, string | readonly string[] | undefined>>): Promise<Result<Omit<RagCaller, 'sessionId'>, RagAccessDeniedError>> }`
  - `interface RagAccess { readonly decision: IRagAccessDecision; readonly roles: IRagRoleStore; readonly bindings: ISessionBindingStore }`
  - Error classes `RagAccessDeniedError` and `SessionBindingConflictError`, both extending `RagError`. `RoleInUseError` extends `RagError`.

- [ ] **Step 1: Write the failing tests.**
  - `validateRagOwner({ scope: 'role', roleId: 'abap-team' })` returns `{ ok: true, value: { scope: 'role', roleId: 'abap-team' } }`.
  - `validateRagOwner({ scope: 'role' })` returns `ok: false`.
  - `ragStoreKey({ name: 'docs', scope: 'role', roleId: 'r1' })` returns `'role/docs'`.
  - `reservedGlobalNameError('global', 'role/x')` is an error.
  - `storeNameFor` differs for `{scope:'role', roleId:'a'}` and `{scope:'role', roleId:'b'}` with the same `collectionName`.
  - `parseRagCollectionRecord({ storeName:'s', name:'n', scope:'role', roleId:'r1' })` returns a role record. Without `roleId` it is rejected.
  - In `SimpleRagRegistry`, two role collections with the same name and different `roleId` can both be created. `keyOf` includes the owner for the role scope.
  - Typecheck: a `RagCollectionOwner` switch without a `'role'` case fails `tsc`.
- [ ] **Step 2: Run them and confirm they fail.**
  Run: `npm test -w packages/llm-agent`. Expected: FAIL on the role cases.
- [ ] **Step 3: Implement the unions, validation, `RagCatalogRow.roleId`, the store key prefix `role/` and the `rag-access.ts` types.** Export them from `packages/llm-agent/src/index.ts`. Fix every exhaustive switch that `tsc -b` reports.
- [ ] **Step 4: Run the tests and confirm they pass.** Also run `npm run build && npm run typecheck`.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -S -m "feat(rag)!: role owner scope and access interfaces"
  ```

### Task 2: Access core and in-memory stores

**Files:**
- Create:
  - `packages/llm-agent/src/rag/access/check-access.ts`
  - `packages/llm-agent/src/rag/access/in-memory-role-store.ts`
  - `packages/llm-agent/src/rag/access/in-memory-session-binding-store.ts`
  - `packages/llm-agent/src/testing/rag-access-testing.ts`, exported as `./testing/rag-access-testing`
  - `packages/llm-agent/src/testing/rag-access-store-conformance.ts`
- Test:
  - `packages/llm-agent/src/rag/__tests__/check-access.test.ts`
  - `packages/llm-agent/src/rag/__tests__/rag-access-store-conformance.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `checkRagAccess(caller: RagCaller, ref: RagCollectionRef, mode: RagAccessMode, access: RagAccess): Promise<Result<void, RagAccessDeniedError>>`. The ownership rules:
    - session: `owner.sessionId === caller.sessionId`;
    - user: `owner.userId === caller.userId`;
    - role: `roleId ∈ rolesOf(caller.userId)`;
    - global read: always owned;
    - global write: `caller.isAdmin`.

    After ownership passes, it asks the decision. A throw or a role-store error means deny.
  - `visibleOwnerFilter(caller: RagCaller, roles: ReadonlySet<string>): (owner: RagCollectionOwner) => boolean`
  - `class InMemoryRagRoleStore implements IRagRoleStore`. `deleteRole` takes `isRoleInUse: (roleId) => boolean` in its constructor and returns `RoleInUseError` when the role still owns collections.
  - `class InMemorySessionBindingStore implements ISessionBindingStore`
  - Testing helpers:
    - `allowAllDecision(): IRagAccessDecision`
    - `fixedCallerResolver(caller: Omit<RagCaller,'sessionId'>): IRagCallerResolver`
    - `testRagAccess(): RagAccess`
  - `ragAccessStoreConformanceCases`, with one `{ name; run(make: () => Promise<{ roles: IRagRoleStore; bindings: ISessionBindingStore }>) }` per case. Later tasks run it against every backend.

- [ ] **Step 1: Write the failing tests** (spec acceptance tests 1–3, 12 and 13, Review Focus 4).
  - Same user, sessions s1 and s2: s1 reads its own session collection; s2 is denied it. Both read the user collection of `u1`.
  - User `u2` is denied `u1`'s user collection.
  - A role collection `r1`:
    - is denied before `assign('u1','r1')`;
    - is allowed after the assignment;
    - is denied again after `revoke`.
  - `allowAllDecision` never opens another owner's collection (test 12).
  - A global write by a non-admin is denied; by an admin with an allowing decision it is allowed (test 13).
  - A decision that throws `new Error('boom')` returns `{ ok:false }` with `RagAccessDeniedError`.
  - Conformance cases:
    - `bind('s','u1')` twice is ok;
    - `bind('s','u2')` returns `SessionBindingConflictError`;
    - `Promise.all([bind('s','u1'), bind('s','u2')])` gives exactly one ok;
    - `deleteRole` of a role in use returns `RoleInUseError`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit.**
  ```bash
  git commit -S -m "feat(rag): access check with ownership and server decision"
  ```

### Task 3: Collection tools on caller and access

**Files:**
- Modify: `packages/llm-agent/src/rag/mcp-tools/rag-collection-tools.ts` (identity `:27`, options `:54`, `addressable` `:94-102`, `resolve` `:108-139`, `resolveEditor` `:141-160`, delete `:294-308`, create `:346-406`)
- Test:
  - `packages/llm-agent/src/rag/__tests__/rag-collection-tools.test.ts`
  - `packages/llm-agent/src/rag/__tests__/rag-collection-tools-identity.test.ts`
  - `packages/llm-agent/src/rag/__tests__/rag-tool-identity.typecheck.ts`

**Interfaces:**
- Consumes: `RagCaller`, `RagAccess` and `checkRagAccess`.
- Produces: `RagCollectionToolOptions { registry; caller: RagCaller; access: RagAccess; providerRegistry?; attributesFor? }`. This replaces `identity`, and `RagCallerIdentity` is removed. Every handler calls `checkRagAccess`:
  - `read` for list/describe;
  - `write` for add/correct/deprecate/delete.

  `scopeArg` becomes `z.enum(['session','user','role','global'])` with an optional `roleId`. Listing shows only collections that pass `read`.

- [ ] **Step 1: Write the failing tests** (acceptance tests 4 and 7, Review Focus 2).
  - With a decision that denies `write` for collection `c`, `rag_add` on `c` returns an error containing `RagAccessDeniedError` and the store is unchanged.
  - With a decision that denies `read`, `rag_list_collections` omits `c`.
  - A `sessionId`, `userId` or `roleId` passed in tool args never changes the owner used. Args with `sessionId:'other'` act on the caller's own session.
  - A user collection `docs` and a role collection `docs` with the caller assigned to the role: `rag_describe_collection {name:'docs'}` returns `AmbiguousCollectionError`.
  - A global `rag_add` by a non-admin is refused; by an admin it succeeds.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Drop the hard-coded "Global collections cannot be modified/deleted via MCP" rule; the access check replaces it.
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit.**
  ```bash
  git commit -S -m "feat(rag)!: collection tools enforce access for every scope"
  ```

### Task 4: Admin tools

**Files:**
- Create: `packages/llm-agent/src/rag/mcp-tools/rag-admin-tools.ts`, exported from `mcp-tools/index.ts`
- Test: `packages/llm-agent/src/rag/__tests__/rag-admin-tools.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2 types. `rag_create_collection` from Task 3.
- Produces: `buildRagAdminToolEntries(opts: { caller: RagCaller; access: RagAccess; registry: IRagRegistry; providerRegistry: IRagProviderRegistry }): RagToolEntry[]`.
  - It returns `[]` when `!caller.isAdmin`.
  - For an admin it returns:
    - `rag_role_list`, `rag_role_create`, `rag_role_delete`;
    - `rag_role_assign`, `rag_role_revoke`;
    - `rag_create_shared_collection` with `{ providerName, collectionName, scope: 'role' | 'global', roleId? }`.

- [ ] **Step 1: Write the failing tests** (acceptance tests 9 and 10).
  - For a non-admin, `buildRagAdminToolEntries` returns length 0.
  - For an admin it returns the six names above, in that order.
  - `rag_role_delete` of a role owning a collection returns `RoleInUseError` and the role still exists.
  - `rag_create_shared_collection` with `scope:'role'` and an unknown `roleId` is refused.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** The `isRoleInUse` check reads `registry.list()` for `scope:'role'` with that `roleId`.
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit.**
  ```bash
  git commit -S -m "feat(rag): admin-only role and shared collection tools"
  ```

### Task 5: Owner-bound retrieval on both paths

**Files:**
- Create: `packages/llm-agent-libs/src/rag/owner-bound-query.ts`
- Modify:
  - `packages/llm-agent/src/interfaces/types.ts:29-72` (`CallOptions.caller?: RagCaller`)
  - `packages/llm-agent-libs/src/pipeline/handlers/rag-query.ts:74-97`
  - `packages/llm-agent-libs/src/agent/rag-orchestrator.ts:145,276`
  - `packages/llm-agent-libs/src/agent/rag-orchestrator-types.ts:42`
  - `packages/llm-agent-libs/src/pipeline/default-pipeline.ts:340-372,487`
  - `packages/llm-agent-libs/src/interfaces/pipeline.ts:59`
- Test:
  - `packages/llm-agent-libs/src/rag/__tests__/owner-bound-query.test.ts`
  - `packages/llm-agent-libs/src/pipeline/__tests__/default-pipeline-isolation.test.ts`

**Interfaces:**
- Consumes: `checkRagAccess` and `RagAccess`.
- Produces:
  - `interface OwnedRagStore { readonly name: string; readonly owner: RagCollectionOwner | { readonly scope: 'internal' }; readonly rag: IRag }`
  - `ragStores` in `PipelineDeps` and `RagOrchestratorDeps` become `Record<string, OwnedRagStore>`.
  - `ownerBoundQuery(store: OwnedRagStore, embedding: IQueryEmbedding, k: number, options: CallOptions, access: RagAccess): Promise<Result<RagResult[], RagError>>`:
    - It requires `options.caller`; it returns `RagAccessDeniedError` without one.
    - It runs `checkRagAccess(read)` for non-internal stores.
    - It rejects with `RagAccessDeniedError` when `options.ragFilter` carries a `sessionId`, `userId` or `roleId` different from the caller's.
    - It sets the identity filter from the store owner: `history` gets `sessionId`; a shared store tagged per record gets the owner keys.
  - Both retrieval paths call only `ownerBoundQuery`.

- [ ] **Step 1: Write the failing tests** (acceptance tests 5, 6 and 7).
  - One shared in-memory store holds records tagged `{sessionId:'A'}` and `{sessionId:'B'}`, registered as session-owned for A. A query as caller A returns only A's records, through both `RagQueryHandler` and `RagOrchestrator.orchestrate`.
  - A query without `options.caller` returns `ok:false` (`RagAccessDeniedError`) on both paths.
  - `ragFilter: { sessionId: 'B' }` as caller A is rejected.
  - `DefaultPipeline` without `options.sessionId` refuses. There is no `'default'`. Assert the error and that no store `query` was called (spy).
  - The `tools` store (`scope:'internal'`) is queried for any caller without a decision call (spy on `canRead`: 0 calls).
- [ ] **Step 2: Run them and confirm they fail.** Run: `npm test -w packages/llm-agent-libs`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit.**
  ```bash
  git commit -S -m "feat(pipeline)!: owner-bound retrieval, no default session"
  ```

### Task 6: Builder requires access and explicit owners

**Files:**
- Modify:
  - `packages/llm-agent-libs/src/builder.ts:284-335,948-1090,1333`
  - `packages/llm-agent-libs/src/builder-types.ts:48`
- Test: `packages/llm-agent-libs/src/__tests__/builder-rag-access.test.ts`

**Interfaces:**
- Consumes: `RagAccess`, `OwnedRagStore` and `ownerBoundQuery`.
- Produces:
  - `SmartAgentBuilder.withRagAccess(access: RagAccess): this`.
  - `build()` returns `{ ok:false }` with `BuilderConfigError('ragAccess is required')` when `withRagAccess` was not called.
  - `addRagCollection` requires `meta.scope`, plus `sessionId`, `userId` or `roleId` as the scope needs. Without them `build()` fails with `BuilderConfigError`.
  - `tools` is projected as `{scope:'internal'}`, and `history` as session-owned. The projection produces `OwnedRagStore`s.

- [ ] **Step 1: Write the failing tests** (acceptance test 15 for the builder).
  - `new SmartAgentBuilder().build()` without `withRagAccess` fails with the message `ragAccess is required`.
  - `addRagCollection({ name:'x', rag })` without `meta.scope` fails the build.
  - A built handle's `ragStores.tools.owner.scope === 'internal'` and `ragStores.history.owner.scope === 'session'`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Update every in-repo builder call site and test fixture to call `withRagAccess(testRagAccess())`.
- [ ] **Step 4: Run all of `llm-agent-libs`, then `npm run build && npm run typecheck`.**
- [ ] **Step 5: Commit.**
  ```bash
  git commit -S -m "feat(builder)!: require RAG access and explicit collection owners"
  ```

### Task 7: Backends: role, assignment and binding persistence, migration

**Files:**
- Create, per backend (`pg-vector-rag`, `hana-vector-rag`, `qdrant-rag`): `src/access-stores.ts`, `src/migrate-access.ts`
- Modify:
  - the catalog files: `pg-vector-rag/src/catalog.ts:7-48`, `hana-vector-rag/src/catalog.ts`, `qdrant-rag/src/qdrant-rag-provider.ts:410-418`
  - the providers' `describeCollections` and `openCollection`, which read and write `role_id`
- Test: each backend's `src/__tests__/rag-access-store-conformance.test.ts`, plus `src/__tests__/migrate-access.test.ts`

**Interfaces:**
- Consumes: `IRagRoleStore`, `ISessionBindingStore` and `ragAccessStoreConformanceCases`.
- Produces, per backend:
  - `create<Backend>RagAccessStores(provider): { roles: IRagRoleStore; bindings: ISessionBindingStore }`
  - `migrate<Backend>RagAccess(provider): Promise<Result<{ reported: readonly { storeName: string; reason: string }[] }, RagError>>`. It runs idempotently:
    - it adds a `role_id` column or payload key to the catalog;
    - it creates the `rag_roles`, `rag_role_assignments` and `rag_session_bindings` tables or collections;
    - it reports catalog rows whose owner fails `validateRagOwner`.
  - Binding uniqueness:
    - PG and HANA: a primary key on `session_id`, insert-or-compare in one statement or transaction;
    - Qdrant: the point id derived from `sessionId`, with a compare after the write.

- [ ] **Step 1: Write the failing tests** (acceptance tests 11 and 14, Review Focus 5).
  - Each backend runs `ragAccessStoreConformanceCases`. Run PG with pglite (`npm run test:integration:sql-shared:pg`), Qdrant against its existing integration target, and HANA in its existing test style.
  - Two binding-store instances on one backend: concurrent `bind('s','u1')` and `bind('s','u2')` give exactly one ok.
  - Migration:
    - on a catalog created by the current release (fixture DDL), `migrate` succeeds;
    - existing records keep their owner;
    - a second `migrate` returns the same result and changes nothing (compare the row count and schema);
    - a row with `scope:'user'` and no `user_id` is in `reported` and is not returned by `describeCollections().records`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass,** per backend test and integration scripts.
- [ ] **Step 5: Commit, one commit per backend.**
  ```bash
  git commit -S -m "feat(pg-vector-rag)!: role and session-binding persistence with migration"
  ```

### Task 8: SmartServer caller identity and hydration

**Files:**
- Modify:
  - `packages/llm-agent-libs/src/session/session-registry.ts:62-91` (`acquire(identity: SessionGraphIdentity & { userId: string })`)
  - `packages/llm-agent-libs/src/session/session-graph-factory.ts:21-32` (`userId` required; `SessionAgentParts.caller: RagCaller`)
  - `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts:147-316`
  - `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/session-rag-registry.ts:47-173`
  - `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts:1747-1754,1862,3026,3095-3117`
  - the SmartServer config type
- Test:
  - `packages/llm-agent-server-libs/src/smart-agent/__tests__/smart-server-rag-identity.test.ts`
  - `session-rag-registry.test.ts`

**Interfaces:**
- Consumes: `IRagCallerResolver`, `RagAccess`, `ISessionBindingStore`, `checkRagAccess` and `visibleOwnerFilter`.
- Produces:
  - The SmartServer config gains required `callerResolver: IRagCallerResolver` and `ragAccess: RagAccess`. The server refuses to start without them: the constructor or `start()` returns or throws `ServerConfigError`.
  - `_withSession`, in order:
    1. resolve the cookie `sessionId`;
    2. `callerResolver.resolve`;
    3. `bindings.bind`;
    4. `lifecycle.acquire({ sessionId, userId })`.

    Any failure produces HTTP 403 with no fallback.
  - On reuse, an acquired graph whose bound `userId` differs is refused.
  - `buildSessionRagRegistry` admits a catalog record only if `checkRagAccess(read)` passes. Role membership is re-read per request, so a revoke applies to an open session.
  - `recordSessionStart` stores the real `userId` in `userIdentity`.

- [ ] **Step 1: Write the failing tests** (acceptance tests 6, 8 and 15 for the server, Review Focus 1 and 3).
  - A server built without `callerResolver` fails to start.
  - A resolver returning `ok:false` produces a 403, and `acquire` is never called.
  - The same cookie `sessionId`, first resolved as `u1` and then as `u2`, gives a 403 on the second request, including when both requests run concurrently. Use a barrier promise.
  - A role collection is visible in session s1 of `u1`. After `revoke('u1', r)`, the next request in the same s1 does not see it and retrieval from it is denied.
  - A catalog row `{scope:'role', roleId:'gone'}` with no such role is skipped, reported once, and absent from `registry.list()`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `npm test -w packages/llm-agent-server-libs`.
- [ ] **Step 3: Implement.** Update the `llm-agent-server` wiring and its tests to pass `fixedCallerResolver` and `testRagAccess()` from config intended for local and CLI use. Document that this config is not for production.
- [ ] **Step 4: Run the full suite:** `npm run build && npm run typecheck && npm run lint:check && npm test`.
- [ ] **Step 5: Commit.**
  ```bash
  git commit -S -m "feat(server)!: caller identity, persisted session binding, access-checked hydration"
  ```

### Task 9: Threat model, migration guide, changesets

**Files:**
- Modify: `docs/SECURITY_THREAT_MODEL.md:69-100`
- Create:
  - `docs/MIGRATION-v31.md`
  - `.changeset/rag-collection-isolation.md`

- [ ] **Step 1: Rewrite AS-6.** It must describe:
  - the guarantee: one owner model, ownership AND decision;
  - fail-closed behaviour;
  - roles only from the library's tables;
  - the server's duties: resolver, decision, `isAdmin`;
  - the limits: the server decision can narrow access only.

  Remove the "role-restricted read is not checked" text at `:91-94`.
- [ ] **Step 2: Write `MIGRATION-v31.md`.** It covers:
  - `withRagAccess`, `callerResolver`, explicit `meta.scope`;
  - `CallOptions.caller`;
  - `RagCollectionToolOptions.caller/access`;
  - running `migrate<Backend>RagAccess` once before start;
  - the test helpers.
- [ ] **Step 3: Write the changeset.** It marks `major` for the seven packages in Global Constraints, with a one-paragraph summary.
- [ ] **Step 4: Run** `npm run build && npm run typecheck && npm run lint:check && npm test` **and** `node` **docs checks if present.**
- [ ] **Step 5: Commit.**
  ```bash
  git commit -S -m "docs: RAG isolation threat model, migration guide, changeset"
  ```
