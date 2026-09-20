# Authentication contracts and RAG identity — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a consumer authenticate every provider in the pipeline through a contract instead of a `string`, and make a caller's RAG collections reachable only through an instance built for that caller — closing llm-agent #304 without the framework ever judging a caller.

**Architecture:** Three credential contracts are published from `@mcp-abap-adt/interfaces-auth` and then adopted, beside the existing fields, by every provider that authenticates. Authorization happens at construction: a pipeline's instances are narrowed to what one caller may address, and no access check enters the framework. RAG collections gain persisted opaque `attributes`, a catalog that can be read back, and a hydration path that runs per caller inside an async registry factory.

**Tech Stack:** TypeScript (strict), Node 22, npm workspaces. Tests are `node:test` per package in llm-agent, **run through the tsx loader** — every package's own script is `node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'`, and a bare `node --test file.ts` fails with `ERR_MODULE_NOT_FOUND` because a `.ts` test's `.js` imports do not resolve without it (verified against an existing test). Each command below uses the loader for that reason; `npm test -w packages/<name>` is equivalent; the interfaces repo's tests are compile-only assertions under `__typechecks__/` plus `npm run check`. Biome for lint and format in both.

**Spec:** `docs/superpowers/specs/2026-09-16-auth-contracts-design.md` (this repository). Read it before Task A1 — the plan argues from it and every task below cites the section it implements. Review-clean as of `b3cc465e`.

---

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include this section.

- **The framework is the client side.** No component authorizes at request time; none accepts a policy function such as an access check. Authorization is performed at construction, by narrowing what an instance can address (§1.4, §5, and `docs/ARCHITECTURE.md` binding principle 8).
- **A credential is a constructor argument, never a per-call one.** A forgotten per-call credential does not fail — it proceeds as somebody else (§4.1).
- **Add a property; never widen an existing one.** `apiKey?: string`, `password?: string` and the SAP credential objects stay exactly as they are, and the credential arrives beside them. Widening a readable property breaks every reader: #306 measured `error TS2339: Property 'log' does not exist on type 'AnyLogger'` (§4.6.2).
- **An explicit credential outranks both the connection string and the discrete fields.** It is the only one of the three passed deliberately for this purpose. Each package keeps its existing relationship between string and discrete fields; this plan does not reconcile that (§4.6.1).
- **An address is not a credential.** Service URLs and `apiBaseUrl` keep the home they have; `IBearerCredential` carries the token and nothing else (§4.6.3).
- **Imports from the interfaces packages are `import type`** so nothing enters the runtime graph, while the package is a regular `dependencies` entry so the types resolve in every consumer's `tsc` (§1).
- **`AccessCheck` is not written anywhere in either repository.** It has one acceptor, cloud-llm-hub, and stays there (§5, interfaces decision 26).
- **Interfaces is published before llm-agent adopts it.** An acceptor cannot merge a dependency on an unpublished version, so Phase B does not begin until Phase A's version is on the registry (§8, "Order, and it is not negotiable").
- **One PR per repository.** Phase A is one PR in `mcp-abap-adt-interfaces`; Phase B is one PR in llm-agent covering both workstreams (§10).
- **The user publishes to npm.** Never run `npm publish`; the account has 2FA.

---

## Repositories, and the gate between them

| phase | repository | branch | ends with |
|---|---|---|---|
| A | `mcp-abap-adt-interfaces` | `feat/credential-contracts` (exists, PR #90 open) | `interfaces-auth` 1.1.0 on the registry, published by the user |
| B | `llm-agent` (this one) | `feat/credentials-and-rag-identity` | one PR, entries under `[Unreleased]`, no version bump |

**The gate is hard.** Task B1 installs `@mcp-abap-adt/interfaces-auth@^1.1.0`. Until Task A3 reports the publish confirmed, that install cannot resolve and Phase B cannot compile. Do not start Phase B by vendoring the types, declaring them locally, or pointing at a workspace path — any of those makes the published contract untested and the adoption a lie.

---

## File structure

### Phase A — `mcp-abap-adt-interfaces`

| file | responsibility |
|---|---|
| `packages/interfaces-auth/src/auth/ICredentials.ts` | the three contracts and their reasoning (exists, uncommitted corrections) |
| `packages/interfaces-auth/src/__typechecks__/credentials.ts` | compile-only assertions — this package's tests (exists, uncommitted corrections) |
| `packages/interfaces-auth/src/index.ts` | barrel export (exists, committed) |
| `packages/interfaces-auth/CHANGELOG.md` | the package's own changelog (exists, uncommitted corrections) |
| `packages/interfaces-auth/package.json` | version 1.0.0 → 1.1.0 at release |

### Phase B — `llm-agent`, by responsibility

**Contracts (declared once, in `@mcp-abap-adt/llm-agent`):**

| file | responsibility |
|---|---|
| `packages/llm-agent/src/interfaces/rag.ts` | `RagCollectionRecord`, `describeCollections?`, `openCollection?`, `adopt?`, `attributes`/`collectionName` on provider create, `EmbedderFactoryConfig.credential?` |
| `packages/llm-agent/src/rag/corrections/errors.ts` | `CatalogRecordDeleteError` beside the existing `RagError` family |
| `packages/llm-agent/src/rag/mcp-tools/rag-collection-tools.ts` | the seven tool entries; required `identity`; `RagToolContext` without identity fields |
| `packages/llm-agent/src/rag/registry/simple-rag-registry.ts` | `adopt()` honouring a store name that differs from the logical name |

**Adoption (one file per provider family):**

| file | responsibility |
|---|---|
| `packages/llm-agent-libs/src/providers.ts` | `credential?` on `LLMProviderConfig`, threaded to the five providers |
| `packages/llm-agent-libs/src/session/session-graph-factory.ts` | `ragRegistryFactory?`, session-owned registry and its disposal |
| `packages/qdrant-rag/src/{qdrant-rag,qdrant-rag-provider}.ts` | `IApiKeyCredential`; async header building; catalog + record-first delete |
| `packages/pg-vector-rag/src/{connection,pg-vector-rag-provider,schema}.ts` | `ISecretLoginCredential`; async resolver; catalog + record-first delete |
| `packages/hana-vector-rag/src/{connection,hana-vector-rag-provider,schema}.ts` | as pg |
| `packages/sap-aicore-llm/src/sap-core-ai-provider.ts` | `IBearerCredential`, destination built per call |
| `packages/sap-aicore-embedder/src/{foundation-embedder,orchestration-embedder}.ts` | `IBearerCredential` replacing its own `TokenProvider` |
| `packages/llm-agent-mcp/src/**` (http implementation) | credential demanded by that implementation's constructor |

---

## Phase A — `mcp-abap-adt-interfaces`: publish the three contracts

Work in `~/prj/mcp-abap-adt-interfaces`. The branch and PR already exist: `feat/credential-contracts`, PR #90, one commit `fbc0311`, and a worktree at `.worktrees/feat-credential-contracts` holding **uncommitted corrections**. Nothing new is designed here — the contracts were written before the plan and the spec has since confirmed their shape and their number.

### Task A1: commit the corrections already on disk

Three files are modified and uncommitted. The committed version of `ICredentials.ts` still carries a claim the spec disproved — that api-key and bearer are structurally identical without `kind` — and the committed typechecks assert the discriminator with cases that pass for other reasons. Losing these corrections would publish the false version.

**Files:**
- Modify: `packages/interfaces-auth/src/auth/ICredentials.ts` (working tree, uncommitted)
- Modify: `packages/interfaces-auth/src/__typechecks__/credentials.ts` (working tree, uncommitted)
- Modify: `packages/interfaces-auth/CHANGELOG.md` (working tree, uncommitted)

**Interfaces:**
- Consumes: nothing.
- Produces: `IApiKeyCredential`, `IBearerCredential`, `ISecretLoginCredential`, all exported from `@mcp-abap-adt/interfaces-auth`. Phase B imports exactly these three names.

- [ ] **Step 1: confirm what is uncommitted, and that it is the correction**

```bash
cd ~/prj/mcp-abap-adt-interfaces/.worktrees/feat-credential-contracts
git status --porcelain
# expect exactly: M CHANGELOG.md, M __typechecks__/credentials.ts, M auth/ICredentials.ts
git diff --stat
grep -c 'overlap that matters' packages/interfaces-auth/src/auth/ICredentials.ts   # expect 1
git show HEAD:packages/interfaces-auth/src/auth/ICredentials.ts | grep -c 'overlap that matters'  # expect 0
```

- [ ] **Step 2: make each `@ts-expect-error` fail on purpose, one at a time**

A directive that would hold for another reason is not a test of what it names. For each `@ts-expect-error` in `__typechecks__/credentials.ts`, weaken only the thing it claims to guard, and confirm the build fails with "Unused '@ts-expect-error' directive" — meaning the assignment started compiling, which is what the directive was pinning.

```bash
# example for the secret-login → api-key overlap: widen the api-key literal
sed -i "s/readonly kind: 'api-key';/readonly kind: string;/" packages/interfaces-auth/src/auth/ICredentials.ts
npx tsc --noEmit -p packages/interfaces-auth/tsconfig.json
# expect: error TS2578: Unused '@ts-expect-error' directive.
git checkout -- packages/interfaces-auth/src/auth/ICredentials.ts   # restore before the next one
```

Repeat for `_wrongKindKey`, `_wrongKindBearer`, `_anonymous`, `_nameless`, `_held`, `_rejected`. Any directive that still errors after its guard is weakened is pinning something else — fix the case, do not keep it.

- [ ] **Step 3: run the repository's whole test suite**

```bash
cd ~/prj/mcp-abap-adt-interfaces/.worktrees/feat-credential-contracts
npm run check > /tmp/check-a1.log 2>&1; echo "EXIT=$?"
tail -30 /tmp/check-a1.log
```

Expected: `EXIT=0`. `check:surface` must report the three new symbols in `interfaces-auth` and no placement change elsewhere; `check:graph` must pass with the new file importing nothing.

- [ ] **Step 4: commit**

```bash
git add packages/interfaces-auth/src/auth/ICredentials.ts \
        packages/interfaces-auth/src/__typechecks__/credentials.ts \
        packages/interfaces-auth/CHANGELOG.md
git commit -m "fix(interfaces-auth): the kind literal earns its place against secret-login, not bearer

The docstring and the changelog claimed api-key and bearer are structurally
identical without the literal. They are not: one has secret(), the other
token(), so that assignment fails on the members whether or not a discriminator
exists. The real overlap is secret-login against api-key — a login carries
everything a key asks for and its extra principal does not get in the way — so
without the literal it satisfies IApiKeyCredential outright.

The typechecks asserted the discriminator with cases that passed for the wrong
reason. Each now differs from its target in the literal ALONE, so weakening the
literal is what makes it compile and nothing else does."
```

- [ ] **Step 5: push and bring PR #90's body in line with the spec**

The PR was opened before the design settled and its title claims more than it carries. State plainly that it is three contracts, that `AccessCheck` is deliberately absent, and why.

```bash
git push origin feat/credential-contracts
gh pr edit 90 --body-file - <<'BODY'
Three contracts in `interfaces-auth`: `IApiKeyCredential`, `IBearerCredential`,
`ISecretLoginCredential`. No implementations, and deliberately **no
`AccessCheck`** — llm-agent is not an acceptor of one (it performs no
authorization at request time), which leaves cloud-llm-hub alone, and a single
acceptor keeps its own contract. See `mcp-abap-adt-interfaces` decision 26 and
llm-agent's `docs/superpowers/specs/2026-09-16-auth-contracts-design.md` §5.

The accepting change is specified and checked against the acceptors' real APIs:
llm-agent's plan `docs/superpowers/plans/2026-09-20-auth-contracts-and-rag-identity.md`,
Phase B. Per §4.4 the contract is published first and adopted after.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
```

### Task A2: merge, and cut the release commit

**Files:**
- Modify: `packages/interfaces-auth/package.json` (1.0.0 → 1.1.0)
- Modify: `packages/interfaces-auth/CHANGELOG.md` (the `1.1.0` heading)

- [ ] **Step 1: merge PR #90**

```bash
gh pr merge 90 --squash --delete-branch
cd ~/prj/mcp-abap-adt-interfaces && git checkout master && git pull --ff-only
```

- [ ] **Step 2: bump the version and head the changelog section**

A minor: the package gains exports and removes nothing.

```bash
node -e '
const fs=require("fs"), p="packages/interfaces-auth/package.json";
const j=JSON.parse(fs.readFileSync(p,"utf8"));
if(j.version!=="1.0.0") throw new Error("unexpected version "+j.version);
j.version="1.1.0"; fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
console.log("1.0.0 -> 1.1.0");
'
```

Then make the changelog's top section read `## 1.1.0` rather than an unreleased heading.

- [ ] **Step 3: run the whole suite again, on master**

```bash
npm run check > /tmp/check-a2.log 2>&1; echo "EXIT=$?"
tail -20 /tmp/check-a2.log
```

Expected `EXIT=0`. This run matters more than A1's: `check:publish` exercises the publish path's twelve guards, and the release in Task A3 goes through it.

- [ ] **Step 4: commit and tag**

The tag name is what `tools/publish-changed.js` derives — `tagFor(dir, version)` returns `${dir}-v${version}` for every package but the facade (`publish-changed.js:110-113`). The tool requires HEAD's **tree** to equal the tag's tree, not merely that the tag is an ancestor, so the tag goes on this commit and nothing follows it before the publish.

```bash
git add packages/interfaces-auth/package.json packages/interfaces-auth/CHANGELOG.md
git commit -m "release(interfaces-auth): 1.1.0 — credential contracts

Three contracts an acceptor can be handed: one secret, a bearer token, or an
identity and a secret. No implementations, and no AccessCheck (see decision 26).

A minor: exports are added, nothing is removed, and no existing declaration
changes."
git tag -a interfaces-auth-v1.1.0 -m "interfaces-auth 1.1.0 — credential contracts"
git push origin master
git push origin interfaces-auth-v1.1.0
```

### Task A3: the user publishes

**Do not run `npm publish`, and do not run `release:publish` yourself** — the account has 2FA and publishing is the user's.

- [ ] **Step 1: hand it over, with the command**

Tell the user, verbatim:

> `interfaces-auth` 1.1.0 is tagged and pushed. To publish:
> `cd ~/prj/mcp-abap-adt-interfaces && npm run release:publish`
> It publishes only what changed, refuses a dirty tree, and refuses if HEAD's tree differs from `interfaces-auth-v1.1.0`. A clean run is silent and exits 0.

- [ ] **Step 2: confirm from the registry, not from the terminal output**

```bash
npm view @mcp-abap-adt/interfaces-auth version --prefer-online     # expect 1.1.0
npm view @mcp-abap-adt/interfaces-auth dist-tags --prefer-online   # latest: 1.1.0
```

`--prefer-online` is not optional: npm's metadata cache has already caused one wrong conclusion in this repository's history.

**Phase A is done when both commands answer 1.1.0. Phase B may not start before that.**

---

## Phase B — `llm-agent`: adopt the contracts, and make the instance the enforcement point

One branch, one PR, both workstreams. Line numbers below were measured at `b3cc465e`; every task's first step re-reads the file, because a line number is a hint and the code is the fact.

```bash
cd ~/prj/llm-agent && git checkout main && git pull --ff-only
git checkout -b feat/credentials-and-rag-identity
```

**No version bump and no release in this phase.** Entries go under `[Unreleased]`; the version is decided later, at the release, by what has accumulated (§10).

### Task B1: take the dependency, and prove the types resolve

`@mcp-abap-adt/interfaces-auth` must be a regular `dependencies` entry in every package that imports a contract, even though every import is `import type`: the re-exported type has to resolve in each consumer's own `tsc`, and a `devDependency` does not travel to a consumer of ours.

**Files:**
- Modify: the `package.json` of every package that will import a contract — `llm-agent`, `llm-agent-libs`, `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag`, `openai-llm`, `anthropic-llm`, `deepseek-llm`, `ollama-llm`, `openai-embedder`, `sap-aicore-llm`, `sap-aicore-embedder`, `llm-agent-mcp`. The four concrete LLM providers are here because Task B2 resolves the secret **inside** them rather than in the wiring above them, and `openai-embedder` because Task B3 does the same.

**`ollama-embedder` is deliberately not on the list.** It sends `Content-Type` and nothing else (`ollama.ts:42`, `:91`) — it does not authenticate, so there is no acceptor for a credential in it, and adding one would be a contract member nobody calls. An earlier draft of this task installed the dependency there anyway.
- Create: `packages/llm-agent/src/__tests__/interfaces-auth-resolves.test.ts`

**Interfaces:**
- Consumes: `IApiKeyCredential`, `IBearerCredential`, `ISecretLoginCredential` from `@mcp-abap-adt/interfaces-auth@^1.1.0`.
- Produces: nothing. Later tasks rely only on the dependency being present.

- [ ] **Step 1: write the failing test**

```ts
// packages/llm-agent/src/__tests__/interfaces-auth-resolves.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  IApiKeyCredential,
  IBearerCredential,
  ISecretLoginCredential,
} from '@mcp-abap-adt/interfaces-auth';

describe('interfaces-auth', () => {
  it('is resolvable, and each contract is satisfiable by a plain object', async () => {
    const key: IApiKeyCredential = { kind: 'api-key', secret: async () => 'sk' };
    const bearer: IBearerCredential = { kind: 'bearer', token: async () => 'ey' };
    const login: ISecretLoginCredential = {
      kind: 'secret-login',
      principal: 'app_user',
      secret: async () => 'pw',
    };
    assert.equal(await key.secret(), 'sk');
    assert.equal(await bearer.token(), 'ey');
    assert.equal(`${login.principal}:${await login.secret()}`, 'app_user:pw');
  });
});
```

- [ ] **Step 2: run it and watch it fail for the right reason**

```bash
cd ~/prj/llm-agent
npx tsc --noEmit -p packages/llm-agent/tsconfig.json 2>&1 | head -5
```

Expected: `error TS2307: Cannot find module '@mcp-abap-adt/interfaces-auth' or its corresponding type declarations.` Any other failure means something else is wrong — stop and read it.

- [ ] **Step 3: install it into the eight packages**

```bash
for p in llm-agent llm-agent-libs qdrant-rag pg-vector-rag hana-vector-rag \
         openai-llm anthropic-llm deepseek-llm ollama-llm \
         openai-embedder \
         sap-aicore-llm sap-aicore-embedder llm-agent-mcp; do
  npm pkg set "dependencies.@mcp-abap-adt/interfaces-auth=^1.1.0" -w "packages/$p"
done
npm install
grep -c '"@mcp-abap-adt/interfaces-auth"' package-lock.json   # expect > 0
```

- [ ] **Step 4: run the test and the type check**

```bash
node --import tsx/esm --test packages/llm-agent/src/__tests__/interfaces-auth-resolves.test.ts
npx tsc --noEmit -p packages/llm-agent/tsconfig.json; echo "EXIT=$?"
```

Expected: the test passes, `EXIT=0`.

- [ ] **Step 5: commit**

```bash
git add package.json package-lock.json packages/*/package.json \
        packages/llm-agent/src/__tests__/interfaces-auth-resolves.test.ts
