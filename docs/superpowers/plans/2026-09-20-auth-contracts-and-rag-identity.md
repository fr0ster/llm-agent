# Authentication contracts and RAG identity — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a consumer authenticate every provider in the pipeline through a contract instead of a `string`, and make a caller's RAG collections reachable only through an instance built for that caller — closing llm-agent #304 without the framework ever judging a caller.

**Architecture:** Three credential contracts are published from `@mcp-abap-adt/interfaces-auth` and then adopted, beside the existing fields, by every provider that authenticates. Authorization happens at construction: a pipeline's instances are narrowed to what one caller may address, and no access check enters the framework. RAG collections gain persisted opaque `attributes`, a catalog that can be read back, and a hydration path that runs per caller inside an async registry factory.

**Tech Stack:** TypeScript (strict), Node 22, npm workspaces. Tests are `node:test` per package in llm-agent; the interfaces repo's tests are compile-only assertions under `__typechecks__/` plus `npm run check`. Biome for lint and format in both.

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

**The gate is hard.** Task B1 installs `@mcp-abap-adt/interfaces-auth@^1.1.0`. Until Task A6 reports the publish confirmed, that install cannot resolve and Phase B cannot compile. Do not start Phase B by vendoring the types, declaring them locally, or pointing at a workspace path — any of those makes the published contract untested and the adoption a lie.

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
- Modify: `packages/llm-agent/package.json`, `packages/llm-agent-libs/package.json`, `packages/qdrant-rag/package.json`, `packages/pg-vector-rag/package.json`, `packages/hana-vector-rag/package.json`, `packages/sap-aicore-llm/package.json`, `packages/sap-aicore-embedder/package.json`, `packages/llm-agent-mcp/package.json`
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
         sap-aicore-llm sap-aicore-embedder llm-agent-mcp; do
  npm pkg set "dependencies.@mcp-abap-adt/interfaces-auth=^1.1.0" -w "packages/$p"
done
npm install
grep -c '"@mcp-abap-adt/interfaces-auth"' package-lock.json   # expect > 0
```

- [ ] **Step 4: run the test and the type check**

```bash
node --test packages/llm-agent/src/__tests__/interfaces-auth-resolves.test.ts
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
- Modify: `packages/llm-agent-libs/src/providers.ts` (`apiKey?: string` on the config, ~`:29`; the five provider constructions, ~`:186`, `:204`, `:222`, `:240`, `:258`; `createDeepSeek(apiKey: string, …)` ~`:303`)
- Test: `packages/llm-agent-libs/src/__tests__/providers-credential.test.ts`

**Interfaces:**
- Consumes: `IApiKeyCredential`, `IBearerCredential` (Task B1).
- Produces: `LLMProviderConfig.credential?: IApiKeyCredential | IBearerCredential`. Tasks B6 and B7 use the same field name on the SAP providers, so it is fixed here.

- [ ] **Step 1: read the file and confirm the shape**

```bash
sed -n '20,40p;180,270p;295,315p' packages/llm-agent-libs/src/providers.ts
```

Note which providers take the key positionally and which take an options object. `createDeepSeek` takes a **required** `string` — a credential-only configuration must resolve it before calling, which is why the resolution happens in the adopting code and not in the factory.

- [ ] **Step 2: write the failing tests**

Three behaviours, and the precedence one is the one that would otherwise be assumed:

```ts
// packages/llm-agent-libs/src/__tests__/providers-credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { resolveProviderSecret } from '../providers.js';

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

- [ ] **Step 3: run them and watch them fail**

```bash
node --test packages/llm-agent-libs/src/__tests__/providers-credential.test.ts
```

Expected: `SyntaxError`/`TS2305` — `resolveProviderSecret` is not exported yet.

- [ ] **Step 4: add the property and the resolver**

```ts
// in providers.ts, beside the existing apiKey — NOT replacing it
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

