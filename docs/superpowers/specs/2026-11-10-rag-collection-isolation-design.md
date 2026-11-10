# RAG collection isolation for every scope

Status: draft, 2026-11-10. Fixes issue #304 and replaces its "Scope decision".

## Intent

The library guarantees isolation of **every** RAG collection: session, user,
role and global. All four go through one ownership model and one enforcement
path. Consumers must not reimplement isolation per deployment. Previously #304
limited the library to session collections and left the rest to the consumer.
The product owner rejected that: isolation of all collections is the library's
job, and it must work the same way for every scope.

The split of responsibilities:

- **Library: mechanics.** Ownership of collections, the role tables, and
  enforcement. Once the server has decided who the caller is and what the caller
  may do, no request reaches a collection around that decision.
- **Server (the consumer, i.e. cloud-llm-hub): decisions.** Who the caller is,
  who is an admin (`MCP_Admin` in the hub), and whether a caller may read or
  write a given collection.

## Goals

1. One owner model for all scopes:
   `{ scope: 'session', sessionId } | { scope: 'user', userId } | { scope: 'role', roleId } | { scope: 'global' }`.
2. RAG roles as a library concept, separate from the consumer's own roles:
   - a **roles table** (id, name, description);
   - a **user-role assignments table** (userId, roleId);
   - collections with `scope: 'role'` belong to one role.
3. Admin-only management of roles. The library provides MCP tools to create and
   delete roles, assign and revoke them for users, and create role collections.
   Those tools exist only for a caller the server marks as admin. Other callers
   do not see them in the tool list, and a direct call is refused as an unknown
   tool. This is the pattern the hub already uses for `session_set_models`.
4. One enforcement path. Every operation that touches a collection asks the
   same access check, which consults the server's decision. That covers:
   - the collection tools: list, describe, query, write, delete and create;
   - both pipeline retrieval paths (`pipeline/handlers/rag-query.ts` and
     `agent/rag-orchestrator.ts`);
   - hydration of the session registry;
   - custom stores in `DefaultPipeline`.
5. Caller identity in `SmartServer`. A trusted resolver supplied by the consumer
   returns `{ sessionId, userId, isAdmin }`. The library resolves role
   membership from its own assignments table, never from the request, so a
   client cannot grant itself a role.
6. Tenant isolation at the store level. Each vector backend (in-memory, PG,
   HANA, Qdrant) implements one store contract that keeps owners apart. A
   backend may do this with a derived physical name, a schema, or a mandatory
   owner filter applied in the backend query. Choosing the mechanism per
   backend is left to the builder. A store that does not implement the contract
   cannot be registered.

## Non-goals

- The library does not decide read or write permission for role collections,
  and does not know who is an admin. Those are the server's decisions.
- No mapping from consumer roles (XSUAA `MCP_*`) to RAG roles. RAG roles are
  managed only by the admin through the library tools.