git commit -m "feat: depend on @mcp-abap-adt/interfaces-auth 1.1.0

A regular dependency, not a dev one: every import of it is \`import type\`, so
nothing enters the runtime graph, but the types must resolve in each consumer's
own tsc and a devDependency would not travel."
```

### Task B2: the LLM providers accept a credential beside `apiKey`

**Files:**
- Modify: `packages/llm-agent/src/types.ts` (`LLMProviderConfig`, `:78` — **this** is the contract consumers pass; `providers.ts` only has a local copy)
- Create: `packages/llm-agent/src/providers/resolve-provider-secret.ts`, exported from `packages/llm-agent/src/index.ts`. The helper belongs in **core**, not in `llm-agent-libs`: every provider package depends on `@mcp-abap-adt/llm-agent` and **none** depends on `llm-agent-libs` — the dependency runs the other way (measured: `openai-llm`, `anthropic-llm`, `deepseek-llm`, `ollama-llm` each list `@mcp-abap-adt/llm-agent`, and the last two also list `@mcp-abap-adt/openai-llm`). Declaring it in `providers.ts` would make it unimportable from the four places that must call it.
- Modify: `packages/llm-agent-libs/src/providers.ts` (local `apiKey?: string` ~`:29`; the five constructions at ~`:186`, `:204`, `:222`, `:240`, `:258`; `createDeepSeek(apiKey: string, …)` ~`:303`)
- Modify: `packages/openai-llm/src/**`, `packages/anthropic-llm/src/**`, `packages/deepseek-llm/src/**`, `packages/ollama-llm/src/**` — `OpenAIProvider`, `AnthropicProvider`, `DeepSeekProvider`, `OllamaProvider` each hold the credential and resolve it in their own request path. `SapCoreAIProvider` is Task B6.
- Test: `packages/llm-agent-libs/src/__tests__/providers-credential.test.ts` and one per provider package, e.g. `packages/openai-llm/src/__tests__/credential.test.ts`

**Interfaces:**
- Consumes: `IApiKeyCredential`, `IBearerCredential` (Task B1).
- Produces: `LLMProviderConfig.credential?: IApiKeyCredential | IBearerCredential` in `llm-agent/src/types.ts`, and the same property on each concrete provider's own config. Tasks B6 and B7 reuse the name, so it is fixed here.

- [ ] **Step 1: find out, per provider, whether a secret can be presented per request**

This decides the whole task, and it differs by SDK.

```bash
sed -n '75,95p' packages/llm-agent/src/types.ts          # the real contract
sed -n '20,40p;180,270p;295,315p' packages/llm-agent-libs/src/providers.ts
for p in openai-llm anthropic-llm deepseek-llm ollama-llm; do
  echo "=== $p"
  grep -rn "apiKey\|Authorization\|new OpenAI\|new Anthropic\|fetch(" \
    "packages/$p/src" --include='*.ts' | grep -v '__tests__' | head -12
done
```

For each, record in the task report **where the secret enters the wire**:

- a client constructed once with the key → resolve per request through the SDK's own hook (`defaultHeaders` as a function, or a `fetch` override), or rebuild nothing and say why;
- headers assembled per request by our own code → resolve there, which is the easy case;
- a key demanded as a required `string` (`createDeepSeek`, `:303`) → resolve before the call and throw the provider's existing missing-key error when it comes back `undefined`.

Do not proceed on an assumption: an answer of “the SDK takes a string once” changes what Step 4 can honestly promise, and the plan would rather say so than pretend.

- [ ] **Step 2: write the failing tests**

Three behaviours, and the precedence one is the one that would otherwise be assumed:

```ts
// packages/llm-agent-libs/src/__tests__/providers-credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { resolveProviderSecret } from '@mcp-abap-adt/llm-agent';

const cred = (v: string): IApiKeyCredential => ({
  kind: 'api-key',
  secret: async () => v,
});

describe('resolveProviderSecret', () => {
  it('uses the credential when both it and apiKey are given', async () => {
    assert.equal(
      await resolveProviderSecret({ apiKey: 'from-field', credential: cred('from-credential') }),
      'from-credential',
    );
  });

  it('falls back to apiKey when no credential is given', async () => {
    assert.equal(await resolveProviderSecret({ apiKey: 'from-field' }), 'from-field');
  });

  it('asks the credential on every call, so a rotated secret rotates', async () => {
    let n = 0;
    const rotating: IApiKeyCredential = { kind: 'api-key', secret: async () => `k${++n}` };
    assert.equal(await resolveProviderSecret({ credential: rotating }), 'k1');
    assert.equal(await resolveProviderSecret({ credential: rotating }), 'k2');
  });

  it('returns undefined when neither is given, rather than inventing one', async () => {
    assert.equal(await resolveProviderSecret({}), undefined);
  });
});
```

- [ ] **Step 2b: write the test that actually matters — two real calls through a provider**

The helper test above pins precedence, and calling a helper twice proves nothing about the provider's lifetime. This one would fail if the secret were resolved once at construction, which is exactly the mistake the first draft of this task made.

```ts
// packages/openai-llm/src/__tests__/credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { OpenAIProvider } from '../index.js';

describe('OpenAIProvider credential', () => {
  it('presents a freshly asked secret on EVERY request, not the one it was built with', async () => {
    const authorizations: Array<string | null> = [];
    let n = 0;
    const credential: IApiKeyCredential = { kind: 'api-key', secret: async () => `sk-${++n}` };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL, init: RequestInit = {}) => {
      authorizations.push(new Headers(init.headers as HeadersInit).get('Authorization'));
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const provider = new OpenAIProvider({ model: 'gpt-4o-mini', credential });
      await provider.chat?.([{ role: 'user', content: 'a' }]);
      await provider.chat?.([{ role: 'user', content: 'b' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(authorizations.length, 2, 'both requests went out');
    assert.notEqual(
      authorizations[0],
      authorizations[1],
      'a secret resolved once at construction would be identical here',
    );
    assert.deepEqual(authorizations, ['Bearer sk-1', 'Bearer sk-2']);
  });
});
```

Adjust the method name and the response body to each provider's real call shape, from Step 1. Write the same test for `anthropic-llm`, `deepseek-llm` and `ollama-llm`.

- [ ] **Step 3: run them and watch them fail**

```bash
node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/providers-credential.test.ts
node --import tsx/esm --test packages/openai-llm/src/__tests__/credential.test.ts
```

Expected: `resolveProviderSecret` is not exported, and the provider test fails on the unknown `credential` option — or, worse and more instructive, passes the same `Authorization` twice.

- [ ] **Step 4: add the property and the resolver**

```ts
// packages/llm-agent/src/providers/resolve-provider-secret.ts — in CORE, so every
// provider package can import it; none of them depends on llm-agent-libs.
import type { IApiKeyCredential, IBearerCredential } from '@mcp-abap-adt/interfaces-auth';

/** The secret to present, credential first. `undefined` means neither was given. */
export async function resolveProviderSecret(cfg: {
  apiKey?: string;
  credential?: IApiKeyCredential | IBearerCredential;
}): Promise<string | undefined> {
  if (cfg.credential) {
    return cfg.credential.kind === 'bearer'
      ? cfg.credential.token()
      : cfg.credential.secret();
  }
  return cfg.apiKey;
}
```

```ts
// packages/llm-agent/src/types.ts — beside the existing apiKey, NOT replacing it
export interface LLMProviderConfig {
  // … existing fields unchanged, including:
  apiKey?: string;
  /**
   * Where the secret comes from, when it is not a constant. Outranks `apiKey`:
   * it is the only one of the two passed deliberately for this purpose, and it
   * is asked on every call so a rotated key rotates (§4.6.1, §4.6.2).
   */
  credential?: IApiKeyCredential | IBearerCredential;
}
```

`providers.ts`'s local config gets the same property, and forwards it. `deepseek-llm` and `ollama-llm` both depend on `@mcp-abap-adt/openai-llm`, so check whether they reuse its request path before writing the same code twice — if they do, the change lands once in `openai-llm` and they inherit it.

**Pass the credential down; do not resolve it here.** At each of the five construction sites, forward `credential: cfg.credential` alongside the existing `apiKey: cfg.apiKey`. Resolving in the wiring would hand the provider a plain string and freeze the secret for the provider's whole lifetime — the first draft of this task said exactly that, and it contradicts the one thing the contract insists on.

The helper lives in core, and the **call** goes in each provider's request path — where Step 1 said the secret enters the wire, and never in a constructor:

```ts
// inside a provider, per request — not in its constructor
const secret = await resolveProviderSecret(this.cfg);
if (!secret) throw new MissingApiKeyError(/* the provider's existing error */);
```

`createDeepSeek(apiKey: string, …)` (`:303`) keeps its signature: it is a convenience over `makeLlm` and a required string is what it promises. A credential-configured DeepSeek goes through `makeLlm` instead.

- [ ] **Step 5: run everything this task touched — six packages, not two**

```bash
node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/providers-credential.test.ts
for p in openai-llm anthropic-llm deepseek-llm ollama-llm; do
  echo "=== $p"; node --import tsx/esm --test "packages/$p/src/__tests__/credential.test.ts"
done
for p in llm-agent llm-agent-libs openai-llm anthropic-llm deepseek-llm ollama-llm; do
  npx tsc --noEmit -p "packages/$p/tsconfig.json"; echo "$p=$?"
done
npx biome check packages/llm-agent/src/providers packages/llm-agent-libs/src/providers.ts \
  packages/openai-llm/src packages/anthropic-llm/src packages/deepseek-llm/src packages/ollama-llm/src
```

Every `tsc` must be `0`. A provider package that fails means the credential reached its config but not its request path.

- [ ] **Step 6: prove the old path is untouched**

```bash
node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/ 2>&1 | tail -5
```

Every existing provider test must still pass unchanged. If one needed editing, `apiKey` was widened rather than joined — undo and add, do not widen.

- [ ] **Step 7: commit**

```bash
git add packages/llm-agent/src/types.ts \
        packages/llm-agent/src/providers/resolve-provider-secret.ts \
        packages/llm-agent/src/index.ts \
        packages/llm-agent-libs/src/providers.ts \
        packages/llm-agent-libs/src/__tests__/providers-credential.test.ts \
        packages/openai-llm/src packages/anthropic-llm/src \
        packages/deepseek-llm/src packages/ollama-llm/src
git status --porcelain   # must be empty: nothing this task touched is left behind
git commit -m "feat: LLM providers accept a credential and resolve it per request

A new optional property, never a widening of apiKey: a consumer that reads
cfg.apiKey keeps compiling, which widening would have broken (#306 measured the
same move as TS2339). The credential outranks the field and is asked on every
call, so a rotated secret rotates."
```

### Task B3: the embedder factory carries a credential without becoming async