Then at each of the five construction sites, replace the `cfg.apiKey` argument with `await resolveProviderSecret(cfg)`. Where the surrounding function is not yet `async`, make it so; where a factory demands a non-optional string (`createDeepSeek`), resolve first and throw the provider's existing "missing key" error when the result is `undefined`, exactly as it does today for an absent `apiKey`.

- [ ] **Step 5: run the tests, the type check and lint**

```bash
node --test packages/llm-agent-libs/src/__tests__/providers-credential.test.ts
npx tsc --noEmit -p packages/llm-agent-libs/tsconfig.json; echo "EXIT=$?"
npx biome check packages/llm-agent-libs/src/providers.ts
```

- [ ] **Step 6: prove the old path is untouched**

```bash
node --test packages/llm-agent-libs/src/__tests__/ 2>&1 | tail -5
```

Every existing provider test must still pass unchanged. If one needed editing, `apiKey` was widened rather than joined — undo and add, do not widen.

- [ ] **Step 7: commit**

```bash
git add packages/llm-agent-libs/src/providers.ts \
        packages/llm-agent-libs/src/__tests__/providers-credential.test.ts
git commit -m "feat(llm-agent-libs): providers accept a credential beside apiKey

A new optional property, never a widening of apiKey: a consumer that reads
cfg.apiKey keeps compiling, which widening would have broken (#306 measured the
same move as TS2339). The credential outranks the field and is asked on every
call, so a rotated secret rotates."
```

### Task B3: the embedder factory carries a credential without becoming async

`EmbedderFactory = (cfg: EmbedderFactoryConfig) => IEmbedder` is public — `interfaces/rag.ts:35`, re-exported through `interfaces/index.ts:140-141` and `index.ts:14` — and consumers implement it. It returns synchronously, so a factory cannot await a secret before constructing. It does not need to: the credential goes **into** the embedder, which asks per embed call.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/rag.ts` (`EmbedderFactoryConfig`, ~`:20`)
- Test: `packages/llm-agent/src/__tests__/embedder-factory-credential.test.ts`

**Interfaces:**
- Consumes: `IApiKeyCredential`, `IBearerCredential`.
- Produces: `EmbedderFactoryConfig.credential?: IApiKeyCredential | IBearerCredential`, and the rule that `EmbedderFactory` stays synchronous.

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
node --test packages/llm-agent/src/__tests__/embedder-factory-credential.test.ts
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

- [ ] **Step 4: run the test and the type check**

```bash
node --test packages/llm-agent/src/__tests__/embedder-factory-credential.test.ts
npx tsc --noEmit -p packages/llm-agent/tsconfig.json; echo "EXIT=$?"
```

- [ ] **Step 5: commit**

```bash
git add packages/llm-agent/src/interfaces/rag.ts \
        packages/llm-agent/src/__tests__/embedder-factory-credential.test.ts
git commit -m "feat(llm-agent): EmbedderFactoryConfig carries a credential

The factory stays synchronous, so it cannot resolve the secret; it hands the
credential to the embedder, which asks per embed call. Making the factory async
would have broken every consumer that implements one."
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
node --test packages/qdrant-rag/src/__tests__/credential.test.ts
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
node --test packages/qdrant-rag/src/__tests__/ 2>&1 | tail -5
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
node --test packages/pg-vector-rag/src/__tests__/credential.test.ts \
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
node --test packages/pg-vector-rag/src/__tests__/ 2>&1 | tail -4
node --test packages/hana-vector-rag/src/__tests__/ 2>&1 | tail -4
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
node --test packages/sap-aicore-llm/src/__tests__/bearer-credential.test.ts
```

- [ ] **Step 3: implement**

Export a `buildDestination` that returns the constructed-destination shape the SDK documents — `{ url, authentication: 'NoAuthentication', headers: { Authorization } }`. Do **not** use `authTokens`: its TypeScript type is `{ type; value; expiresIn?; error: string | null }` with no `http_header` field, so the shape shown in blog posts does not compile. Call `buildDestination` where the per-call client is constructed. When no credential is configured, keep today's `OAuth2ClientCredentials` path untouched.

- [ ] **Step 4: run, type-check, lint**

```bash
node --test packages/sap-aicore-llm/src/__tests__/ 2>&1 | tail -4
npx tsc --noEmit -p packages/sap-aicore-llm/tsconfig.json; echo "EXIT=$?"
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