- No change to how collections are filled or searched (collection profiles,
  #322).

## Anti-goals

These make the work a failure even if it technically runs:

- Any implicit fallback that attaches a request to another session, another
  user or a shared identity. That includes today's `options?.sessionId ?? 'default'`
  in `default-pipeline.ts:487`, an empty header, or a missing resolver.
- Fail-open. If there is no decision interface, no identity, or the decision
  call fails, the request is refused. Nothing is served.
- A role taken from the request, the prompt or a tool argument.
- Silent semantic changes, for example a global store quietly becoming
  session-filtered, or a session store returning other sessions' records.

## Decided

- **Who checks what.** The server (hub) makes all permission decisions. The
  library calls them through a typed decision interface. The exact shape is the
  builder's call, roughly `canRead(identity, collection)`,
  `canWrite(identity, collection)` and `isAdmin(identity)`. The default with no
  interface is deny.
- **The server decision only narrows access.** Access is granted only when
  both the library's ownership check and the server's decision allow it:
  - session: own session AND `canRead`/`canWrite`;
  - user: own user AND the decision;
  - role: the user is assigned to the role AND the decision;
  - global: the decision.

  The server can never widen access past ownership.
- **Global collections** are created by, and written through MCP by, the admin
  only, using the admin tools. Non-admins read globals subject to the decision.
  `isAdmin` grants nothing beyond the admin tools and global management.
- **Existing data is migrated automatically.** The major version ships a
  one-time, idempotent migration per backend (PG, HANA, Qdrant). Existing
  records get their owner from the owner already recorded in the catalog.
  Records whose owner cannot be determined are not exposed. They are reported
  by the migration and left for the admin.
- **No resolver or decision interface means no start.** `SmartServer`,
  `SmartAgentBuilder` and `DefaultPipeline` refuse to start without both, with a
  configuration error. `sessionId` is still minted by the library's cookie
  lifecycle. The resolver adds `userId` and `isAdmin` and confirms the binding.
  CLI and tests use an explicit test resolver exported for that purpose, never a
  hidden default.
- **Who is admin.** In the hub, `MCP_Admin`. The hub passes it as
  `isAdmin` in the resolved identity.
- **Where roles live.** The role and assignment tables are stored by the same
  persistence the collection catalog uses (PG, HANA, in-memory). In-memory keeps
  them only until restart.
- **Deleting a role** is refused while the role still owns collections.
  Collections are never removed implicitly.
- **Release.** This contains breaking API and behaviour changes, so it ships
  as a major version of the affected packages, released in the usual order:
  version PR, then signed per-package tags, then the user publishes from main.
- **Hub follow-up.** After the library release, the hub moves its own
  collection isolation onto these mechanics (resolver, decision interface,
  role tools) in a separate hub PR.

## Builder's calls (made while writing the design, check them)

- **Enforcement point.** Enforcement lives in the core: the collection tool
  entries, `SmartAgentBuilder`/`DefaultPipeline`, the retrieval handlers and the
  store contract. It does not live only in `SmartServer`. The hub uses
  `SmartAgentBuilder` with its own HTTP and MCP servers, not `SmartServer`, and
  it must get the same guarantee. `SmartServer` only wires the resolver into
  these layers.
- **Per collection and per record.** A collection has exactly one owner.
  Physical stores shared across owners (the built-in `history` and `tools`
  stores, and any shared custom store) carry an owner on every record, and the
  store contract applies a mandatory owner filter on every query. The built-in
  `history` and `tools` stores are session-owned by the library. They do not go
  through the server's read decision, so a deny cannot break tool selection.
  The same owner union, including `role`, is used for record tags.
- **Session-to-user binding.** The binding is persisted in the catalog
  persistence, so it survives restarts and holds across several instances.
  Reusing a `sessionId` with a different `userId` is refused. Concurrent
  acquires of the same `sessionId` serialise on the persisted record.

## Constraints

- Static typing: no `any` or `unknown` (except a narrowed caught error), no
  `as unknown as`, no `as never`. Use discriminated unions for owners and
  identities.
- No timeouts in the work paths. Concurrency tests use controlled promises or
  barriers, never sleeps.
- The same tool set on every channel. Admin tools are the only role-dependent
  exception.
- `docs/SECURITY_THREAT_MODEL.md` must describe the new guarantee and its
  limits. Today, lines 92–94 say role-restricted reads are not checked.

## Acceptance tests

1. Two sessions of the same user: each sees its own session collections and
   both see that user's user collections.
2. Another user sees neither of them.
3. A role collection is visible only to users assigned to that role. Revoking
   the role hides the collection on the next request.
4. A server decision of deny for read or write is enforced in every tool and in
   both retrieval paths.
5. A shared store holding records of sessions A and B returns only A's records
   to A, on both retrieval paths.
6. A request without identity, or with a failing resolver or decision call, is
   refused, with no fallback.
7. A `sessionId` or owner smuggled through `ragFilter` or tool arguments is
   rejected.
8. A reused `sessionId` arriving with a different `userId` is refused,
   including under concurrent acquire.
9. Admin tools are invisible to non-admins, and a direct call by a non-admin is
   refused as an unknown tool.
10. Deleting a role that still owns collections is refused.
11. Every backend passes the same store-contract suite.
12. A server decision of allow never opens another owner's collection.
13. A non-admin cannot create a global collection or write to one.
14. After migration, existing collections are readable by their recorded owner
    only. Running the migration a second time changes nothing.
15. Building a server or pipeline without a resolver or decision interface
    fails at start.

## Left to the builder

- The exact names and signatures of the decision interface and the resolver.
- The isolation mechanism per backend (derived name, schema or owner filter).
- The table schemas and migrations for the role and assignment tables.
- How to split the work into PRs inside the library, as long as no
  intermediate release weakens isolation.