`EmbedderFactory = (cfg: EmbedderFactoryConfig) => IEmbedder` is public — `interfaces/rag.ts:35`, re-exported through `interfaces/index.ts:140-141` and `index.ts:14` — and consumers implement it. It returns synchronously, so a factory cannot await a secret before constructing. It does not need to: the credential goes **into** the embedder, which asks per embed call.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/rag.ts` (`EmbedderFactoryConfig`, ~`:20`)
- Modify: `packages/openai-embedder/src/openai-embedder.ts` — the **concrete** embedder, which today demands `apiKey: string` (`:6`), throws without it (`:19`), stores it (`:25`) and reads it at two header sites (`:48`, `:109`). Both sites sit inside `await fetch(…)`, so resolving per request costs no signature.
- Test: `packages/llm-agent/src/__tests__/embedder-factory-credential.test.ts` and `packages/openai-embedder/src/__tests__/credential.test.ts`

**Interfaces:**
- Consumes: `IApiKeyCredential`, `IBearerCredential`; `resolveProviderSecret` from core (Task B2).
- Produces: `EmbedderFactoryConfig.credential?`, the same property on `OpenAiEmbedderConfig`, and the rule that `EmbedderFactory` stays synchronous.

`ollama-embedder` is out of scope here for the reason Task B1 gives: it does not authenticate.

- [ ] **Step 1: write the failing test — the factory must still be sync**

```ts
// packages/llm-agent/src/__tests__/embedder-factory-credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import type { EmbedderFactory, EmbedderFactoryConfig, IEmbedder } from '../interfaces/rag.js';

describe('EmbedderFactoryConfig.credential', () => {
  it('reaches the embedder, which asks for it per call — the factory stays synchronous', async () => {
    const asked: string[] = [];
    const credential: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => {
        asked.push('asked');
        return 'sk-live';
      },
    };

    // The factory returns an IEmbedder directly: no Promise, no await.
    const factory: EmbedderFactory = (cfg: EmbedderFactoryConfig): IEmbedder => ({
      async embed(texts: string[]) {
        const secret = cfg.credential?.kind === 'api-key' ? await cfg.credential.secret() : cfg.apiKey;
        assert.equal(secret, 'sk-live');
        return texts.map(() => [0]);
      },
    }) as IEmbedder;

    const embedder = factory({ credential, model: 'm' });
    await embedder.embed(['a']);
    await embedder.embed(['b']);
    assert.equal(asked.length, 2, 'asked once per embed call, not once at construction');
  });
});
```

- [ ] **Step 2: run it and watch it fail**

```bash
node --import tsx/esm --test packages/llm-agent/src/__tests__/embedder-factory-credential.test.ts
```

Expected: a type error on `credential` — the property does not exist on `EmbedderFactoryConfig`.

- [ ] **Step 3: add the property**

```ts
// packages/llm-agent/src/interfaces/rag.ts — beside apiKey, not replacing it
export interface EmbedderFactoryConfig {
  url?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /**
   * Where the secret comes from. The factory does NOT resolve it — it returns
   * an IEmbedder synchronously, so it cannot await. It hands this to the
   * embedder, which asks per embed call, which is what "every secret is a
   * function, asked on each use" requires anyway (§4.6.2).
   */
  credential?: IApiKeyCredential | IBearerCredential;
}
```

`EmbedderFactory`'s signature does not change. Do not make it return a `Promise` — that breaks every consumer that implements one.

- [ ] **Step 3b: write the failing test for the concrete embedder**

The abstract test above proves the config carries a credential. This one proves a shipped embedder actually asks per request, which is where the promise is either kept or quietly dropped.

```ts
// packages/openai-embedder/src/__tests__/credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { OpenAiEmbedder } from '../openai-embedder.js';