This package does not use the SDK's auth on the `foundation-models` path at all: it has its own `TokenProvider` doing `grant_type=client_credentials` over `fetch` and sets the header by hand. `IBearerCredential` replaces that directly. The orchestration path needs a destination threaded through, which the LLM provider already has and this one does not.

**Files:**
- Modify: `packages/sap-aicore-embedder/src/foundation-embedder.ts` (credential fields ~`:8-11`, own `TokenProvider` ~`:48`, header ~`:98-101`)
- Modify: `packages/sap-aicore-embedder/src/orchestration-embedder.ts` (~`:50`, the two-argument `new OrchestrationEmbeddingClient(config, deploymentConfig)`)
- Test: `packages/sap-aicore-embedder/src/__tests__/bearer-credential.test.ts`

- [ ] **Step 1: write the failing test** — same shape as B6's, asserting the `Authorization` header on the outgoing `fetch` changes between two `embed` calls when the credential rotates, and that `apiBaseUrl` is still read from config.

- [ ] **Step 2: run it and watch it fail.**

- [ ] **Step 3: implement.** `credential?: IBearerCredential` beside the existing `clientId`/`clientSecret`/`tokenUrl`; when present, skip the internal `TokenProvider` entirely and ask `token()` per request. Thread a destination into `OrchestrationEmbeddingClient`'s third argument — the seam exists in the SDK and is simply not wired on our side.

- [ ] **Step 4: run the suite and type-check.**

- [ ] **Step 5: commit.**

```bash
git commit -m "feat(sap-aicore-embedder): an IBearerCredential replaces the internal token provider

It never used the SDK's auth here — it ran its own client_credentials fetch and
set the header by hand, which is exactly what a bearer credential is for. The
orchestration path gains the destination argument the SDK already accepts and we
never passed."
```

### Task B8: the http MCP implementation demands its own credential

**Files:**
- Modify: the http implementation under `packages/llm-agent-mcp/src/` (find it: `grep -rn "class .*Http.*Mcp\|IMcpServer" packages/llm-agent-mcp/src --include='*.ts'`)
- Test: alongside it

- [ ] **Step 1: locate the implementation and read its constructor.**

- [ ] **Step 2: write the failing test** — the constructor accepts a credential typed for what that server speaks, and the credential's value reaches the outgoing request's headers, asked per request.

- [ ] **Step 3: run it and watch it fail.**

- [ ] **Step 4: implement.** The credential is demanded by **this implementation's own constructor**, typed per target — which is what a bare `McpClientFactory` cannot express, since its single parameter is a generic `McpConnectionConfig` and nothing in the signature says which credential a target needs. http first: it is the main protocol, and `start()` holds a connection rather than spawning.

- [ ] **Step 5: run, type-check, commit.**

---

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
  - `IRagProvider.openCollection?(record: RagCollectionRecord): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>`
  - `IRagProvider.createCollection(name, opts)` gains `collectionName?: string` and `attributes?: unknown`
  - `IRagRegistry.createCollection(params)` gains `attributes?: unknown`

- [ ] **Step 1: write the failing test**

```ts
// packages/llm-agent/src/__tests__/rag-collection-record.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IRagProvider, RagCollectionRecord } from '../interfaces/rag.js';

describe('RagCollectionRecord', () => {
  it('carries both identifiers, because the store name cannot yield the logical one', () => {
    const record: RagCollectionRecord = {
      storeName: 'my_notes_a1b2c3d4e5f6',
      name: 'my notes',                   // spaces: sanitized away in the store name
      scope: 'user',
      userId: 'u-1',
      attributes: { role: 'analyst' },
    };
    assert.notEqual(record.storeName, record.name);
  });

  it('lets a provider declare both new members as optional', async () => {
    const provider: Partial<IRagProvider> = {
      describeCollections: async () => ({ ok: true, value: [] }),
      openCollection: async () => ({
        ok: false,
        error: new Error('no store') as never,
      }),
    };
    const listed = await provider.describeCollections!();
    assert.equal(listed.ok, true);
  });
});
```

- [ ] **Step 2: run it and watch it fail**

```bash
node --test packages/llm-agent/src/__tests__/rag-collection-record.test.ts
```

Expected: `RagCollectionRecord` is not exported.

- [ ] **Step 3: add the type and the members**

```ts
export type RagCollectionRecord = {
  /** What the provider knows the store by — storeNameFor's output. */
  readonly storeName: string;
  /** The logical name the registry registers it under. */
  readonly name: string;
  readonly scope?: RagCollectionScope;
  readonly sessionId?: string;
  readonly userId?: string;
  readonly attributes?: unknown;
};
```

On `IRagProvider`, add `describeCollections?` and `openCollection?` as **new optional** members, and add `collectionName?` and `attributes?` to `createCollection`'s `opts`. Do **not** widen `listCollections?()`'s `Promise<Result<string[], RagError>>`: a provider is something consumers implement, so widening a return type breaks every implementation while an optional addition breaks none.

- [ ] **Step 4: run the test and the type check.** Then confirm every existing provider still compiles without edits — all three implement `IRagProvider`, and an optional member must not oblige them:

```bash
for p in qdrant-rag pg-vector-rag hana-vector-rag llm-agent-rag; do
  npx tsc --noEmit -p "packages/$p/tsconfig.json"; echo "$p=$?"
done
```

All must be `0` **with no source edits**. A failure means a member was added non-optionally.

- [ ] **Step 5: commit.**

### Task B10: the failure names itself

`IRagProvider.deleteCollection?` returns an undifferentiated `Result<void, RagError>` (`:218`), and the tool turns any error into `{ ok: true, warning: '… was removed, but its data could not be deleted' }` (`rag-collection-tools.ts:220-225`) — so a catalog failure would be reported as data loss after a successful removal. A typed error carries the phase instead of a flag on the result, as the rest of `rag/corrections/errors.ts` already does.

**Files:**
- Modify: `packages/llm-agent/src/rag/corrections/errors.ts` (beside `DeleteUnsupportedError` ~`:62`)
- Modify: `packages/llm-agent/src/rag/mcp-tools/rag-collection-tools.ts` (delete handler ~`:215-226`)
- Test: `packages/llm-agent/src/rag/__tests__/catalog-record-delete-error.test.ts`

**Interfaces:**
- Produces: `CatalogRecordDeleteError extends RagError`. Tasks B11 and B12 raise it.

- [ ] **Step 1: write the failing test**

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogRecordDeleteError } from '../corrections/errors.js';
import { buildRagCollectionToolEntries } from '../mcp-tools/rag-collection-tools.js';

describe('delete reporting', () => {
  it('answers ok:false for a catalog-record failure, not a data warning', async () => {
    const registry = {
      list: () => [{ name: 'c', scope: 'user', userId: 'u-1', displayName: 'c', editable: true }],
      deleteCollection: async () => ({ ok: false, error: new CatalogRecordDeleteError('c', 'kaput') }),
    } as never;
    const entries = buildRagCollectionToolEntries({ registry, identity: { sessionId: 's', userId: 'u-1' } });
    const del = entries.find((e) => e.toolDefinition.name === 'rag_delete_collection')!;
    const res = (await del.handler({}, { name: 'c' })) as { ok: boolean; warning?: string };
    assert.equal(res.ok, false, 'a record failure is not a successful removal');
    assert.equal(res.warning, undefined, 'and it is not a data warning');
  });
});
```

- [ ] **Step 2: run it and watch it fail** — `CatalogRecordDeleteError` does not exist, and the handler answers `{ ok: true, warning: … }`.

- [ ] **Step 3: implement** the error class following the file's existing pattern, and branch on it in the handler before the generic warning.

- [ ] **Step 4: run, type-check.**

- [ ] **Step 5: commit.**

### Task B11: pg and hana gain a catalog, and delete the record before the data

Same change twice, so one task. **These packages own the backend catalog, so resurrection is stopped here or nowhere** — the core wiring can be complete and still leak without this.

**Files:**
- Modify: `packages/pg-vector-rag/src/{schema,pg-vector-rag-provider}.ts`
- Modify: `packages/hana-vector-rag/src/{schema,hana-vector-rag-provider}.ts`
- Test: `packages/pg-vector-rag/src/__tests__/catalog.test.ts` (+ hana twin)

**Interfaces:**
- Consumes: `RagCollectionRecord`, `CatalogRecordDeleteError`.
- Produces: `describeCollections()` and `openCollection()` implemented for both; `deleteCollection` doing record-then-data.

- [ ] **Step 1: write the failing tests**, three behaviours, using each package's injectable `clientFactory` so no live database is needed:

```
1. createCollection writes a catalog row carrying the LOGICAL name and the attributes;
   describeCollections reads back a record whose `name` differs from its `storeName`.