describe('OpenAiEmbedder credential', () => {
  it('asks per request, and a rotated secret rotates', async () => {
    const seen: Array<string | null> = [];
    let n = 0;
    const credential: IApiKeyCredential = { kind: 'api-key', secret: async () => `sk-${++n}` };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string | URL, init: RequestInit = {}) => {
      seen.push(new Headers(init.headers as HeadersInit).get('Authorization'));
      return new Response(JSON.stringify({ data: [{ embedding: [0, 0] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const embedder = new OpenAiEmbedder({ model: 'text-embedding-3-small', credential });
      await embedder.embed(['a']);
      await embedder.embed(['b']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(seen, ['Bearer sk-1', 'Bearer sk-2']);
  });

  it('still throws when neither a key nor a credential is given', () => {
    // @ts-expect-error neither is configured
    assert.throws(() => new OpenAiEmbedder({ model: 'm' }));
  });

  it('still accepts a plain apiKey, exactly as before', async () => {
    const seen: Array<string | null> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string | URL, init: RequestInit = {}) => {
      seen.push(new Headers(init.headers as HeadersInit).get('Authorization'));
      return new Response(JSON.stringify({ data: [{ embedding: [0] }] }), { status: 200 });
    }) as typeof fetch;
    try {
      await new OpenAiEmbedder({ model: 'm', apiKey: 'sk-static' }).embed(['a']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(seen, ['Bearer sk-static']);
  });
});
```

- [ ] **Step 3c: implement it**

`apiKey` becomes optional so a credential-only configuration is expressible, and the constructor's existing throw fires only when **neither** is given — so the current error and its test survive untouched. Note the shape of that change honestly: for a *caller* it is a widening and safe; for anyone *reading* `OpenAiEmbedderConfig.apiKey` the type goes from `string` to `string | undefined`, and no reader outside the package is known.

```ts
export interface OpenAiEmbedderConfig {
  apiKey?: string;                       // was: apiKey: string
  credential?: IApiKeyCredential | IBearerCredential;
  model: string;
  // … unchanged
}

constructor(config: OpenAiEmbedderConfig) {
  if (!config.apiKey && !config.credential) {
    throw new Error('OpenAiEmbedder requires an apiKey or a credential');
  }
  // …
}

// at BOTH header sites (:48, :109), already inside `await fetch(…)`:
Authorization: `Bearer ${await resolveProviderSecret(this.config)}`,
```

- [ ] **Step 4: run both tests and both type checks**

```bash
node --import tsx/esm --test packages/llm-agent/src/__tests__/embedder-factory-credential.test.ts
node --import tsx/esm --test packages/openai-embedder/src/__tests__/credential.test.ts
node --import tsx/esm --test packages/openai-embedder/src/openai-embedder.test.ts
npx tsc --noEmit -p packages/llm-agent/tsconfig.json; echo "CORE=$?"
npx tsc --noEmit -p packages/openai-embedder/tsconfig.json; echo "EMBEDDER=$?"
```

The pre-existing `openai-embedder.test.ts` must pass **unedited** — it asserts the missing-key throw, which is exactly the behaviour that must survive.

- [ ] **Step 5: commit**

```bash
git add packages/llm-agent/src/interfaces/rag.ts \
        packages/llm-agent/src/__tests__/embedder-factory-credential.test.ts \
        packages/openai-embedder/src
git commit -m "feat: embedders carry a credential, and the concrete one asks per request

EmbedderFactory stays synchronous, so it cannot resolve the secret; it hands the
credential to the embedder, which asks per embed call — which is what the contract
required anyway. Making the factory async would have broken every consumer that
implements one.

OpenAiEmbedder's apiKey becomes optional so a credential-only configuration is
expressible, and its existing throw now fires only when neither is given, so the
current error and its test are untouched. ollama-embedder is not included: it
sends Content-Type and nothing else, so it has no acceptor for a credential."
```

### Task B4: `qdrant-rag` accepts an API-key credential

The key is read in three places, every one already inside an `async` function, and `_headers()` is private with a single caller — so making it async is invisible outside the package, whose `exports` map is closed to `"."`.

**Files:**
- Modify: `packages/qdrant-rag/src/qdrant-rag.ts` (`apiKey?: string` ~`:32`, field ~`:44`, `_headers()` ~`:56`, its only caller ~`:85`)
- Modify: `packages/qdrant-rag/src/qdrant-rag-provider.ts` (~`:18`, `:37`, `:45`, `:65`, and the two header sites ~`:79`, `:108`)
- Test: `packages/qdrant-rag/src/__tests__/credential.test.ts`

**Interfaces:**
- Consumes: `IApiKeyCredential`; the precedence rule from Task B2.
- Produces: `QdrantRagConfig.credential?` and `QdrantRagProviderConfig.credential?`.

- [ ] **Step 1: write the failing test**

```ts
// packages/qdrant-rag/src/__tests__/credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { QdrantRag } from '../qdrant-rag.js';

const embedder = { embed: async (t: string[]) => t.map(() => [0]) } as never;

describe('QdrantRag credential', () => {
  it('sends the credential api-key, asked per request, and prefers it over apiKey', async () => {
    const sent: Array<string | null> = [];
    let n = 0;
    const credential: IApiKeyCredential = { kind: 'api-key', secret: async () => `k${++n}` };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers as HeadersInit).get('api-key'));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const rag = new QdrantRag({
        url: 'http://q',
        collectionName: 'c',
        embedder,
        apiKey: 'from-field',
        credential,
      });
      await rag.query('a').catch(() => {});
      await rag.query('b').catch(() => {});
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(sent.slice(0, 2), ['k1', 'k2'], 'asked per request, credential wins');
  });
});
```

- [ ] **Step 2: run it and watch it fail**

```bash
node --import tsx/esm --test packages/qdrant-rag/src/__tests__/credential.test.ts
```

Expected: a type error on `credential`, or `['from-field','from-field']` — either way the credential is not yet used.

- [ ] **Step 3: implement**

Add `credential?: IApiKeyCredential` to both configs beside `apiKey`; keep the `apiKey` field. Make the header builders async and await the resolution:

```ts
private async _headers(): Promise<Record<string, string>> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = this.credential ? await this.credential.secret() : this.apiKey;
  if (key) h['api-key'] = key;
  return h;
}
```

and at its one caller, `headers: { ...(await this._headers()), ...(init.headers ?? {}) }`. Do the same at `qdrant-rag-provider.ts:79` and `:108`, both already inside `async deleteCollection` / `async listCollections`.

- [ ] **Step 4: run the test, the package's suite, and the type check**

```bash
node --import tsx/esm --test packages/qdrant-rag/src/__tests__/ 2>&1 | tail -5
npx tsc --noEmit -p packages/qdrant-rag/tsconfig.json; echo "EXIT=$?"
```

- [ ] **Step 5: commit**

```bash
git add packages/qdrant-rag/src packages/qdrant-rag/package.json
git commit -m "feat(qdrant-rag): accept an IApiKeyCredential beside apiKey

The header builder becomes async, which is invisible: it is private, has one
caller already inside async _fetch, and the package's exports map is closed to
\".\" so no consumer can reach it."
```

### Task B5: `pg-vector-rag` and `hana-vector-rag` accept a secret-login credential

Same change twice, so one task and one diff. Both resolvers are absent from their barrels and unreachable through a closed `exports` map, and each has exactly one production caller which is already `async` — so they become async internally at no visible cost.

**Files:**
- Modify: `packages/pg-vector-rag/src/connection.ts` (config ~`:1-14`, `resolvePgConnectArgs` ~`:27`)
- Modify: `packages/hana-vector-rag/src/connection.ts` (config ~`:1-13`, `resolveHanaConnectArgs` ~`:25`)
- Modify: both `*-vector-rag.ts` at their `createDriverClient` call (`pg:63`, `hana:57`) to `await`
- Test: `packages/pg-vector-rag/src/__tests__/credential.test.ts`, `packages/hana-vector-rag/src/__tests__/credential.test.ts`

**Interfaces:**
- Consumes: `ISecretLoginCredential`.
- Produces: `credential?: ISecretLoginCredential` on both configs; the resolvers return `Promise`.

- [ ] **Step 1: write the failing tests — precedence is the point**

The two packages disagree today about connection string versus discrete fields: pg returns early on a connection string and ignores `user`/`password` (`connection.ts:31-37`), while hana fills only the gaps with `??=` so the discrete fields win (`:33-40`). **The credential outranks both, in both packages**, and each keeps its existing string-versus-fields behaviour otherwise.

```ts
// packages/pg-vector-rag/src/__tests__/credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ISecretLoginCredential } from '@mcp-abap-adt/interfaces-auth';
import { resolvePgConnectArgs } from '../connection.js';

const credential: ISecretLoginCredential = {
  kind: 'secret-login',
  principal: 'cred_user',
  secret: async () => 'cred_pw',
};

describe('resolvePgConnectArgs credential precedence', () => {
  it('outranks a connection string, which otherwise wins outright', async () => {
    const args = await resolvePgConnectArgs({
      connectionString: 'postgres://str_user:str_pw@h/db',
      collectionName: 't',
      credential,
    });
    assert.equal(args.user, 'cred_user');
    assert.equal(args.password, 'cred_pw');
  });

  it('outranks discrete fields', async () => {
    const args = await resolvePgConnectArgs({
      host: 'h', user: 'field_user', password: 'field_pw', collectionName: 't', credential,
    });
    assert.equal(args.user, 'cred_user');
    assert.equal(args.password, 'cred_pw');
  });

  it('changes nothing when absent', async () => {
    const args = await resolvePgConnectArgs({
      host: 'h', user: 'field_user', password: 'field_pw', collectionName: 't',
    });
    assert.equal(args.user, 'field_user');
    assert.equal(args.password, 'field_pw');
  });
});
```

Write the hana twin with `resolveHanaConnectArgs`, asserting `uid`/`pwd` instead of `user`/`password`, and with a `hdbsql://str_user:str_pw@h:443` connection string.

- [ ] **Step 2: run both and watch them fail**

```bash
node --import tsx/esm --test packages/pg-vector-rag/src/__tests__/credential.test.ts \
            packages/hana-vector-rag/src/__tests__/credential.test.ts
```

- [ ] **Step 3: implement both**

Add `credential?: ISecretLoginCredential` to each config. Make each resolver `async`, and resolve the credential **before** the existing branches so it cannot be skipped by pg's early return:

```ts
export async function resolvePgConnectArgs(cfg: PgVectorRagConfig): Promise<PgPoolConfig> {
  const max = cfg.poolMax ?? 10;
  const connectionTimeoutMillis = cfg.connectTimeout ?? 30_000;
  const fromCredential = cfg.credential
    ? { user: cfg.credential.principal, password: await cfg.credential.secret() }
    : undefined;

  if (cfg.connectionString && !fromCredential) {
    return { connectionString: cfg.connectionString, max, connectionTimeoutMillis };
  }
  // … the existing host branch, with `...fromCredential` applied last so it wins
}
```

`await` at each `createDriverClient` call site — both are already `async`, so no signature above them moves. Update the existing `connection.test.ts` in each package to `await` the resolver.

- [ ] **Step 4: run both packages' suites and type-check**

```bash
node --import tsx/esm --test packages/pg-vector-rag/src/__tests__/ 2>&1 | tail -4
node --import tsx/esm --test packages/hana-vector-rag/src/__tests__/ 2>&1 | tail -4
npx tsc --noEmit -p packages/pg-vector-rag/tsconfig.json; echo "PG=$?"
npx tsc --noEmit -p packages/hana-vector-rag/tsconfig.json; echo "HANA=$?"
```

- [ ] **Step 5: commit**

```bash
git add packages/pg-vector-rag/src packages/hana-vector-rag/src \
        packages/pg-vector-rag/package.json packages/hana-vector-rag/package.json
git commit -m "feat(pg-vector-rag,hana-vector-rag): accept an ISecretLoginCredential

Additive, and measured so: neither resolver is in its barrel, both packages
declare a closed exports map with only \".\", and each resolver's single
production caller is already async. The credential outranks both the connection
string and the discrete fields — the two packages disagree with each other about
those two, and this change does not reconcile that."
```

### Task B6: `sap-aicore-llm` takes a bearer token, and builds its destination per call

The provider already constructs a fresh `OrchestrationClient` per call, because tools change between calls, and already passes a destination there. Moving the destination's construction into that path is what lets `token()` be awaited for every request. The service URL is **not** part of the credential and keeps its home.

**Files:**
- Modify: `packages/sap-aicore-llm/src/sap-core-ai-provider.ts` (credential object ~`:29-34`, service URL read ~`:164`, per-call client ~`:561`, destination sites ~`:71`, `:165`, `:564`)
- Test: `packages/sap-aicore-llm/src/__tests__/bearer-credential.test.ts`

**Interfaces:**
- Consumes: `IBearerCredential`.
- Produces: `credential?: IBearerCredential` on the provider config, with `AICORE_SERVICE_KEY` unchanged as the no-credential default.

- [ ] **Step 1: write the failing test**

```ts
// packages/sap-aicore-llm/src/__tests__/bearer-credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { buildDestination } from '../sap-core-ai-provider.js';

describe('buildDestination', () => {
  it('asks the credential per call and puts the token in the Authorization header', async () => {
    let n = 0;
    const credential: IBearerCredential = { kind: 'bearer', token: async () => `t${++n}` };
    const first = await buildDestination({ serviceUrl: 'https://aicore', credential });
    const second = await buildDestination({ serviceUrl: 'https://aicore', credential });
    assert.equal(first.headers?.Authorization, 'Bearer t1');
    assert.equal(second.headers?.Authorization, 'Bearer t2');
    assert.equal(first.url, 'https://aicore', 'the address is not the credential');
    assert.equal(first.authentication, 'NoAuthentication');
  });
});
```

- [ ] **Step 2: run it and watch it fail**

```bash
node --import tsx/esm --test packages/sap-aicore-llm/src/__tests__/bearer-credential.test.ts
```

- [ ] **Step 3: implement**

```ts
// packages/sap-aicore-llm/src/sap-core-ai-provider.ts
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';

/** The constructed-destination shape the SDK documents: url + headers, no lookup. */
export async function buildDestination(cfg: {
  serviceUrl: string;
  credential: IBearerCredential;
}): Promise<{
  url: string;
  authentication: 'NoAuthentication';
  headers: Record<string, string>;
}> {
  return {
    url: cfg.serviceUrl,
    authentication: 'NoAuthentication',
    // Asked on every call: the client is already rebuilt per call because tools
    // change, so this is where a bearer token stays fresh.
    headers: { Authorization: `Bearer ${await cfg.credential.token()}` },
  };
}
```

Do **not** reach for `authTokens`: its TypeScript type is `{ type; value; expiresIn?; error: string | null }` with no `http_header` field, so the shape shown in blog posts does not compile. At the per-call client construction, pass `await buildDestination(...)` when a credential is configured, and leave today's `OAuth2ClientCredentials` destination untouched when one is not.

- [ ] **Step 4: run, type-check, lint**

```bash
node --import tsx/esm --test packages/sap-aicore-llm/src/__tests__/ 2>&1 | tail -4
npx tsc --noEmit -p packages/sap-aicore-llm/tsconfig.json; echo "EXIT=$?"
npx biome check packages/sap-aicore-llm/src
```

- [ ] **Step 5: commit**

```bash
git add packages/sap-aicore-llm/src packages/sap-aicore-llm/package.json
git commit -m "feat(sap-aicore-llm): accept an IBearerCredential, destination built per call

The client is already constructed per call, so awaiting token() there is free and
is why the contract makes it a function. The service URL stays in the provider's
own config: an address is not a credential."
```

### Task B7: `sap-aicore-embedder` replaces its own token provider

On the `foundation-models` path this package does not use the SDK's auth at all: it runs its own `TokenProvider` doing `grant_type=client_credentials` over `fetch` and sets the header by hand. A bearer credential replaces that directly. The orchestration path needs a destination threaded through — the seam exists in the SDK and is simply not wired on our side.

**Files:**
- Modify: `packages/sap-aicore-embedder/src/foundation-embedder.ts` (credential fields ~`:8-11`, own `TokenProvider` ~`:48`, header ~`:98-101`)
- Modify: `packages/sap-aicore-embedder/src/orchestration-embedder.ts` (~`:50`, the two-argument `new OrchestrationEmbeddingClient(config, deploymentConfig)`)
- Test: `packages/sap-aicore-embedder/src/__tests__/bearer-credential.test.ts`

**Interfaces:**
- Consumes: `IBearerCredential` (Task B1); the `credential` property name fixed by Task B2.
- Produces: `credential?: IBearerCredential` on both embedder configs.

- [ ] **Step 1: write the failing test**

```ts
// packages/sap-aicore-embedder/src/__tests__/bearer-credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { FoundationEmbedder } from '../foundation-embedder.js';

describe('FoundationEmbedder credential', () => {
  it('sends the credential token per request and never calls the token endpoint', async () => {
    const authorizations: Array<string | null> = [];
    const urls: string[] = [];
    let n = 0;
    const credential: IBearerCredential = { kind: 'bearer', token: async () => `t${++n}` };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
      urls.push(String(url));
      authorizations.push(new Headers(init.headers as HeadersInit).get('Authorization'));
      return new Response(JSON.stringify({ data: [{ embedding: [0, 0] }] }), { status: 200 });
    }) as typeof fetch;

    try {
      const embedder = new FoundationEmbedder({
        apiBaseUrl: 'https://aicore/v2',
        model: 'text-embedding-3-small',
        credential,
      });
      await embedder.embed(['a']);
      await embedder.embed(['b']);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(authorizations, ['Bearer t1', 'Bearer t2'], 'asked per request');
    assert.ok(
      urls.every((u) => !u.includes('/oauth/token')),
      'the internal client_credentials call is skipped entirely when a credential is given',
    );
    assert.ok(urls.every((u) => u.startsWith('https://aicore/v2')), 'apiBaseUrl still comes from config');
  });
});
```

- [ ] **Step 2: run it and watch it fail**

```bash
node --import tsx/esm --test packages/sap-aicore-embedder/src/__tests__/bearer-credential.test.ts
```

Expected: a type error on `credential`, or two identical `Authorization` values with a `/oauth/token` request among the urls — either way the internal provider is still in charge.

- [ ] **Step 3: implement**

```ts
// packages/sap-aicore-embedder/src/foundation-embedder.ts
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';

export interface FoundationEmbedderConfig {
  // … existing fields unchanged: clientId?, clientSecret?, tokenUrl?, apiBaseUrl, model
  /**
   * When given, this replaces the internal TokenProvider outright — no
   * client_credentials call is made — and is asked on every request.
   */
  credential?: IBearerCredential;
}

// where the header is built today (~:98-101):
private async authorization(): Promise<string> {
  if (this.credential) return `Bearer ${await this.credential.token()}`;
  return `Bearer ${await this.tokenProvider.get()}`;   // today's path, untouched
}
```

For `orchestration-embedder.ts`, pass a third argument to `new OrchestrationEmbeddingClient(config, deploymentConfig, destination)`, building `destination` with the same shape Task B6 introduced.

- [ ] **Step 4: run the suite and type-check**

```bash
node --import tsx/esm --test packages/sap-aicore-embedder/src/__tests__/ 2>&1 | tail -4
npx tsc --noEmit -p packages/sap-aicore-embedder/tsconfig.json; echo "EXIT=$?"
```

Every existing test must pass unedited: the internal `TokenProvider` path is untouched when no credential is configured.

- [ ] **Step 5: commit**

```bash
git add packages/sap-aicore-embedder/src packages/sap-aicore-embedder/package.json
git commit -m "feat(sap-aicore-embedder): an IBearerCredential replaces the internal token provider

It never used the SDK's auth here — it ran its own client_credentials fetch and
set the header by hand, which is exactly what a bearer credential is for. The
orchestration path gains the destination argument the SDK already accepts and we
never passed."
```

### Task B8: two typed `IMcpServer` implementations, each demanding its own credential

**These classes do not exist yet.** `IMcpServer` is declared in `@mcp-abap-adt/llm-agent` (workstream 1) and the name appears nowhere in `llm-agent-mcp`; what exists is `MCPClientWrapper` in `client.ts`, whose `connect()` branches on transport and builds `StdioClientTransport({ command, args, env })` (~`:320`) or `StreamableHTTPClientTransport(new URL(url), buildHttpTransportOptions({ headers, sessionId, requestHeadersStrategy }))` (~`:348`). So this task **creates** the two typed implementations on top of that, which is what §8 means by "the typed implementations land with the credential contracts".

**Read this before writing the test — it changes what the test may assert.** `IMcpRequestHeadersStrategy.headers()` returns `Record<string, string>` **synchronously** (`llm-agent/src/interfaces/mcp-request-headers-strategy.ts:7`), and `buildHttpTransportOptions` merges its result into `requestInit.headers` **at connect** (`client.ts:194-209`, and the docstring says so). So an http MCP credential **cannot** be asked per request through the existing seam: it is resolved once per connection. That is consistent rather than a hole — `start()` acquires a connection, the credential is a constructor argument (§4.1), and reconnection is `IMcpConnectionStrategy`'s job, not this class's (§3.3). Widening `headers()` to return a promise would break every consumer that implements the strategy, and is not in this workstream.

**Files:**
- Create: `packages/llm-agent-mcp/src/servers/http-mcp-server.ts`
- Create: `packages/llm-agent-mcp/src/servers/stdio-mcp-server.ts`
- Modify: `packages/llm-agent-mcp/src/index.ts` (export both)
- Test: `packages/llm-agent-mcp/src/servers/__tests__/credential.test.ts`

**Interfaces:**
- Consumes: `IMcpServer`, `IMcpClient`, `IMcpRequestHeadersStrategy` from `@mcp-abap-adt/llm-agent`; `IApiKeyCredential`, `IBearerCredential` (B1); `createDefaultMcpClient` / `toMcpClientWrapperConfig` from `factory.ts`.
- Produces: `HttpMcpServer` and `StdioMcpServer`. Nothing later in this plan depends on them.

- [ ] **Step 1: write the failing tests, through the production seam**

Both classes take the client factory as a constructor argument, defaulting to `createDefaultMcpClient`. That is the seam the tests use — no `*ForTest` helper, because a helper proves only that the helper works. The factory receives a `McpConnectionConfig` and returns `{ client, close }` (`factory.ts:36-48`), so a fake can assert what was passed and count the closes.

```ts
// packages/llm-agent-mcp/src/servers/__tests__/credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { McpClientFactoryResult, McpConnectionConfig } from '@mcp-abap-adt/llm-agent';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { HttpMcpServer } from '../http-mcp-server.js';
import { StdioMcpServer } from '../stdio-mcp-server.js';

/** Records the config it was given, and how often close() was called. */
function fakeFactory() {
  const configs: McpConnectionConfig[] = [];
  let closes = 0;
  const client = { listTools: async () => [] } as never;
  const factory = async (config: McpConnectionConfig): Promise<McpClientFactoryResult> => {
    configs.push(config);
    return {
      client,
      close: async () => {
        closes += 1;
      },
    };
  };
  return { configs, client, factory, closes: () => closes };
}

describe('HttpMcpServer', () => {
  it('start() resolves the credential into the connection headers and returns the client', async () => {
    const f = fakeFactory();
    let asked = 0;
    const credential: IBearerCredential = { kind: 'bearer', token: async () => `t${++asked}` };
    const server = new HttpMcpServer(
      { url: 'https://mcp.example/mcp', credential, headers: { 'X-Trace': 'abc' } },
      f.factory,
    );

    const client = await server.start();
    assert.equal(client, f.client, 'start() returns the factory\u2019s client');
    assert.equal(f.configs.length, 1);
    const config = f.configs[0] as Extract<McpConnectionConfig, { url: string }>;
    assert.equal(config.headers?.Authorization, 'Bearer t1');
    assert.equal(config.headers?.['X-Trace'], 'abc', 'static headers survive');
    assert.equal(asked, 1, 'asked once per connection: headers() is synchronous (see above)');
  });

  it('a static Authorization cannot overwrite the credential', async () => {
    const f = fakeFactory();
    const credential: IBearerCredential = { kind: 'bearer', token: async () => 'tok' };
    await new HttpMcpServer(
      { url: 'https://mcp.example/mcp', credential, headers: { Authorization: 'Bearer stale' } },
      f.factory,
    ).start();
    const config = f.configs[0] as Extract<McpConnectionConfig, { url: string }>;
    assert.equal(config.headers?.Authorization, 'Bearer tok');
  });

  it('stop() closes exactly once, and is safe to call twice', async () => {
    const f = fakeFactory();
    const server = new HttpMcpServer({ url: 'https://mcp.example/mcp' }, f.factory);
    await server.start();
    await server.stop();
    await server.stop();
    assert.equal(f.closes(), 1, 'a second stop must not close a connection it does not hold');
  });

  it('stop() before start() does nothing rather than throwing', async () => {
    const f = fakeFactory();
    await new HttpMcpServer({ url: 'https://mcp.example/mcp' }, f.factory).stop();
    assert.equal(f.closes(), 0);
  });

  it('a second start() refuses rather than leaking the first connection', async () => {
    const f = fakeFactory();
    const server = new HttpMcpServer({ url: 'https://mcp.example/mcp' }, f.factory);
    await server.start();
    await assert.rejects(() => server.start(), /already started/);
    assert.equal(f.configs.length, 1);
  });

  it('a reconnect asks the credential again', async () => {
    const f = fakeFactory();
    let asked = 0;
    const credential: IBearerCredential = { kind: 'bearer', token: async () => `t${++asked}` };
    const server = new HttpMcpServer({ url: 'https://mcp.example/mcp', credential }, f.factory);
    await server.start();
    await server.stop();
    await server.start();
    const second = f.configs[1] as Extract<McpConnectionConfig, { url: string }>;
    assert.equal(second.headers?.Authorization, 'Bearer t2');
  });
});

describe('StdioMcpServer', () => {
  it('start() puts the secret in the child env and never in argv', async () => {
    const f = fakeFactory();
    const credential: IBearerCredential = { kind: 'bearer', token: async () => 'super-secret' };
    const server = new StdioMcpServer(
      { command: 'node', args: ['-e', 'process.stdin.resume()'], credential, credentialEnvVar: 'MCP_TOKEN' },
      f.factory,
    );
    const client = await server.start();
    assert.equal(client, f.client);
    const config = f.configs[0] as Extract<McpConnectionConfig, { type: 'stdio' }>;
    assert.equal(config.env?.MCP_TOKEN, 'super-secret');
    assert.ok(
      !config.args?.join(' ').includes('super-secret'),
      'argv is readable by any process on the machine',
    );
    assert.ok(!config.command.includes('super-secret'));
  });

  it('refuses to start when a credential has no variable to go in', async () => {
    const f = fakeFactory();
    const credential: IBearerCredential = { kind: 'bearer', token: async () => 'x' };
    const server = new StdioMcpServer({ command: 'node', args: [], credential }, f.factory);
    await assert.rejects(() => server.start(), /credentialEnvVar/);
    assert.equal(f.configs.length, 0, 'nothing was spawned');
  });

  it('stop() closes exactly once', async () => {
    const f = fakeFactory();
    const server = new StdioMcpServer({ command: 'node', args: [] }, f.factory);
    await server.start();
    await server.stop();
    await server.stop();
    assert.equal(f.closes(), 1);
  });
});
```

- [ ] **Step 2: run them and watch them fail**

```bash
node --import tsx/esm --test packages/llm-agent-mcp/src/servers/__tests__/credential.test.ts
```

Expected: the two modules do not exist.

- [ ] **Step 3: implement both, in full**

```ts
// packages/llm-agent-mcp/src/servers/http-mcp-server.ts
import type {
  IMcpClient,
  IMcpServer,
  McpClientFactoryResult,
  McpConnectionConfig,
} from '@mcp-abap-adt/llm-agent';
import type { IApiKeyCredential, IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { createDefaultMcpClient } from '../factory.js';

type ClientFactory = (config: McpConnectionConfig) => Promise<McpClientFactoryResult>;

export interface HttpMcpServerConfig {
  url: string;
  credential?: IApiKeyCredential | IBearerCredential;
  headers?: Record<string, string>;
  timeout?: number;
}

export class HttpMcpServer implements IMcpServer {
  private held: McpClientFactoryResult | undefined;

  constructor(
    private readonly cfg: HttpMcpServerConfig,
    private readonly createClient: ClientFactory = createDefaultMcpClient,
  ) {}

  async start(): Promise<IMcpClient> {
    if (this.held) throw new Error('HttpMcpServer is already started');
    const { url, credential, headers, timeout } = this.cfg;
    // Resolved HERE, once per connection, because the header seam is synchronous
    // and merged at connect. A reconnect asks again; that is the refresh.
    const secret = credential
      ? credential.kind === 'bearer'
        ? await credential.token()
        : await credential.secret()
      : undefined;
    const config: McpConnectionConfig = {
      url,
      // The credential goes LAST so a stale static Authorization cannot win.
      headers: { ...headers, ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      ...(timeout !== undefined ? { timeout } : {}),
    } as McpConnectionConfig;

    const held = await this.createClient(config);
    this.held = held;
    return held.client;
  }

  async stop(): Promise<void> {
    const held = this.held;
    if (!held) return;          // never started, or already stopped
    this.held = undefined;      // cleared FIRST, so a failing close cannot be retried into a double close
    await held.close();
  }
}
```

```ts
// packages/llm-agent-mcp/src/servers/stdio-mcp-server.ts
export interface StdioMcpServerConfig {
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  credential?: IBearerCredential;
  /** Which variable the child reads the secret from. Required with a credential. */
  credentialEnvVar?: string;
  timeout?: number;
}

export class StdioMcpServer implements IMcpServer {
  private held: McpClientFactoryResult | undefined;

  constructor(
    private readonly cfg: StdioMcpServerConfig,
    private readonly createClient: ClientFactory = createDefaultMcpClient,
  ) {}

  async start(): Promise<IMcpClient> {
    if (this.held) throw new Error('StdioMcpServer is already started');
    const { command, args, env, credential, credentialEnvVar, timeout } = this.cfg;
    if (credential && !credentialEnvVar) {
      // Refusing beats spawning an unauthenticated child and dropping the secret.
      throw new Error(
        'StdioMcpServer: a credential needs credentialEnvVar — refusing to start without it',
      );
    }
    const config: McpConnectionConfig = {
      type: 'stdio',
      command,
      args: args ?? [],
      env: {
        ...(env ?? {}),
        ...(credential && credentialEnvVar
          ? { [credentialEnvVar]: await credential.token() }
          : {}),
      },
      ...(timeout !== undefined ? { timeout } : {}),
    } as McpConnectionConfig;

    const held = await this.createClient(config);
    this.held = held;
    return held.client;
  }

  async stop(): Promise<void> {
    const held = this.held;
    if (!held) return;
    this.held = undefined;
    await held.close();
  }
}
```

Neither duplicates `client.ts`'s transport branching: `createDefaultMcpClient` already runs `toMcpClientWrapperConfig` (`factory.ts:39`), which maps `type: 'stdio'` to the stdio branch and a `url` config to `transport: 'auto'` with `headers` and `requestHeadersStrategy` (`factory.ts:14-33`). Export both from `index.ts`.

- [ ] **Step 4: run, type-check, lint**

```bash
node --import tsx/esm --test packages/llm-agent-mcp/src/servers/__tests__/credential.test.ts
npx tsc --noEmit -p packages/llm-agent-mcp/tsconfig.json; echo "EXIT=$?"
npx biome check packages/llm-agent-mcp/src
```

- [ ] **Step 5: commit**

```bash
git add packages/llm-agent-mcp/src packages/llm-agent-mcp/package.json
git commit -m "feat(llm-agent-mcp): typed IMcpServer implementations that demand a credential

They did not exist: IMcpServer is declared in llm-agent and client.ts only built
transports inline. http first — the main protocol, where start() acquires a
connection to something already running — and stdio beside it, the only one that
spawns, with the secret in the child's env and never in argv.

The http credential is resolved at CONNECT, not per request:
IMcpRequestHeadersStrategy.headers() is synchronous and its result is merged into
requestInit at connect. Reconnection refreshes it, and reconnection belongs to
IMcpConnectionStrategy. Widening headers() to a promise would break every
consumer implementing it, and is not in this workstream."
```

## Phase B, workstream 3 — RAG identity, attributes and a catalog that can be read back

### Task B9: the record, and the two provider members that make it usable

A provider is handed the **store** name, not the logical one: `SimpleRagRegistry.createCollection` computes `storeName = storeNameFor(params)` and calls `provider.createCollection(storeName, …)` (`:189`, `:193`). It cannot derive the logical name either — `storeNameFor` (`:31`) returns `${base}_${digest}` with `base` sanitized by `[^a-zA-Z0-9_] → _` and truncated to fit 63 characters. So the logical name must be written, and read back beside the attributes.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/rag.ts` (`IRagProvider.createCollection` ~`:209-216`, `listCollections?` ~`:219`, `IRagRegistry` ~`:163`)
- Test: `packages/llm-agent/src/__tests__/rag-collection-record.test.ts`

**Interfaces:**
- Produces, and later tasks use these exact names:
  - `RagCollectionRecord { storeName; name; scope?; sessionId?; userId?; attributes? }`
  - `RagCallerIdentity { sessionId; userId? }` — declared here, in `llm-agent`; Task B14 requires it
  - `IRagProvider.describeCollections?(): Promise<Result<readonly RagCollectionRecord[], RagError>>`
  - `IRagProvider.openCollection?(record): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>`
  - `IRagProvider.createCollection(name, opts)` gains `collectionName?: string` and `attributes?: unknown`
  - `IRagRegistry.createCollection(params)` gains `attributes?: unknown`
  - `RagCollectionAuthorization = 'public' | 'owner' | 'role'` and `RagCollectionMeta.authorization?` — the second of §6.1's two axes, which the meta does not carry today; Task B14 reads it to decide what a global permits

- [ ] **Step 1: write the failing test**

```ts
// packages/llm-agent/src/__tests__/rag-collection-record.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  IRagProvider,
  RagCallerIdentity,
  RagCollectionMeta,
  RagCollectionRecord,
} from '../interfaces/rag.js';

describe('RagCollectionRecord', () => {
  it('carries both identifiers, because the store name cannot yield the logical one', () => {
    const record: RagCollectionRecord = {
      storeName: 'my_notes_a1b2c3d4e5f6',
      name: 'my notes',
      providerName: 'pg',
      scope: 'user',
      userId: 'u-1',
      attributes: { role: 'analyst' },
    };
    assert.notEqual(record.storeName, record.name);
    // providerName is required: without it a hydrated collection deletes as a
    // silent no-op and the next hydration resurrects it.
    // @ts-expect-error providerName is not optional on a record
    const incomplete: RagCollectionRecord = { storeName: 's', name: 'n' };
    void incomplete;
  });

  it('declares both new provider members as optional, so no existing provider breaks', async () => {
    const provider: Partial<IRagProvider> = {
      describeCollections: async () => ({ ok: true, value: [] }),
    };
    const listed = await provider.describeCollections!();
    assert.equal(listed.ok, true);
  });

  it('declares a caller identity with a required session and an optional user', () => {
    const identity: RagCallerIdentity = { sessionId: 's-1' };
    assert.equal(identity.userId, undefined);
  });

  it('carries the second axis on the meta, so a global can say what it permits', () => {
    const meta: RagCollectionMeta = {
      name: 'open', displayName: 'open', editable: true,
      scope: 'global', authorization: 'public',
    };
    assert.equal(meta.authorization, 'public');
  });
});
```

- [ ] **Step 2: run it and watch it fail**

```bash
node --import tsx/esm --test packages/llm-agent/src/__tests__/rag-collection-record.test.ts
```

Expected: `RagCollectionRecord` and `RagCallerIdentity` are not exported.

- [ ] **Step 3: add the types and the members**

```ts
// packages/llm-agent/src/interfaces/rag.ts
export type RagCollectionRecord = {
  /** What the provider knows the store by — storeNameFor's output. */
  readonly storeName: string;
  /** The logical name the registry registers it under. */
  readonly name: string;
  /**
   * Which provider owns the store. NOT optional in practice even though the
   * meta's is: `SimpleRagRegistry.deleteData` returns `{ ok: true }` and calls
   * nobody when `meta.providerName` is absent, so a hydrated collection without
   * it deletes as a silent success — the store stays, the catalog row stays, and
   * the next hydration brings the collection back. Hydration must restore it.
   */
  readonly providerName: string;
  readonly scope?: RagCollectionScope;
  readonly sessionId?: string;
  readonly userId?: string;
  /**
   * §6.1's axis, persisted. Without it a `global` comes back as `undefined`
   * after a restart, and a resolver that only refuses `'role'` would then let a
   * role-gated collection be read. Task B14 fails closed as well, so both
   * halves have to be wrong for that to happen.
   */
  readonly authorization?: RagCollectionAuthorization;
  readonly attributes?: unknown;
};

/**
 * §6.1's second axis. `owner` is implied by scope and not configurable, so only
 * a `global` collection carries `public` or `role`. It stores a policy VALUE and
 * nothing more: whether this caller may act is read from it by the consumer,
 * never decided here.
 */
export type RagCollectionAuthorization = 'public' | 'owner' | 'role';

/**
 * The caller a pipeline's instances were built for. Declared here rather than
 * imported: `SessionGraphIdentity` is the same shape but lives in
 * `llm-agent-libs`, and the dependency runs libs → llm-agent, one way. The
 * shapes are structurally identical, so a consumer passes one straight in.
 */
export type RagCallerIdentity = {
  readonly sessionId: string;
  readonly userId?: string;
};
```

On `IRagProvider`, add:

```ts
  /** The catalog, read back. A provider without one does not declare this. */
  describeCollections?(): Promise<Result<readonly RagCollectionRecord[], RagError>>;
  /** Handles for a store that EXISTS: creates nothing, ensures nothing, writes no record. */
  openCollection?(
    record: RagCollectionRecord,
  ): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>;
```

and widen `createCollection`'s `opts` with `collectionName?: string`, `attributes?: unknown`, `providerName?: string` and `authorization?: RagCollectionAuthorization` — everything the catalog must be able to hand back, because a catalog cannot return what it was never given. Add `readonly authorization?: RagCollectionAuthorization` to `RagCollectionMeta` and to `IRagRegistry.createCollection`'s params — optional, so nothing existing breaks, and `undefined` on a global means the consumer's check decides what an absent value means (§1.2). Do **not** change `listCollections?()`'s `Promise<Result<string[], RagError>>` — a provider is something consumers implement, so widening a return type breaks every implementation while an optional addition breaks none.

- [ ] **Step 4: run the test, then prove no existing provider needed an edit**

```bash
node --import tsx/esm --test packages/llm-agent/src/__tests__/rag-collection-record.test.ts
for p in llm-agent qdrant-rag pg-vector-rag hana-vector-rag llm-agent-rag; do
  npx tsc --noEmit -p "packages/$p/tsconfig.json"; echo "$p=$?"
done
git diff --name-only packages/qdrant-rag packages/pg-vector-rag packages/hana-vector-rag
```

All must be `0`, and the last command must print **nothing**. A source edit in a provider means a member was added non-optionally.

- [ ] **Step 5: commit**

```bash
git add packages/llm-agent/src/interfaces/rag.ts \
        packages/llm-agent/src/__tests__/rag-collection-record.test.ts
git commit -m "feat(llm-agent): RagCollectionRecord, the catalog read, and openCollection

The record carries both identifiers because a provider is handed the store name
and cannot derive the logical one: storeNameFor sanitizes and truncates, so two
logical names collapse onto one base and a long one loses its tail.

describeCollections and openCollection are new optional members, not a widening
of listCollections: a provider is implemented by consumers, so a wider return
type breaks every implementation."
```

### Task B10: the failure names itself

`IRagProvider.deleteCollection?` returns an undifferentiated `Result<void, RagError>` (`:218`), and the tool turns any error into `{ ok: true, warning: '… was removed, but its data could not be deleted' }` (`rag-collection-tools.ts:220-225`) — so a catalog failure would be reported as data loss after a successful removal. A typed error carries the phase, as the rest of `rag/corrections/errors.ts` already does and as interfaces decision 25 asks.

**Files:**
- Modify: `packages/llm-agent/src/rag/corrections/errors.ts` (beside `DeleteUnsupportedError` ~`:62`)
- Modify: `packages/llm-agent/src/rag/mcp-tools/rag-collection-tools.ts` (delete handler ~`:215-226`)
- Test: `packages/llm-agent/src/rag/__tests__/catalog-record-delete-error.test.ts`

**Interfaces:**
- Produces: `CatalogRecordDeleteError extends RagError`. Tasks B11 and B12 raise it; Task B14's handler branches on it.

- [ ] **Step 1: write the failing test**

```ts
// packages/llm-agent/src/rag/__tests__/catalog-record-delete-error.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogRecordDeleteError } from '../corrections/errors.js';
import { CollectionNotFoundError } from '../corrections/errors.js';
import { buildRagCollectionToolEntries } from '../mcp-tools/rag-collection-tools.js';

const meta = { name: 'c', scope: 'user', userId: 'u-1', displayName: 'c', editable: true };
const identity = { sessionId: 's-1', userId: 'u-1' };

const entriesWith = (error: Error | null) =>
  buildRagCollectionToolEntries({
    identity,
    registry: {
      list: () => [meta],
      deleteCollection: async () =>
        error ? { ok: false, error } : { ok: true, value: undefined },
    } as never,
  });

const runDelete = async (error: Error | null) => {
  const del = entriesWith(error).find((e) => e.toolDefinition.name === 'rag_delete_collection')!;
  return (await del.handler({}, { name: 'c' })) as { ok: boolean; warning?: string; error?: string };
};

describe('rag_delete_collection reporting', () => {
  it('answers ok:false for a catalog-record failure — it is not a successful removal', async () => {
    const res = await runDelete(new CatalogRecordDeleteError('c', 'catalog write refused'));
    assert.equal(res.ok, false);
    assert.equal(res.warning, undefined, 'and it is not reported as data loss');
  });

  it('still warns, with ok:true, when the DATA could not be deleted', async () => {
    const res = await runDelete(new Error('connection reset'));
    assert.equal(res.ok, true);
    assert.match(res.warning ?? '', /could not be deleted/);
  });

  it('still answers ok:false for a collection that is not there', async () => {
    const res = await runDelete(new CollectionNotFoundError('c'));
    assert.equal(res.ok, false);
  });
});
```

- [ ] **Step 2: run it and watch it fail**

```bash
node --import tsx/esm --test packages/llm-agent/src/rag/__tests__/catalog-record-delete-error.test.ts
```

Expected: `CatalogRecordDeleteError` is not exported. The second and third cases should pass already — they pin today's behaviour, and must keep passing.

- [ ] **Step 3: implement the error and the branch**

```ts
// packages/llm-agent/src/rag/corrections/errors.ts — same shape as its neighbours
export class CatalogRecordDeleteError extends RagError {
  constructor(collection: string, reason: string) {
    super(
      `Catalog record for '${collection}' could not be deleted: ${reason}`,
      'RAG_CATALOG_RECORD_DELETE_ERROR',
    );
  }
}
```

```ts
// rag-collection-tools.ts, in the delete handler, BEFORE the generic warning:
if (res.error instanceof CatalogRecordDeleteError) {
  // Nothing was lost: the record and the data both survive, so this is a failed
  // delete to retry — not a removal with a data problem.
  return { ok: false, error: res.error.message };
}
```

- [ ] **Step 4: run the test, the suite and the type check**

```bash
node --import tsx/esm --test packages/llm-agent/src/rag/__tests__/ 2>&1 | tail -5
npx tsc --noEmit -p packages/llm-agent/tsconfig.json; echo "EXIT=$?"
```

- [ ] **Step 5: commit**

```bash
git add packages/llm-agent/src/rag/corrections/errors.ts \
        packages/llm-agent/src/rag/mcp-tools/rag-collection-tools.ts \
        packages/llm-agent/src/rag/__tests__/catalog-record-delete-error.test.ts
git commit -m "feat(llm-agent): CatalogRecordDeleteError, so the two delete phases differ

One Result cannot say which phase failed, and the tool turned every error into
'removed, but its data could not be deleted' — reporting a record failure as data
loss after a successful removal. The failure names itself instead (decision 25),
and a record failure answers ok:false because nothing was lost."
```

### Task B11: pg and hana gain a catalog, and delete the record before the data

The same change twice, so one task and one diff. **These packages own the backend catalog, so resurrection is stopped here or nowhere** — the core wiring can be complete and still leak without this. Both packages take an injectable `clientFactory?: () => PgClient | HanaClient`, so none of this needs a live database.

**Files:**
- Modify: `packages/pg-vector-rag/src/{schema,pg-vector-rag-provider}.ts`
- Modify: `packages/hana-vector-rag/src/{schema,hana-vector-rag-provider}.ts`
- Test: `packages/pg-vector-rag/src/__tests__/catalog.test.ts` and its hana twin

**Interfaces:**
- Consumes: `RagCollectionRecord` (B9), `CatalogRecordDeleteError` (B10).
- Produces: `describeCollections()`, `openCollection()` and a record-first `deleteCollection()` on both providers.

- [ ] **Step 1: write the failing tests**

```ts
// packages/pg-vector-rag/src/__tests__/catalog.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogRecordDeleteError } from '@mcp-abap-adt/llm-agent';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';

const embedder = { embed: async (t: string[]) => t.map(() => [0]) } as never;

/** Records every statement, and can be told to fail one of them. */
function fakeClient(failOn?: RegExp) {
  const statements: string[] = [];
  return {
    statements,
    client: {
      query: async (sql: string, _params?: unknown[]) => {
        statements.push(sql);
        if (failOn?.test(sql)) throw new Error('refused');
        if (/FROM\s+\w*catalog/i.test(sql)) {
          return {
            rows: [
              {
                store_name: 'my_notes_a1b2c3d4e5f6',
                collection_name: 'my notes',
                provider_name: 'pg',
                scope: 'user',
                user_id: 'u-1',
                authorization: null,
                attributes: { role: 'analyst' },
              },
            ],
          };
        }
        return { rows: [] };
      },
    },
  };
}

const providerWith = (c: ReturnType<typeof fakeClient>) =>
  new PgVectorRagProvider({
    name: 'pg',
    embedder,
    connection: { host: 'h', collectionName: '__unused' },
    clientFactory: () => c.client as never,
  });

describe('pg catalog', () => {
  it('writes the logical name and the attributes, and reads them back', async () => {
    const c = fakeClient();
    const provider = providerWith(c);
    await provider.createCollection('my_notes_a1b2c3d4e5f6', {
      scope: 'user',
      userId: 'u-1',
      collectionName: 'my notes',
      providerName: 'pg',
      attributes: { role: 'analyst' },
    });
    const listed = await provider.describeCollections!();
    assert.equal(listed.ok, true);
    const [record] = listed.ok ? listed.value : [];
    assert.equal(record.name, 'my notes', 'the logical name survived');
    assert.equal(record.storeName, 'my_notes_a1b2c3d4e5f6');
    assert.equal(record.providerName, 'pg', 'without this a hydrated delete calls nobody');
    assert.deepEqual(record.attributes, { role: 'analyst' });
  });

  it('opens an existing store without creating or ensuring anything', async () => {
    const c = fakeClient();
    const provider = providerWith(c);
    const opened = await provider.openCollection!({
      storeName: 'my_notes_a1b2c3d4e5f6',
      name: 'my notes',
      scope: 'user',
      userId: 'u-1',
    });
    assert.equal(opened.ok, true);
    assert.ok(
      !c.statements.some((s) => /CREATE|INSERT/i.test(s)),
      'openCollection creates nothing, ensures nothing, writes no record',
    );
  });

  it('deletes the record BEFORE the data', async () => {
    const c = fakeClient();
    await providerWith(c).deleteCollection!('my_notes_a1b2c3d4e5f6');
    const recordAt = c.statements.findIndex((s) => /DELETE\s+FROM\s+\w*catalog/i.test(s));
    const dataAt = c.statements.findIndex((s) => /DROP\s+TABLE/i.test(s));
    assert.ok(recordAt >= 0 && dataAt >= 0, 'both statements were issued');
    assert.ok(recordAt < dataAt, 'record first: an orphaned store is inert, a stale record resurrects');
  });

  it('leaves the data alone when the record cannot be deleted', async () => {
    const c = fakeClient(/DELETE\s+FROM\s+\w*catalog/i);
    const res = await providerWith(c).deleteCollection!('my_notes_a1b2c3d4e5f6');
    assert.equal(res.ok, false);
    assert.ok(
      res.ok === false && res.error instanceof CatalogRecordDeleteError,
      'the failure names its phase',
    );
    assert.ok(
      !c.statements.some((s) => /DROP\s+TABLE/i.test(s)),
      'the data statement was never issued',
    );
  });
});
```

Write the hana twin against `HanaVectorRagProvider`, whose fake client exposes `exec(sql, params)` rather than `query`.

- [ ] **Step 2: run both and watch them fail**

```bash
node --import tsx/esm --test packages/pg-vector-rag/src/__tests__/catalog.test.ts \
            packages/hana-vector-rag/src/__tests__/catalog.test.ts
```

Expected: `describeCollections` / `openCollection` are not functions on the provider.

- [ ] **Step 3: implement both**

The catalog stores everything a record carries — store name, **logical name, provider name, scope, owner keys, authorization** and attributes — because a catalog cannot hand back what it was never given, and two of those are what a hydrated collection needs in order to be deletable and to stay closed. A catalog of the provider's own, **created if absent by whatever means the backend supports** — which statement that is belongs to the implementation and not to the design. Note §9.10 while you are here: these packages already send one `IF NOT EXISTS` string to every server version with no negotiation, so do not deepen that assumption; if the backend cannot be relied on for it, catch and check rather than widening the bet.

`openCollection(record)` is the existing `createCollection` body **minus** the `ensureSchema` call and minus the catalog write. `deleteCollection` deletes the record first and returns `CatalogRecordDeleteError` with the data untouched when that fails:

```ts
async deleteCollection(storeName: string): Promise<Result<void, RagError>> {
  const client = this.requireClient();
  try {
    await client.query(deleteCatalogRowSql(), [storeName]);
  } catch (err) {
    // Stop here. Record and data both survive, so this is a retryable failed
    // delete — not a record pointing at data that is gone.
    return { ok: false, error: new CatalogRecordDeleteError(storeName, String(err)) };
  }
  try {
    await client.query(dropTableSql(storeName));
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: new RagError(String(err), 'RAG_DELETE_ERROR') };
  }
}
```

- [ ] **Step 4: run both suites and type-check both**

```bash
node --import tsx/esm --test packages/pg-vector-rag/src/__tests__/ 2>&1 | tail -4
node --import tsx/esm --test packages/hana-vector-rag/src/__tests__/ 2>&1 | tail -4
npx tsc --noEmit -p packages/pg-vector-rag/tsconfig.json; echo "PG=$?"
npx tsc --noEmit -p packages/hana-vector-rag/tsconfig.json; echo "HANA=$?"
```

- [ ] **Step 5: commit**

```bash
git add packages/pg-vector-rag/src packages/hana-vector-rag/src
git commit -m "feat(pg-vector-rag,hana-vector-rag): a catalog, and a delete that reaches it

These packages own the backend catalog, so resurrection is stopped here or
nowhere. The record goes before the data: both orders leave something behind on
failure, and an orphaned store is inert while a stale record comes back as if
valid. A failed record delete raises CatalogRecordDeleteError and never touches
the data."
```

### Task B12: qdrant gains a catalog — establish the mechanism before building on it

The design records the Qdrant catalog as **unverified**: it exposes no collection-level metadata we have checked. So this task starts by finding out, and the answer may change its shape. Do not skip Step 1 and assume the fallback.

**Files:**
- Modify: `packages/qdrant-rag/src/{qdrant-rag-provider,qdrant-rag}.ts`
- Test: `packages/qdrant-rag/src/__tests__/catalog.test.ts`

- [ ] **Step 1: establish what Qdrant actually offers**

```bash
cd ~/prj/llm-agent
node -e 'const p=require("./packages/qdrant-rag/package.json");console.log("deps:",p.dependencies)'
grep -rn "collections/\|/points\|payload" packages/qdrant-rag/src --include='*.ts' \
  | grep -v '__tests__' | head -20
```

Then read the Qdrant HTTP API for the version in use and answer one question in the task report: **does a collection carry writable collection-level metadata?** Record the answer either way — "unverified" becomes a fact here, in one direction or the other.

- [ ] **Step 2: pick the mechanism from that answer**

- Metadata exists → store the record there; the simpler mechanism wins.
- It does not → a dedicated catalog *collection* holding one point per collection, as §6.3 anticipates, with the record in the point's payload and the store name as its id.

- [ ] **Step 3: write the failing tests**

The same four behaviours as Task B11, against a `fetch` fake rather than a SQL client:

```ts
// packages/qdrant-rag/src/__tests__/catalog.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogRecordDeleteError } from '@mcp-abap-adt/llm-agent';
import { QdrantRagProvider } from '../qdrant-rag-provider.js';

type Call = { method: string; url: string };

function fakeFetch(failOn?: (c: Call) => boolean) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init: RequestInit = {}) => {
    const call = { method: init.method ?? 'GET', url: String(url) };
    calls.push(call);
    if (failOn?.(call)) return new Response('nope', { status: 500 });
    if (call.url.includes('/catalog/points/scroll')) {
      return new Response(
        JSON.stringify({
          result: {
            points: [
              {
                id: 'my_notes_a1b2c3d4e5f6',
                payload: {
                  store_name: 'my_notes_a1b2c3d4e5f6',
                  collection_name: 'my notes',
                  scope: 'user',
                  user_id: 'u-1',
                  attributes: { role: 'analyst' },
                },
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    return new Response('{"result":{}}', { status: 200 });
  }) as typeof fetch;
  return { calls, fn };
}

describe('qdrant catalog', () => {
  it('deletes the record before the collection, and stops if the record fails', async () => {
    const original = globalThis.fetch;
    const f = fakeFetch((c) => c.url.includes('/catalog/') && c.method === 'POST');
    globalThis.fetch = f.fn;
    try {
      const provider = new QdrantRagProvider({
        name: 'q',
        url: 'http://q',
        embedder: { embed: async (t: string[]) => t.map(() => [0]) } as never,
      });
      const res = await provider.deleteCollection!('my_notes_a1b2c3d4e5f6');
      assert.equal(res.ok, false);
      assert.ok(res.ok === false && res.error instanceof CatalogRecordDeleteError);
      assert.ok(
        !f.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/my_notes_a1b2c3d4e5f6')),
        'the collection delete was never issued',
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
```

Add the three siblings from B11 — write-then-read-back, `openCollection` issuing no create, and record-before-data ordering on the success path.

- [ ] **Step 4: run them, watch them fail, then implement**

```bash
node --import tsx/esm --test packages/qdrant-rag/src/__tests__/catalog.test.ts
```

Implement per Step 2's answer, including record-before-data delete and `CatalogRecordDeleteError`.

- [ ] **Step 5: run, type-check, commit**

```bash
node --import tsx/esm --test packages/qdrant-rag/src/__tests__/ 2>&1 | tail -4
npx tsc --noEmit -p packages/qdrant-rag/tsconfig.json; echo "EXIT=$?"
git add packages/qdrant-rag/src
git commit -m "feat(qdrant-rag): a catalog, and a delete that reaches it

The mechanism was unverified in the design and is established in the task report
rather than assumed. Record before data, and a failed record delete raises
CatalogRecordDeleteError without touching the collection."
```

### Task B13: the registry adopts an existing store

`register()` cannot do this: it sets `storeName: name` (`:99`), assuming the two are equal — true for a directly registered collection, false for every hydrated one.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/rag.ts` (`IRagRegistry.adopt?`)
- Modify: `packages/llm-agent/src/rag/registry/simple-rag-registry.ts`
- Test: `packages/llm-agent/src/rag/__tests__/adopt.test.ts`

**Interfaces:**
- Consumes: `RagCollectionRecord` (B9).
- Produces: `IRagRegistry.adopt?(record, rag, editor?): void`, honouring a store name that differs from the logical name. Task B15's factory calls it.

- [ ] **Step 1: write the failing tests**

```ts
// packages/llm-agent/src/rag/__tests__/adopt.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SimpleRagRegistry } from '../registry/simple-rag-registry.js';

const rag = { query: async () => ({ ok: true, value: [] }) } as never;
const editor = { upsert: async () => ({ ok: true, value: { id: '1' } }) } as never;
const record = {
  storeName: 'my_notes_a1b2c3d4e5f6',
  name: 'my notes',
  providerName: 'pg',
  scope: 'user' as const,
  userId: 'u-1',
  attributes: { role: 'analyst' },
};

describe('SimpleRagRegistry.adopt', () => {
  it('registers under the LOGICAL name while keeping the provider store name', () => {
    const registry = new SimpleRagRegistry();
    registry.adopt!(record, rag, editor);
    assert.equal(registry.get('my notes'), rag, 'addressable by its logical name');
    assert.equal(registry.get('my_notes_a1b2c3d4e5f6'), undefined, 'not by its store name');
    assert.equal(registry.list()[0].name, 'my notes');
    assert.equal(registry.list()[0].userId, 'u-1');
  });

  it('creates nothing: no provider is asked for anything', async () => {
    const asked: string[] = [];
    const registry = new SimpleRagRegistry();
    registry.setProviderRegistry({
      getProvider: () => {
        asked.push('getProvider');
        return undefined;
      },
    } as never);
    registry.adopt!(record, rag, editor);
    assert.deepEqual(asked, [], 'adopt touches no provider — the store already exists');
  });

  it('deletes through the STORE name, and actually reaches the provider', async () => {
    const deleted: string[] = [];
    let providerAsked = 0;
    const registry = new SimpleRagRegistry();
    registry.setProviderRegistry({
      getProvider: (name: string) => {
        providerAsked += 1;
        assert.equal(name, 'pg', 'the provider is looked up by the adopted providerName');
        return {
          deleteCollection: async (n: string) => {
            deleted.push(n);
            return { ok: true, value: undefined };
          },
        };
      },
    } as never);
    registry.adopt!(record, rag, editor);
    await registry.deleteCollection('my notes');
    assert.equal(providerAsked, 1, 'a delete that calls nobody is the resurrection bug');
    assert.deepEqual(deleted, ['my_notes_a1b2c3d4e5f6'], 'and the provider gets the store name');
  });

  it('restores the authorization axis, so a role-gated global does not read as undefined', () => {
    const registry = new SimpleRagRegistry();
    registry.adopt!(
      { storeName: 'gated_aaaaaaaaaaaa', name: 'gated', providerName: 'pg',
        scope: 'global', authorization: 'role' },
      rag,
    );
    assert.equal(registry.list()[0].authorization, 'role');
  });
});
```

The third test is the one that proves the two names stayed apart all the way through; without it `adopt` could store the logical name as the store name and nothing would notice until a delete silently missed.

- [ ] **Step 2: run them and watch them fail**

```bash
node --import tsx/esm --test packages/llm-agent/src/rag/__tests__/adopt.test.ts
```

Expected: `registry.adopt is not a function`.

- [ ] **Step 3: implement**

```ts
// interfaces/rag.ts, on IRagRegistry — optional, so an external implementation
// of this interface is not broken by gaining a member
  adopt?(record: RagCollectionRecord, rag: IRag, editor?: IRagEditor): void;
```

```ts
// simple-rag-registry.ts
adopt(record: RagCollectionRecord, rag: IRag, editor?: IRagEditor): void {
  if (this.entries.has(record.name)) {
    throw new Error(`Collection '${record.name}' is already registered`);
  }
  const editable = Boolean(editor) && !(editor instanceof ImmutableEditStrategy);
  this.entries.set(record.name, {
    rag,
    editor,
    storeName: record.storeName,      // NOT record.name — this is the whole point
    meta: {
      name: record.name,
      displayName: record.name,
      editable,
      scope: record.scope,
      sessionId: record.sessionId,
      userId: record.userId,
      // Both of these are load-bearing, and both were missing from the first
      // draft of this task. Without providerName, deleteData returns ok and
      // calls nobody (:258 region), so the store and its catalog row survive a
      // "successful" delete and the next hydration brings the collection back.
      // Without authorization, a role-gated global reads as undefined.
      providerName: record.providerName,
      authorization: record.authorization,
    },
  });
  this.fireMutation();
}
```

- [ ] **Step 4: run the test, then confirm every existing registry test passes unedited**

```bash
node --import tsx/esm --test packages/llm-agent/src/rag/__tests__/ 2>&1 | tail -6
npx tsc --noEmit -p packages/llm-agent/tsconfig.json; echo "EXIT=$?"
git diff --stat packages/llm-agent/src/rag/__tests__/   # only the new file
```

- [ ] **Step 5: commit**

```bash
git add packages/llm-agent/src/interfaces/rag.ts \
        packages/llm-agent/src/rag/registry/simple-rag-registry.ts \
        packages/llm-agent/src/rag/__tests__/adopt.test.ts
git commit -m "feat(llm-agent): IRagRegistry.adopt registers an existing store

register() cannot: it sets storeName: name, which is true for a collection
registered directly and false for every hydrated one. adopt takes the record
whole, so the logical name and the store name stay apart — and a delete still
reaches the provider under the store name."
```

### Task B14: the tool entries are built for one caller

The security change, and the largest behavioural one. Five of the seven handlers take the `RagToolContext` they are given and ignore it; a sixth trusts it. After this task identity comes from construction only.

**Files:**
- Modify: `packages/llm-agent/src/rag/mcp-tools/rag-collection-tools.ts`
- Test: `packages/llm-agent/src/rag/__tests__/tool-identity.test.ts`

**Interfaces:**
- Consumes: `RagCallerIdentity` (B9).
- Produces: `buildRagCollectionToolEntries({ registry, identity, providerRegistry? })` with `identity` **required**, and `RagToolContext` without `sessionId`/`userId`.

- [ ] **Step 1: write the failing tests — one per rule**

```ts
// packages/llm-agent/src/rag/__tests__/tool-identity.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRagCollectionToolEntries } from '../mcp-tools/rag-collection-tools.js';

const identity = { sessionId: 's-1', userId: 'u-1' };

const metas = [
  { name: 'mine', scope: 'user', userId: 'u-1', displayName: 'mine', editable: true },
  { name: 'theirs', scope: 'user', userId: 'u-2', displayName: 'theirs', editable: true },
  { name: 'open', scope: 'global', authorization: 'public', displayName: 'open', editable: true },
  { name: 'gated', scope: 'global', authorization: 'role', displayName: 'gated', editable: true },
];

function entries(created: unknown[] = []) {
  const registry = {
    list: () => metas,
    get: () => ({}) as never,
    getEditor: () => ({ upsert: async () => ({ ok: true, value: { id: '1' } }) }) as never,
    createCollection: async (p: unknown) => {
      created.push(p);
      return { ok: true, value: { name: 'new', displayName: 'new', editable: true } };
    },
    deleteCollection: async () => ({ ok: true, value: undefined }),
  } as never;
  return buildRagCollectionToolEntries({
    registry,
    identity,
    providerRegistry: { getProvider: () => ({}) } as never,
  });
}

const tool = (name: string) =>
  entries().find((e) => e.toolDefinition.name === name)!;

describe('identity comes from construction', () => {
  it('requires identity — omitting it does not compile', () => {
    // @ts-expect-error identity is required: an unnarrowed address space must be unwritable
    buildRagCollectionToolEntries({ registry: {} as never });
  });

  it('rag_create_collection uses the BOUND identity, not a per-call one', async () => {
    const created: unknown[] = [];
    const create = entries(created).find((e) => e.toolDefinition.name === 'rag_create_collection')!;
    await create.handler({ userId: 'someone-else' }, { provider: 'pg', name: 'n', scope: 'user' });
    assert.equal((created[0] as { userId?: string }).userId, 'u-1', 'the bound identity wins');
  });

  it('lists only the caller’s collections and the globals', async () => {
    const res = (await tool('rag_list_collections').handler({}, {})) as {
      collections: Array<{ name: string }>;
    };
    assert.deepEqual(
      res.collections.map((c) => c.name).sort(),
      ['gated', 'mine', 'open'],
      'another caller’s collection is absent, not denied',
    );
  });

  it('describes another caller’s collection as not found', async () => {
    const res = (await tool('rag_describe_collection').handler({}, { name: 'theirs' })) as {
      ok: boolean;
      error?: string;
    };
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /not found/, 'absent, not refused');
  });

  for (const name of ['rag_add', 'rag_correct', 'rag_deprecate']) {
    it(`${name} refuses to mutate a public global`, async () => {
      const res = (await tool(name).handler(
        {},
        { collection: 'open', text: 't', canonicalKey: 'k', newText: 't',
          predecessorId: '1', predecessorCanonicalKey: 'k', id: '1', reason: 'r' },
      )) as { ok: boolean };
      assert.equal(res.ok, false, 'public licenses reading, never writing');
    });
  }

  it('refuses a global whose authorization is UNSET, not just a role-gated one', async () => {
    // A collection created before the axis existed, or a hydration that lost it.
    const stale = [{ name: 'legacy', scope: 'global', displayName: 'legacy', editable: true }];
    const del = buildRagCollectionToolEntries({
      identity,
      registry: { list: () => stale, get: () => ({}) as never, getEditor: () => ({}) as never } as never,
    }).find((e) => e.toolDefinition.name === 'rag_describe_collection')!;
    const res = (await del.handler({}, { name: 'legacy' })) as { ok: boolean };
    assert.equal(res.ok, false, 'fail closed: an unset axis is not permission');
  });

  it('reads a public global but refuses a role-gated one', async () => {
    const ok = (await tool('rag_describe_collection').handler({}, { name: 'open' })) as { ok: boolean };
    assert.equal(ok.ok, true);
    const gated = (await tool('rag_describe_collection').handler({}, { name: 'gated' })) as {
      ok: boolean;
    };
    assert.equal(gated.ok, false, 'who holds a role is policy, and policy is not ours');
  });
});
```

- [ ] **Step 2: run them and watch each fail for its own reason**

```bash
node --import tsx/esm --test packages/llm-agent/src/rag/__tests__/tool-identity.test.ts 2>&1 | tail -30
```

Read every failure message. Some cases would pass today for the wrong reason — the list test, for instance, would pass if `metas` happened to hold only the caller's. The fixture above is built so none of them can.

- [ ] **Step 3: implement**

Declare the identity locally and require it. Do **not** import `SessionGraphIdentity`: it lives in `llm-agent-libs` and the dependency runs `llm-agent-libs` → `llm-agent`, one way — verified from `llm-agent`'s own `package.json`, which names no sibling. The shapes are identical, so a consumer passes a `SessionGraphIdentity` straight in.

```ts
import type { RagCallerIdentity } from '../../interfaces/rag.js';

export interface RagToolContext {
  // sessionId and userId are GONE: identity comes from construction, and a
  // per-call value that disagreed would act as somebody else. The index
  // signature stays, so call sites passing them keep compiling (measured on
  // tsc 6.0.3) and no handler can read them as identity.
  [key: string]: unknown;
}

export function buildRagCollectionToolEntries(opts: {
  registry: IRagRegistry;
  identity: RagCallerIdentity;          // required
  providerRegistry?: IRagProviderRegistry;
}): RagToolEntry[] {
  const { registry, identity } = opts;

  /** Everything this caller may address: its own, plus the globals. */
  const addressable = () =>
    registry.list().filter((m) => {
      if (m.scope === 'session') return m.sessionId === identity.sessionId;
      if (m.scope === 'user') return m.userId === identity.userId;
      return true;                       // global: addressable by everyone
    });

  const resolveReadable = (name: unknown) => {
    if (typeof name !== 'string') return { ok: false as const, error: 'collection is required' };
    const meta = addressable().find((m) => m.name === name);
    if (!meta) return { ok: false as const, error: `Collection '${name}' not found` };
    // Fail CLOSED on globals: only `public` is readable here, and anything else
    // — `role`, or an absent value from a collection created before the axis
    // existed — needs a policy, which is not ours (§5, §1.2). Refusing on
    // `!== 'public'` rather than on `=== 'role'` is what makes a hydration that
    // lost the axis safe instead of silently permissive.
    if (meta.scope === 'global' && meta.authorization !== 'public') {
      return {
        ok: false as const,
        error: `Collection '${name}' is not readable here: its authorization is ${
          meta.authorization ?? 'unset'
        }`,
      };
    }
    return { ok: true as const, meta };
  };

  const resolveEditor = (name: unknown) => {
    const readable = resolveReadable(name);
    if (!readable.ok) return readable;
    // `public` says who may REACH a global, never who may change one.
    if (readable.meta.scope === 'global') {
      return { ok: false as const, error: `Global collections cannot be modified via MCP` };
    }
    const editor = registry.getEditor(readable.meta.name);
    if (!editor) {
      return { ok: false as const, error: `Collection '${readable.meta.name}' is read-only or unknown` };
    }
    return { ok: true as const, editor };
  };
```

Then: all seven handlers take `_ctx` and use `identity`; `rag_create_collection` passes `identity.sessionId`/`identity.userId`; `rag_list_collections` filters `addressable()`; `rag_describe_collection` and the three editors go through the resolvers above; `rag_delete_collection` keeps refusing globals and may now drop its own owner-key comparison, because an unaddressable collection never reaches it.

- [ ] **Step 4: run the suite and the type check, and confirm the removal's shape**

```bash
node --import tsx/esm --test packages/llm-agent/src/rag/__tests__/ 2>&1 | tail -8
npx tsc --noEmit -p packages/llm-agent/tsconfig.json; echo "EXIT=$?"
```

- [ ] **Step 5: commit**

```bash
git add packages/llm-agent/src/rag/mcp-tools/rag-collection-tools.ts \
        packages/llm-agent/src/rag/__tests__/tool-identity.test.ts
git commit -m "feat(llm-agent)!: the collection tools are built for one caller

identity is required, and that is the point: an optional one would mean 'do not
narrow', which is an unnarrowed address space reached by forgetting a field. Five
handlers ignored the context they were handed and a sixth trusted it; all seven
now resolve from the bound identity, and another caller's collection is absent
rather than refused.

No framework tool mutates a global, whatever its authorization: public says who
may reach one, never who may change it. A role-gated global is not even readable
here, because who holds a role is policy.

BREAKING: buildRagCollectionToolEntries requires identity; RagToolContext no
longer declares sessionId/userId. Call sites passing them still compile — the
index signature absorbs them — but a reader of one must change."
```

### Task B15: a session can own its registry, and hydrate it

`SessionGraphFactoryOptions.ragRegistry` is one shared `IRagRegistry` (`session-graph-factory.ts:93`), handed to every build (`:228`) and the object `closeSession` is called on at dispose (`:280`). Its own comment — *"GLOBAL … shared; the per-call scope filter isolates"* — is the model being replaced.

**Files:**
- Modify: `packages/llm-agent-libs/src/session/session-graph-factory.ts`
- Test: `packages/llm-agent-libs/src/__tests__/session-registry-factory.test.ts`

**Interfaces:**
- Consumes: `IRagRegistry.adopt?` (B13), `describeCollections`/`openCollection` (B9/B11/B12) — the factory is where a consumer strings them together.
- Produces: `SessionGraphFactoryOptions.ragRegistryFactory?: (identity: SessionGraphIdentity) => Promise<IRagRegistry>`.

- [ ] **Step 1: write the failing tests, starting with the one that protects everyone**

```ts
// packages/llm-agent-libs/src/__tests__/session-registry-factory.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionGraphFactory } from '../session/session-graph-factory.js';

const sharedRegistry = () => {
  const closed: string[] = [];
  return {
    closed,
    registry: {
      list: () => [],
      closeSession: async (id: string) => {
        closed.push(id);
        return { ok: true as const, value: undefined };
      },
    } as never,
  };
};

const baseOpts = (extra: Record<string, unknown>) => ({
  toolsRag: undefined,
  buildAgent: async (parts: { ragRegistry: unknown }) => {
    handedToBuild.push(parts.ragRegistry);
    return undefined as never;
  },
  mcpClientFactory: () => ({ clients: [] }),
  ...extra,
});

let handedToBuild: unknown[] = [];

describe('ragRegistryFactory', () => {
  it('without it, behaviour is exactly today’s: the shared registry is used and closed', async () => {
    handedToBuild = [];
    const shared = sharedRegistry();
    const factory = new SessionGraphFactory(baseOpts({ ragRegistry: shared.registry }) as never);
    const graph = await factory.build({ sessionId: 's-1', userId: 'u-1' });
    assert.equal(handedToBuild[0], shared.registry, 'the shared one reached buildAgent');
    await graph.dispose();
    assert.deepEqual(shared.closed, ['s-1'], 'and closeSession was called on it');
  });

  it('with it, the factory receives the FULL identity and its registry is used', async () => {
    handedToBuild = [];
    const seen: Array<{ sessionId: string; userId?: string }> = [];
    const shared = sharedRegistry();
    const own = sharedRegistry();
    const factory = new SessionGraphFactory(
      baseOpts({
        ragRegistry: shared.registry,
        ragRegistryFactory: async (identity: { sessionId: string; userId?: string }) => {
          seen.push(identity);
          return own.registry;
        },
      }) as never,
    );
    const graph = await factory.build({ sessionId: 's-2', userId: 'u-2' });
    assert.deepEqual(seen, [{ sessionId: 's-2', userId: 'u-2' }], 'both keys, not just the session');
    assert.equal(handedToBuild[0], own.registry, 'the session’s own registry reached buildAgent');
    await graph.dispose();
    assert.deepEqual(own.closed, ['s-2'], 'dispose closed the session’s registry');
    assert.deepEqual(shared.closed, [], 'and never touched the shared one');
  });

  it('is awaited, so a factory that hydrates can do asynchronous work', async () => {
    handedToBuild = [];
    const own = sharedRegistry();
    let hydrated = false;
    const factory = new SessionGraphFactory(
      baseOpts({
        ragRegistry: sharedRegistry().registry,
        ragRegistryFactory: async () => {
          await new Promise((r) => setTimeout(r, 1));
          hydrated = true;
          return own.registry;
        },
      }) as never,
    );
    await factory.build({ sessionId: 's-3' });
    assert.equal(hydrated, true, 'the build waited for it');
    assert.equal(handedToBuild[0], own.registry);
  });
});
```

Write the first test first and watch it **pass** before writing the others: it pins today's behaviour, and if it ever fails later, the change broke every existing consumer.

- [ ] **Step 2: run them and watch the last two fail**

```bash
node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/session-registry-factory.test.ts 2>&1 | tail -20
```

Expected: test 1 passes, tests 2 and 3 fail because `ragRegistryFactory` is ignored.

- [ ] **Step 3: implement**

```ts
export interface SessionGraphFactoryOptions {
  // … unchanged, including:
  /** GLOBAL RAG provider/registry — used when no per-session factory is given. */
  readonly ragRegistry: IRagRegistry;
  /**
   * Builds the registry this session owns, and hydrates it. Asynchronous
   * because hydration is: describeCollections() and openCollection() both are,
   * and SessionAgentParts carries no userId (:33) to defer the work with. When
   * absent, `ragRegistry` is used exactly as before.
   */
  readonly ragRegistryFactory?: (identity: SessionGraphIdentity) => Promise<IRagRegistry>;
}
```

In `build(identity)` — already `async build(identity): Promise<SessionGraph>` (`:166`), so nothing above it changes:

```ts
const sessionRegistry = this.opts.ragRegistryFactory
  ? await this.opts.ragRegistryFactory(identity)
  : this.opts.ragRegistry;
```

Hand `sessionRegistry` to `buildAgent`, and remember whether it was the session's. At dispose, call `closeSession` on the session's own registry when there was one, and on `this.opts.ragRegistry` otherwise — keeping the existing best-effort behaviour and both `session_close_failed` message strings, which the pre-existing teardown tests assert on.

- [ ] **Step 4: run the package's whole suite — every existing test must pass unedited**

```bash
node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/ 2>&1 | tail -8
npx tsc --noEmit -p packages/llm-agent-libs/tsconfig.json; echo "EXIT=$?"
git diff --stat packages/llm-agent-libs/src/__tests__/    # only the new file
```

The last command printing an edit to an existing test means the old path changed — undo and make the new path additive.

- [ ] **Step 5: commit**

```bash
git add packages/llm-agent-libs/src/session/session-graph-factory.ts \
        packages/llm-agent-libs/src/__tests__/session-registry-factory.test.ts
git commit -m "feat(llm-agent-libs): a session can own and hydrate its RAG registry

ragRegistry was one shared object handed to every build and closed at dispose,
and its comment said the isolation came from a per-call scope filter — which is
the forgettable per-call mechanism, not the instance. The optional factory is
async because hydration is, and because SessionAgentParts has no userId to defer
it with. Absent, the old path runs untouched."
```

### Task B16: changelogs, documentation, and the migration note

Documentation is not only the changelog. A stale doc describing the previous contract is worse than no doc, because it is believed.

**Files:**
- Modify: `CHANGELOG.md` (root) and each touched package's `CHANGELOG.md`, under a new `[Unreleased]` heading — the top section today is `## 26.0.0`
- Modify: `README.md`, `docs/PIPELINES.md`, `docs/EXAMPLES.md`, `docs/SAP_AI_CORE.md` — wherever a credential, `apiKey`, a RAG collection tool or the session registry is described
- Modify: `docs/SECURITY_THREAT_MODEL.md` — AS-6 becomes mitigated

- [ ] **Step 1: find every place that documents what changed**

```bash
cd ~/prj/llm-agent
grep -rln "apiKey\|clientSecret\|buildRagCollectionToolEntries\|ragRegistry\|RagToolContext\|EmbedderFactory" \
  README.md docs/ --include='*.md'
```

Read each hit. A file that only mentions `apiKey` in passing may still be correct; one that shows it as *the* way to authenticate is now stale.

- [ ] **Step 2: write the `[Unreleased]` entries**

```bash
for p in llm-agent llm-agent-libs llm-agent-mcp qdrant-rag pg-vector-rag \
         hana-vector-rag sap-aicore-llm sap-aicore-embedder; do
  echo "--- packages/$p/CHANGELOG.md"; head -3 "packages/$p/CHANGELOG.md"
done
```

Each gets an `## [Unreleased]` section saying what a consumer must do, not what we did. No version numbers: the version is decided at the release by what has accumulated (§10).

- [ ] **Step 3: carry §8's three migration items into the root changelog, with their real errors**

````markdown
## [Unreleased]

### Migration

**1. Build the RAG collection tools with an identity.**

```ts
- const entries = buildRagCollectionToolEntries({ registry });
+ const entries = buildRagCollectionToolEntries({ registry, identity });
```

**2. Stop reading identity from the tool context.** A handler no longer needs to:
the entries were built for one caller. Call sites that *pass* `sessionId`/`userId`
keep compiling — `RagToolContext` declares `[key: string]: unknown`, which
absorbs them — but code that *reads* one gets
`TS2322: Type 'unknown' is not assignable to type 'string | undefined'`.

**3. Narrow a widened logger option before reading it.** The property is
optional, so `normaliseLogger(options.logger)` alone fails with `TS2345`:

```ts
- options.logger.log(event);
+ if (options.logger) normaliseLogger(options.logger).log(event);
```

**Not a migration:** hydrating collections after a restart is new and optional.
A consumer that does not hydrate behaves exactly as today — an empty registry,
and `attributes` that read back as `undefined`.
````

- [ ] **Step 4: update the threat model**

```markdown
**State: mitigated.** The tool entries are built with the caller's identity bound
in — required, not optional — so the only collections they can address are that
caller's and the globals, and no framework tool mutates a global at all. Landed
in Task B14 of the plan; see `docs/ARCHITECTURE.md` principle 8.
```

AS-6's **State** changes from "latent, not live" to that, naming the commit from Task B14, and its Known Limitations row is removed. Keep the description of what was wrong: a threat model that forgets what it fixed cannot tell whether a regression is new.

- [ ] **Step 5: run everything green**

```bash
npm run lint:check && echo "LINT=0"
npx tsc -b && echo "BUILD=0"
node --import tsx/esm --test $(git ls-files 'packages/*/src/**/*.test.ts') 2>&1 | tail -12
```

- [ ] **Step 6: open the PR**

```bash
git add -A && git commit -m "docs: changelogs, migration notes, and the threat model's AS-6"
git push -u origin feat/credentials-and-rag-identity
gh pr create --title "feat: credential contracts, and RAG collections a caller cannot address past" \
  --body-file - <<'BODY'
Workstreams 2 and 3 of `docs/superpowers/specs/2026-09-16-auth-contracts-design.md`,
in one PR because one plan covers both and `interfaces-auth` is touched once.
Plan: `docs/superpowers/plans/2026-09-20-auth-contracts-and-rag-identity.md`.

Requires `@mcp-abap-adt/interfaces-auth@^1.1.0`, published first per §4.4.

**Three source breaks, all deliberate**, with the migration note in the root
changelog: `buildRagCollectionToolEntries` requires an `identity`;
`RagToolContext` loses its declared `sessionId?`/`userId?`; and workstream 4's
widened logger properties are already under `[Unreleased]`. No version bump — the
version is decided at the release by what has accumulated (§10).

The security change is Task B14: five of seven collection handlers ignored the
identity they were handed and a sixth trusted it. Latent rather than live, since
nothing mounted them — see AS-6 in the threat model.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
```

- [ ] **Step 7: delete this plan**

Plans live in the tree only while they are unfinished (`CLAUDE.md`). Once the PR is merged, remove the file on `main` — history keeps it.

```bash
cd ~/prj/llm-agent && git checkout main && git pull --ff-only
git rm docs/superpowers/plans/2026-09-20-auth-contracts-and-rag-identity.md
git commit -m "docs: retire the auth-contracts plan, implemented"
git push origin main
```


---

## Self-review

This section records a review that was **run**, on 2026-09-20, after the first draft. Run it again against the spec before Task B16.

**What the first pass found, and what it cost:**

- **39 of 94 steps carried no code.** Whole tasks — B7, B8, B11, B12 — described their tests in prose, and B7 said “same shape as B6's”, which the skill names as a plan failure precisely because an implementer may read tasks out of order. Rewritten with the actual test and implementation code; 5 steps remain prose, and each is a decision or a handover rather than an edit.
- **A type used in a later task was defined by no earlier one.** Task B14 reads `meta.authorization` to decide what a global permits, and `RagCollectionMeta` has no such field — §6.1's second axis was in the spec and in no task. Task B9 now adds `RagCollectionAuthorization` and the optional `authorization?` on the meta and on `createCollection`.
- **§3.5 (stdio credentials) had no task at all.** §8 puts the typed stdio implementation in this workstream, beside http. Task B8 now covers both, batched because the shape is identical — a constructor demanding a credential typed per target — with the stdio half asserting the secret travels through the child's `env` and never through argv.
- **A cross-package import that cannot exist.** Task B14's first draft told an implementer to import `SessionGraphIdentity` into `llm-agent`, but it lives in `llm-agent-libs` and the dependency runs libs → llm-agent, one way. Fixed in both the plan and §5.1 of the spec, which now names `RagCallerIdentity`.

**What a third pass found — three more, and the same root cause every time: a file list that did not match a dependency graph.**

- **The helper was unimportable from the four places that must call it.** `resolveProviderSecret` was declared in `llm-agent-libs/src/providers.ts`, and no provider package depends on `llm-agent-libs` — measured: `openai-llm`, `anthropic-llm`, `deepseek-llm` and `ollama-llm` each depend on `@mcp-abap-adt/llm-agent`, and the last two also on `@mcp-abap-adt/openai-llm`. It now lives in core, which all four already have. The task's run and commit steps covered two files in one package while claiming changes in six; both now cover all six, and the commit step ends with a `git status --porcelain` that must come back empty.
- **Two embedder packages were given a dependency and no task.** B1 installed `interfaces-auth` into `openai-embedder` and `ollama-embedder` saying B2 would resolve inside them, while B2 covered only the four LLM providers and B3 only the abstract `EmbedderFactoryConfig` — so `OpenAiEmbedder` would have kept demanding `apiKey: string` and holding it for its lifetime. B3 now covers it, per request, with the pre-existing missing-key test required to pass unedited. And `ollama-embedder` is **removed** rather than given a credential: it sends `Content-Type` and nothing else (`ollama.ts:42`, `:91`), so a credential there would be a member nobody calls.
- **B8 had comment stubs where `start()` and `stop()` belong,** no `start`/`stop` on the stdio class at all, and tests that only exercised `*ForTest` helpers — which prove the helper works and nothing about the production path. Both classes now take the client factory as a constructor argument defaulting to `createDefaultMcpClient`, the lifecycle is written out, and the tests go through that seam: the config the factory receives carries the resolved header or env, `start()` returns `result.client`, `stop()` closes exactly once and is safe twice, a second `start()` refuses instead of leaking, and a reconnect asks the credential again.
- Editorial: the hard gate cited a Task A6 that does not exist. It is Task A3.

**What a second, external pass found — four blockers, all of them the plan not matching the code:**

- **Every test command was wrong.** The plan used `node --test file.ts`; each package's own script is `node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'`, and without the loader a `.ts` test's `.js` imports fail with `ERR_MODULE_NOT_FOUND` — verified against an existing test. All 33 commands now carry the loader, and Tech Stack says why once.
- **A hydrated collection would have been undeletable, and would have come back.** `RagCollectionRecord` had no `providerName`, and `SimpleRagRegistry.deleteData` returns `{ ok: true }` and calls nobody when `meta.providerName` is absent — so a delete succeeded silently, the store and its catalog row survived, and the next hydration restored the collection. It is now required on the record, persisted in the catalog, and restored by `adopt`, with a test that asserts the provider was actually asked.
- **A role-gated global would have become readable after a restart.** The `authorization` axis was on the meta but not on the record, not in the create options and not restored by `adopt`, so it came back `undefined` — and B14 refused only on `=== 'role'`. Both halves are fixed: the axis is threaded through, and the resolver now **fails closed** on `!== 'public'`, so either fix alone would have been enough.
- **B2 froze the secret for the provider's lifetime.** It resolved the credential in the wiring and handed a plain `string` to five constructors, which contradicts the one thing §4 insists on. `LLMProviderConfig` also lives in `llm-agent/src/types.ts:78`, not in `providers.ts` as the task claimed, and the five concrete providers are in four separate packages that B1 never installed the dependency into. B2 now forwards the credential and resolves it **inside each provider's request path**, with a test that makes two real calls and asserts the two `Authorization` headers differ.
- **B8 referenced classes that do not exist.** `IMcpServer` appears nowhere in `llm-agent-mcp`; `client.ts` builds transports inline. The task now **creates** both implementations on that code, and records a boundary the spec had not: `IMcpRequestHeadersStrategy.headers()` is synchronous and merged at connect, so an http MCP credential is resolved per *connection*, not per request. §3.3 of the spec now says so.

**What the passes confirmed:**

- **Spec coverage.** §3.3-3.4 are workstream 1, merged; §3.5 → B8. §4 and §4.6 → B2-B8. §5 and §5.1 → B14. §6.1 → B9 (the axis) and B14 (what it permits). §6.2 needs no task — it deletes a design, and the constructor credential it leaves behind is B4-B5. §6.3 → B9-B13. §6.4 → B15. §7 is workstream 4, merged. §8's migration → B16.
- **Not in any task, deliberately:** `AccessCheck` anywhere (§5); a composite registry key (§6.4); delegated identity to HANA or Qdrant (§9.1); converging the two logger names (§9.9); anything that would deepen the `IF NOT EXISTS` assumption (§9.10).
- **Type consistency.** The credential property is `credential` in every task — B2 fixes the name and B3-B8 reuse it. `RagCollectionRecord` uses `name` for the logical name and `storeName` for the physical one in B9, B11, B12 and B13 alike, and B13's third test exists to catch the two being conflated.
- **The gate.** No Phase B task may run before Task A3's two registry commands answer 1.1.0.

---

## Execution

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — tasks run in this session with checkpoints for review.

Which approach?