2. deleteCollection removes the catalog row BEFORE touching the data — assert on the
   recorded statement order from the fake client.
3. when the catalog delete fails, the data statement is NEVER issued and the result is
   a CatalogRecordDeleteError.
```

- [ ] **Step 2: run them and watch them fail.**

- [ ] **Step 3: implement.** A catalog table of the provider's own, **created if absent by whatever means the backend supports** — which statement that is belongs to the implementation, not to the design, and note §9.10: these packages already send one `IF NOT EXISTS` string to every server version with no negotiation, so do not deepen that assumption. `openCollection` is the existing `createCollection` body **minus** the `ensureSchema` call and minus the catalog write. `deleteCollection` deletes the record first and returns `CatalogRecordDeleteError` with the data untouched if that fails.

- [ ] **Step 4: run both suites, type-check both.**

- [ ] **Step 5: commit.**

### Task B12: qdrant gains a catalog — verify the mechanism before building on it

The design records the Qdrant catalog as **unverified**: it exposes no collection-level metadata we have checked. So this task begins by finding out, and its answer may change the shape.

- [ ] **Step 1: establish what Qdrant offers.** Read the client/API version in use and determine whether collection-level metadata exists. Record the finding in the task report either way.
- [ ] **Step 2: if there is none**, implement the catalog as a dedicated catalog *collection* holding one point per collection, as §6.3 anticipates. If there is metadata, use it and say so — the simpler mechanism wins.
- [ ] **Step 3: write the three failing tests** from Task B11, adapted.
- [ ] **Step 4: implement, including record-before-data delete and `CatalogRecordDeleteError`.**
- [ ] **Step 5: run, type-check, commit.**

### Task B13: the registry adopts an existing store

`register()` cannot do this: it sets `storeName: name` (`:99`), assuming the two are equal — true for a directly registered collection, false for every hydrated one.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/rag.ts` (`IRagRegistry.adopt?`)
- Modify: `packages/llm-agent/src/rag/registry/simple-rag-registry.ts`
- Test: `packages/llm-agent/src/rag/__tests__/adopt.test.ts`

- [ ] **Step 1: write the failing test**

```ts
it('registers under the logical name while keeping the provider store name', async () => {
  const registry = new SimpleRagRegistry();
  registry.adopt!(
    { storeName: 'my_notes_a1b2c3d4e5f6', name: 'my notes', scope: 'user', userId: 'u-1',
      attributes: { role: 'analyst' } },
    fakeRag, fakeEditor,
  );
  assert.equal(registry.get('my notes'), fakeRag, 'addressable by its logical name');
  assert.equal(registry.list()[0].name, 'my notes');
  // and the store name is what a later delete must pass to the provider
});
```

Add a second test proving `adopt` creates nothing: the provider fake must record **zero** calls.

- [ ] **Step 2: run and watch it fail.**
- [ ] **Step 3: implement** `adopt?` as an optional member on `IRagRegistry` (optional so an external implementation is not broken by gaining a member) and implement it on `SimpleRagRegistry`, storing `record.storeName` in the entry and `record.name` as the key.
- [ ] **Step 4: run, and confirm every existing registry test still passes unedited.**
- [ ] **Step 5: commit.**

### Task B14: the tool entries are built for one caller

The security change. Five of the seven handlers take the `RagToolContext` they are given and ignore it; one trusts it. After this task, identity comes from construction only.

**Files:**
- Modify: `packages/llm-agent/src/rag/mcp-tools/rag-collection-tools.ts`
- Test: `packages/llm-agent/src/rag/__tests__/tool-identity.test.ts`

**Interfaces:**
- Produces: `buildRagCollectionToolEntries({ registry, identity, providerRegistry? })` with `identity` **required**; `RagToolContext` without `sessionId`/`userId`.

- [ ] **Step 1: write the failing tests — one per rule**

```
1. `identity` is required: omitting it is a compile error (a `// @ts-expect-error` line).
2. rag_create_collection takes its owner keys from the bound identity, NOT from a
   per-call context that disagrees: pass { userId: 'someone-else' } as ctx and assert the
   created collection's userId is the bound one.
3. mutations of a global are refused, whatever its authorization: rag_add, rag_correct and
   rag_deprecate each answer ok:false for a `global` collection, `public` included.
4. reads of a `public` global are allowed; reads of a `role` global are refused.
5. rag_list_collections returns only the caller's collections and the globals.
6. rag_describe_collection answers "not found" for another caller's collection — absent,
   not denied.
```

- [ ] **Step 2: run them and watch them fail** — several will pass trivially today for the wrong reason, so check each failure message says what it should.

- [ ] **Step 3: implement.** Declare `RagCallerIdentity { readonly sessionId: string; readonly userId?: string }` in `llm-agent` beside the tools and add it as a **required** option. Do not import `SessionGraphIdentity`: it lives in `llm-agent-libs` and the dependency runs `llm-agent-libs` → `llm-agent`, one way (verified: `llm-agent`’s own dependencies name no sibling). The shapes are identical, so a consumer passes a `SessionGraphIdentity` straight in. Remove the declared `sessionId?`/`userId?` from `RagToolContext`, keeping its `[key: string]: unknown` index signature — measured on the repository's tsc 6.0.3: a call site passing those keys still compiles, while a reader gets `TS2322: Type 'unknown' is not assignable to type 'string | undefined'`. Have all seven handlers resolve their address space from `identity`. Refuse every mutation of a `global`, and refuse reads of a `role` global.

- [ ] **Step 4: run the suite, type-check, and confirm the removal's shape**

```bash
node --test packages/llm-agent/src/rag/__tests__/ 2>&1 | tail -6
npx tsc --noEmit -p packages/llm-agent/tsconfig.json; echo "EXIT=$?"
```

- [ ] **Step 5: commit.**

### Task B15: a session can own its registry, and hydrate it

`SessionGraphFactoryOptions.ragRegistry` is one shared `IRagRegistry` (`session-graph-factory.ts:93`), handed to every build (`:228`) and the object `closeSession` is called on at dispose (`:280`). Its own comment — *"GLOBAL … shared; the per-call scope filter isolates"* — is the model being replaced.

**Files:**
- Modify: `packages/llm-agent-libs/src/session/session-graph-factory.ts`
- Test: `packages/llm-agent-libs/src/__tests__/session-registry-factory.test.ts`

**Interfaces:**
- Produces: `ragRegistryFactory?: (identity: SessionGraphIdentity) => Promise<IRagRegistry>`.

- [ ] **Step 1: write the failing tests**

```
1. when ragRegistryFactory is given, it is called with the FULL identity — both sessionId
   and userId — and what it returns is the registry handed to buildAgent.
2. dispose closes THAT registry and does not call closeSession on the shared one.
3. when it is absent, behaviour is byte-for-byte today's: the shared ragRegistry is handed
   to buildAgent and closeSession is called on it at dispose.
```

The third test is the one that protects every existing consumer; write it first.

- [ ] **Step 2: run and watch them fail.**

- [ ] **Step 3: implement.** `async` because hydration lives inside it and `SessionAgentParts` carries no `userId` (`:33`) to defer it with; `build` is already `async build(identity): Promise<SessionGraph>` (`:166`), so nothing above changes. Absent, the old path runs untouched.

- [ ] **Step 4: run the package's suite — every existing session/teardown test must pass unedited**, including the two that assert on the `session_close_failed` message strings.

- [ ] **Step 5: commit.**

### Task B16: changelogs, docs, and the migration note

Documentation is not only the changelog: a stale doc describing the previous contract is worse than none, because it is believed.

**Files:**
- Modify: `CHANGELOG.md` (root) and each touched package's `CHANGELOG.md`, under `[Unreleased]` — the top section today is `## 26.0.0`, so the heading must be created
- Modify: `docs/ARCHITECTURE.md` if any statement in it is now stale (principle 8 is already in place)
- Modify: `docs/PIPELINES.md`, `docs/EXAMPLES.md`, `README.md` — wherever a credential, `apiKey`, a RAG collection tool or the session registry is described
- Modify: `docs/SECURITY_THREAT_MODEL.md` — AS-6's state changes from "latent" to mitigated once Task B14 lands

- [ ] **Step 1: find every place that documents what changed**

```bash
grep -rln "apiKey\|buildRagCollectionToolEntries\|ragRegistry\|RagToolContext" \
  README.md docs/ --include='*.md'
```

- [ ] **Step 2: write the `[Unreleased]` entries**, one per package, each saying what a consumer must do rather than what we did.

- [ ] **Step 3: carry the three migration items from the spec's §8 into the root changelog verbatim** — the `identity` argument, no longer reading identity from the tool context, and narrowing a widened logger option. Each with its before/after and the error the consumer will actually see.

- [ ] **Step 4: update AS-6** to say the mitigation has landed, and drop its Known Limitations row.

- [ ] **Step 5: run the whole repository green, then commit**

```bash
npm run lint:check && npx tsc -b && node --test packages/*/src/**/__tests__/*.test.ts 2>&1 | tail -10
```

- [ ] **Step 6: open the PR**

```bash
git push -u origin feat/credentials-and-rag-identity
gh pr create --title "feat: credential contracts, and RAG collections a caller cannot address past" \
  --body-file - <<'BODY'
Workstreams 2 and 3 of `docs/superpowers/specs/2026-09-16-auth-contracts-design.md`,
in one PR because one plan covers both and `interfaces-auth` is touched once.

Requires `@mcp-abap-adt/interfaces-auth@^1.1.0` (published first, per §4.4).

**Three source breaks, all deliberate** — §8 carries the migration note:
`buildRagCollectionToolEntries` requires an `identity`; `RagToolContext` loses its
declared `sessionId?`/`userId?`; and workstream 4's widened logger properties are
already in `[Unreleased]`. No version bump here — the version is decided at the
release by what has accumulated (§10).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
```

---

## Self-review

Run against the spec before starting Task A1, and again before Task B16.

- **Spec coverage.** §3 is workstream 1, merged. §4 and §4.6 → Tasks B2-B8. §5 and §5.1 → B14. §6.1-6.3 → B9-B13. §6.4 → B15. §7 is workstream 4, merged. §8's migration → B16. §9's answered items are decisions the tasks implement; §9.1, §9.6, §9.7, §9.8 and §9.10 are marked outside this release and have no task, by design.
- **Not in any task, deliberately:** `AccessCheck` anywhere (§5); a composite registry key (§6.4); delegated identity to HANA or Qdrant (§9.1); converging the two logger names (§9.9).
- **Type consistency.** The credential property is `credential` everywhere — B2 fixes the name and B3-B8 reuse it. `RagCollectionRecord`'s field is `name` for the logical name and `storeName` for the physical one, in B9, B11, B12 and B13 alike.
- **The gate.** No Phase B task may run before Task A3's two registry commands answer 1.1.0.

---

## Execution

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — tasks run in this session with checkpoints for review.

Which approach?
