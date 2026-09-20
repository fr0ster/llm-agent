# Authentication contracts and RAG identity — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take every secret out of every contract, so authenticating a provider means constructing it with a credential and nothing else; and make a caller's RAG collections reachable only through an instance built for that caller — closing llm-agent #304 without the framework ever judging a caller.

**Architecture:** Three credential contracts are published from `@mcp-abap-adt/interfaces-auth` and then accepted by the **constructors of concrete implementations**, typed for what each target speaks. No shared base, no framework-carried options object and no convenience config declares one. Where the framework must construct something later it asks the consumer for a factory. Serializable configuration keeps a non-secret `credentialRef`; `llm-agent-server` becomes the composition root that turns a reference into a credential. Authorization happens at construction: a pipeline's instances are narrowed to what one caller may address, and no access check enters the framework.

**Tech Stack:** TypeScript (strict), Node 22, npm workspaces. Tests are `node:test` per package, **run through the tsx loader** — every package's own script is `node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'`, and a bare `node --test file.ts` fails with `ERR_MODULE_NOT_FOUND` because a `.ts` test's `.js` imports do not resolve without it (verified against an existing test). Each command below uses the loader for that reason; `npm test -w packages/<name>` is equivalent. Biome for lint and format.

**Spec:** `docs/superpowers/specs/2026-09-16-auth-contracts-design.md` (this repository), review-clean as of `ff6a9142`. Read it before Task A1 — the plan argues from it and every task cites the section it implements. This plan was **re-derived** from that spec after ten review rounds changed §4 fundamentally; the previous derivation is in git history and its workstream 2 is wrong in every particular.

---

## Global Constraints

Copied from the spec. Every task's requirements implicitly include this section.

- **A secret belongs in a contract only where the secret IS the contract** (`docs/ARCHITECTURE.md` principle 9, spec §4.6.2). The test: remove it and see what is left. Remove `secret()` from `IApiKeyCredential` and nothing remains — so the credential contracts are the right home. Remove `apiKey` from `LLMProviderConfig` and a complete LLM configuration remains — so it was a passenger, and passengers go.
- **Construction is the authorization.** A credential is a constructor argument of the concrete implementation that uses it, typed per target. Once the object exists it is authorized, and no method on any contract carries a secret (§4.1).
- **A knob may vary per call; authorization may not.** `LLMCallOptions` already accepts `model`, `temperature`, `maxTokens` per request, so nothing may force a rebuild to change one (principle 9's corollary).
- **Where the framework must construct later, it takes a factory, never a secret.** `EmbedderFactory` has this shape; `BuildAgentDeps.makeLlm` already does too.
- **Serializable configuration carries a non-secret `credentialRef`** — a name the composition root resolves. The value never enters a loaded config object, which is what `${VAR}` substitution got wrong (§4.6.2).
- **An address is not a credential.** The AI Core endpoint is a field of its own, named `apiBaseUrl` on both SAP packages (§4.6.3).
- **Imports from the interfaces packages are `import type`** so nothing enters the runtime graph, while the package is a regular `dependencies` entry so the types resolve in each consumer's own `tsc` (§1).
- **`AccessCheck` is not written in either repository.** One acceptor, cloud-llm-hub, keeps it (§5, interfaces decision 26).
- **Interfaces is published before llm-agent adopts it.** An acceptor cannot merge a dependency on an unpublished version (§8).
- **One PR per repository.** Phase A is one PR in `mcp-abap-adt-interfaces`; Phase B is one PR in llm-agent covering both remaining workstreams (§10).
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
| `packages/interfaces-auth/src/auth/ICredentials.ts` | the three contracts (exists, uncommitted corrections) |
| `packages/interfaces-auth/src/__typechecks__/credentials.ts` | compile-only assertions — this package's tests (exists, uncommitted) |
| `packages/interfaces-auth/src/index.ts` | barrel (exists, committed) |
| `packages/interfaces-auth/CHANGELOG.md`, `package.json` | 1.0.0 → 1.1.0 at release |

### Phase B — `llm-agent`, by responsibility

**Contracts and helpers (in `@mcp-abap-adt/llm-agent`):**

| file | responsibility |
|---|---|
| `src/types.ts` | `LLMProviderConfig` **loses** `apiKey` |
| `src/interfaces/rag.ts` | `EmbedderFactoryConfig` **loses** `apiKey`; gains `RagCollectionRecord`, `RagCallerIdentity`, `RagCollectionAuthorization`, `describeCollections?`, `openCollection?`, `adopt?` |
| `src/credentials/static.ts` (**new**) | `staticApiKey`, `staticLogin` — the one-line conversions, exported from the barrel |
| `src/rag/corrections/errors.ts` | `CatalogRecordDeleteError` |
| `src/rag/mcp-tools/rag-collection-tools.ts` | the seven tool entries; required `identity`; `RagToolContext` without identity fields |
| `src/rag/registry/simple-rag-registry.ts` | `adopt()` honouring a store name that differs from the logical name |

**A new package:**

| package | responsibility |
|---|---|
| `packages/sap-aicore-auth` (**new**) | `serviceKeyCredential(raw): { credential; apiBaseUrl }` and `parseServiceKey` — the existing `TokenProvider` (`sap-aicore-embedder/src/auth.ts`) and parser (`service-key.ts`) moved out with their tests |

**Adoption, one row per package:**

| file | responsibility |
|---|---|
| `packages/{openai,anthropic,deepseek,ollama}-llm/src/**` | `credential` **replacing** `apiKey` in each constructor, resolved per request |
| `packages/openai-embedder/src/openai-embedder.ts` | same, and `apiKey` stops being required |
| `packages/sap-aicore-{llm,embedder}/src/**` | `credential: IBearerCredential` + `apiBaseUrl`; stop reading `AICORE_SERVICE_KEY` |
| `packages/{qdrant,pg-vector,hana-vector}-rag/src/**` | credential replacing `apiKey`/`user`/`password`; connection string address-only; catalog + record-first delete |
| `packages/llm-agent-mcp/src/servers/*.ts` (**new**) | typed `IMcpServer` implementations demanding a credential |
| `packages/llm-agent-libs/src/providers.ts` | `makeLlm`, `makeDefaultLlm`, `MakeLlmConfig`, `DefaultModelResolver` and the five dynamic-import shims **deleted** |
| `packages/llm-agent-libs/src/session/session-graph-factory.ts` | `ragRegistryFactory?`, session-owned registry and its disposal |
| `packages/llm-agent-server-libs/src/smart-agent/{smart-server,pipeline}.ts`, `skill-plugins-config.ts` | four DTOs lose secrets, gain `credentialRef`; `BuildAgentDeps.makeLlm` no longer defaulted |
| `packages/llm-agent-server/src/**` | the composition root: `credentialFor`, the provider dispatch, `IModelResolver` |

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

## Phase B, workstream 2 — every secret leaves every contract

One branch, one PR, both remaining workstreams. Line numbers were measured at `ff6a9142`; every task's first step re-reads the file, because a line number is a hint and the code is the fact.

```bash
cd ~/prj/llm-agent && git checkout main && git pull --ff-only
git checkout -b feat/credentials-and-rag-identity
```

**No version bump and no release in this phase.** Entries go under `[Unreleased]`; the version is decided at the release by what has accumulated (§10).

### Task B1: the dependency, the two conversions, and the two contracts that lose `apiKey`

The smallest change that makes every later task expressible: the contracts stop carrying a secret, and core ships the one-line conversions that make a call site's migration mechanical.

**Files:**
- Modify: the `package.json` of every package that imports a contract — `llm-agent`, `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag`, `openai-llm`, `anthropic-llm`, `deepseek-llm`, `ollama-llm`, `openai-embedder`, `sap-aicore-llm`, `sap-aicore-embedder`, `llm-agent-mcp`, **and `llm-agent-server`** — the composition root imports the contracts directly in Task B10, and a workspace would hide the omission through hoisting while a published server carried an undeclared dependency. **Not** `ollama-embedder`: it sends `Content-Type` and nothing else (`ollama.ts:42`, `:91`), so a credential there would be a member nobody calls.
- Create: `packages/llm-agent/src/credentials/static.ts`, exported from `packages/llm-agent/src/index.ts`
- Modify: `packages/llm-agent/src/types.ts` (`LLMProviderConfig`, ~`:78` — remove `apiKey`)
- Modify: `packages/llm-agent/src/interfaces/rag.ts` (`EmbedderFactoryConfig`, ~`:20` — remove `apiKey`)
- Test: `packages/llm-agent/src/credentials/__tests__/static.test.ts`

**Interfaces:**
- Consumes: `IApiKeyCredential`, `IBearerCredential`, `ISecretLoginCredential` from `@mcp-abap-adt/interfaces-auth@^1.1.0`.
- Produces: `staticApiKey(secret): IApiKeyCredential` and `staticLogin(principal, secret): ISecretLoginCredential`, both exported from `@mcp-abap-adt/llm-agent`. **Removes** `LLMProviderConfig.apiKey` and `EmbedderFactoryConfig.apiKey`. Tasks B3-B6 and B10 all use the two conversions.

- [ ] **Step 1: write the failing test**

```ts
// packages/llm-agent/src/credentials/__tests__/static.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { staticApiKey, staticLogin } from '../../index.js';

describe('the static conversions', () => {
  it('wrap a key that does not rotate, and are asked on every use', async () => {
    const c = staticApiKey('sk-live');
    assert.equal(c.kind, 'api-key');
    assert.equal(await c.secret(), 'sk-live');
    assert.equal(await c.secret(), 'sk-live');
  });

  it('wrap an identity and a secret, keeping them together', async () => {
    const c = staticLogin('rag_svc', 'hunter2');
    assert.equal(c.kind, 'secret-login');
    assert.equal(c.principal, 'rag_svc');
    assert.equal(await c.secret(), 'hunter2');
  });
});
```

- [ ] **Step 2: run it and watch it fail**

```bash
cd ~/prj/llm-agent
npx tsc --noEmit -p packages/llm-agent/tsconfig.json 2>&1 | head -5
```

Expected: `error TS2307: Cannot find module '@mcp-abap-adt/interfaces-auth'`. Any other failure means something else is wrong — read it.

- [ ] **Step 3: install the dependency**

```bash
for p in llm-agent qdrant-rag pg-vector-rag hana-vector-rag \
         openai-llm anthropic-llm deepseek-llm ollama-llm openai-embedder \
         sap-aicore-llm sap-aicore-embedder llm-agent-mcp; do
  npm pkg set "dependencies.@mcp-abap-adt/interfaces-auth=^1.1.0" -w "packages/$p"
done
npm install
grep -c '"@mcp-abap-adt/interfaces-auth"' package-lock.json   # expect > 0
```

- [ ] **Step 4: write the conversions**

```ts
// packages/llm-agent/src/credentials/static.ts
import type {
  IApiKeyCredential,
  ISecretLoginCredential,
} from '@mcp-abap-adt/interfaces-auth';

/**
 * A key that does not rotate is still a credential. This exists so no config needs
 * a second way to carry a secret: it is the one-line conversion that makes removing
 * the plain fields cheap for a consumer (§4.6.2).
 */
export function staticApiKey(secret: string): IApiKeyCredential {
  return { kind: 'api-key', secret: async () => secret };
}

export function staticLogin(
  principal: string,
  secret: string,
): ISecretLoginCredential {
  return { kind: 'secret-login', principal, secret: async () => secret };
}
```

- [ ] **Step 5: take `apiKey` off both contracts, and see what breaks**

Delete `apiKey?: string` from `LLMProviderConfig` (`types.ts`) and from `EmbedderFactoryConfig` (`interfaces/rag.ts`). Then find every reader, because the compiler is the inventory:

```bash
npx tsc -b 2>&1 | grep -E "error TS" | sed 's/(.*//' | sort -u
```

Expected: errors in `llm-agent-libs/src/providers.ts` (deleted in Task B8), the four concrete providers (Task B3), `openai-embedder` (B4), the SAP packages (B5) and the server libs (B9). **Write that list into the task report** — it is the real scope of workstream 2, measured rather than predicted, and later tasks are checked against it.

Do **not** fix them here. This task ends with a broken build in the packages the later tasks own, which is why it is the only task whose commit is allowed to leave `tsc -b` red.

- [ ] **Step 6: run the new test and commit**

```bash
node --import tsx/esm --test packages/llm-agent/src/credentials/__tests__/static.test.ts
npx tsc --noEmit -p packages/llm-agent/tsconfig.json; echo "CORE=$?"   # core itself must be 0
git add package.json package-lock.json packages/*/package.json \
        packages/llm-agent/src/credentials packages/llm-agent/src/index.ts \
        packages/llm-agent/src/types.ts packages/llm-agent/src/interfaces/rag.ts
git commit -m "feat(llm-agent)!: contracts carry no secret; staticApiKey/staticLogin convert a call site

LLMProviderConfig.apiKey and EmbedderFactoryConfig.apiKey are removed. A plain key is
one way of OBTAINING what an acceptor needs, not the thing itself, and a static key is
already a credential — so carrying both offered two ways to do one job (principle 9).

EmbedderFactoryConfig is the case that proves it: the framework passed that object to a
factory the CONSUMER wrote, carrying a secret from the consumer back to the consumer.

BREAKING: both fields are gone. staticApiKey(key) and staticLogin(user, pw) make each
call site a one-line change. The packages that read them are fixed in the tasks that
own them; this commit leaves them red on purpose."
```

### Task B2: `@mcp-abap-adt/sap-aicore-auth` — the token exchange, moved and exported

`AICORE_SERVICE_KEY` holds OAuth client credentials, not a token: something must exchange them, cache the result and refresh before expiry. That something exists and is tested — it is just not exported, and neither SAP package depends on the other, so it needs a home both can use.

**Files:**
- Create: `packages/sap-aicore-auth/` — `package.json`, `tsconfig.json`, `src/index.ts`
- Move: `packages/sap-aicore-embedder/src/auth.ts` → `packages/sap-aicore-auth/src/token-provider.ts` (with `auth.test.ts`)
- Move: `packages/sap-aicore-embedder/src/service-key.ts` → `packages/sap-aicore-auth/src/service-key.ts` (with `service-key.test.ts`)
- Create: `packages/sap-aicore-auth/src/service-key-credential.ts`
- Modify: `packages/sap-aicore-embedder/package.json` (depend on the new package), and its imports

**Interfaces:**
- Consumes: `IBearerCredential`.
- Produces: `serviceKeyCredential(raw): { credential: IBearerCredential; apiBaseUrl: string }` and `parseServiceKey(raw): ParsedServiceKey`. Tasks B5 and B10 both use them.

- [ ] **Step 1: read what is being moved, and confirm it is complete**

```bash
cd ~/prj/llm-agent
wc -l packages/sap-aicore-embedder/src/{auth,service-key,auth.test,service-key.test}.ts
grep -n "class TokenProvider\|grant_type=client_credentials\|cachedExpiryMs\|REFRESH_WINDOW_MS" \
  packages/sap-aicore-embedder/src/auth.ts
grep -n "export" packages/sap-aicore-embedder/src/service-key.ts
```

The `TokenProvider` already caches, tracks expiry and refreshes inside a window; `parseServiceKey` already returns `apiBaseUrl` from `serviceurls.AI_API_URL`. This task moves working code — it does not write an exchange.

- [ ] **Step 2: write the failing test for the one new thing**

```ts
// packages/sap-aicore-auth/src/__tests__/service-key-credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serviceKeyCredential } from '../index.js';

const key = JSON.stringify({
  clientid: 'cid',
  clientsecret: 'csecret',
  url: 'https://auth.example',
  serviceurls: { AI_API_URL: 'https://aicore.example/v2' },
});

describe('serviceKeyCredential', () => {
  it('returns the credential AND the address, because a service key holds both', async () => {
    const originalFetch = globalThis.fetch;
    let exchanges = 0;
    globalThis.fetch = (async () => {
      exchanges += 1;
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { credential, apiBaseUrl } = serviceKeyCredential(key);
      assert.equal(apiBaseUrl, 'https://aicore.example/v2', 'the address is not a credential');
      assert.equal(credential.kind, 'bearer');
      assert.equal(await credential.token(), 'tok');
      assert.equal(await credential.token(), 'tok');
      assert.equal(exchanges, 1, 'cached — the moved TokenProvider does this already');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parses nothing until asked, so a deployment without the key can still start', () => {
    // Constructing must not throw on a malformed key: nothing is read until token().
    assert.doesNotThrow(() => serviceKeyCredential(key));
  });
});
```

- [ ] **Step 3: run it and watch it fail** — the package does not exist.

```bash
node --import tsx/esm --test packages/sap-aicore-auth/src/__tests__/service-key-credential.test.ts
```

- [ ] **Step 4: create the package and move the two files**

```bash
mkdir -p packages/sap-aicore-auth/src/__tests__
git mv packages/sap-aicore-embedder/src/auth.ts packages/sap-aicore-auth/src/token-provider.ts
git mv packages/sap-aicore-embedder/src/auth.test.ts packages/sap-aicore-auth/src/token-provider.test.ts
git mv packages/sap-aicore-embedder/src/service-key.ts packages/sap-aicore-auth/src/service-key.ts
git mv packages/sap-aicore-embedder/src/service-key.test.ts packages/sap-aicore-auth/src/service-key.test.ts
```

Copy `package.json` and `tsconfig.json` from `sap-aicore-embedder` and adjust `name`, `description` and dependencies — it needs `@mcp-abap-adt/interfaces-auth` and nothing from the SDK. Then:

```ts
// packages/sap-aicore-auth/src/service-key-credential.ts
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { parseServiceKey } from './service-key.js';
import { TokenProvider } from './token-provider.js';

/**
 * A service key holds OAuth client credentials AND an address. The credential is the
 * secret half; `apiBaseUrl` is not a credential (§4.6.3) and goes to the provider's
 * own config. Parsing is deferred so a deployment that never names this reference
 * does not need the key to be present or valid.
 */
export function serviceKeyCredential(raw: string): {
  credential: IBearerCredential;
  apiBaseUrl: string;
} {
  let provider: TokenProvider | undefined;
  const parsed = () => parseServiceKey(raw);
  return {
    credential: {
      kind: 'bearer',
      async token() {
        const { clientId, clientSecret, tokenUrl } = parsed();
        provider ??= new TokenProvider({ clientId, clientSecret, tokenUrl });
        return provider.getToken();
      },
    },
    get apiBaseUrl() {
      return parsed().apiBaseUrl;
    },
  };
}
```

- [ ] **Step 5: repoint `sap-aicore-embedder` and run both packages' suites**

```bash
# The embedder needs it, and so does the composition root (Task B10) — declared here so
# hoisting never hides it.
npm pkg set "dependencies.@mcp-abap-adt/sap-aicore-auth=*" -w packages/sap-aicore-embedder
npm pkg set "dependencies.@mcp-abap-adt/sap-aicore-auth=*" -w packages/llm-agent-server
npm install
npm test -w packages/sap-aicore-auth
npm test -w packages/sap-aicore-embedder
npx tsc --noEmit -p packages/sap-aicore-auth/tsconfig.json; echo "AUTH=$?"
```

The two moved test files must pass **unedited** beyond their import paths — that is the evidence this was a move and not a rewrite.

- [ ] **Step 6: commit**

```bash
git add packages/sap-aicore-auth packages/sap-aicore-embedder package-lock.json
git commit -m "feat(sap-aicore-auth): the token exchange, moved out and exported

AICORE_SERVICE_KEY holds client credentials, not a token, so something must exchange,
cache and refresh them. That code existed and was tested — TokenProvider plus
parseServiceKey — and was internal to sap-aicore-embedder, which sap-aicore-llm does
not depend on. It moves to a package both can use, with its tests unedited beyond
their import paths.

serviceKeyCredential returns { credential, apiBaseUrl }: a service key holds an
address as well, an address is not a credential, and parsing is deferred so a
deployment that never names this reference needs no key at all."
```

### Task B3: the four concrete LLM providers take a credential instead of a key

Same change four times, so one task and one diff. Each config extends `LLMProviderConfig`, which lost `apiKey` in Task B1, so each now declares its own `credential` typed for what that target speaks — which is the point: a shared base could only type the union, and then `OpenAIConfig` would accept a login it cannot use.

**Files:**
- Modify: `packages/openai-llm/src/openai-provider.ts` (`OpenAIConfig`, ~`:15`)
- Modify: `packages/anthropic-llm/src/anthropic-provider.ts` (~`:15`)
- Modify: `packages/deepseek-llm/src/deepseek-provider.ts` (~`:12`)
- Modify: `packages/ollama-llm/src/ollama-provider.ts` (~`:8`) — note `OllamaProvider extends OpenAIProvider`, so check whether it inherits the change before writing it twice
- Test: `packages/openai-llm/src/__tests__/credential.test.ts` and one per package

**Interfaces:**
- Consumes: `IApiKeyCredential` (B1).
- Produces: `credential?: IApiKeyCredential` on all four configs. Ollama's stays **optional** — it accepts a key today (`llm-agent-libs/src/providers.ts:204` passes one) and a gateway in front of it may require one; the design replaces plain keys with typed credentials rather than removing the capability.

- [ ] **Step 1: find where each provider puts the secret on the wire**

```bash
cd ~/prj/llm-agent
for p in openai-llm anthropic-llm deepseek-llm ollama-llm; do
  echo "=== $p"
  grep -rn "apiKey\|Authorization\|x-api-key\|new OpenAI\|new Anthropic\|fetch(" \
    "packages/$p/src" --include='*.ts' | grep -v '\.test\.' | head -10
done
```

Record per provider whether the secret enters through our own header assembly (resolve there, per request) or through an SDK client constructed once (resolve through that SDK's own per-request hook, or state in the report that it cannot be and why). Do not proceed on an assumption.

- [ ] **Step 2: write the failing test — per request, not per construction**

```ts
// packages/openai-llm/src/__tests__/credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { OpenAIProvider } from '../index.js';

describe('OpenAIProvider credential', () => {
  it('presents a freshly asked secret on EVERY request', async () => {
    const seen: Array<string | null> = [];
    let n = 0;
    const rotating: IApiKeyCredential = { kind: 'api-key', secret: async () => `sk-${++n}` };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string | URL, init: RequestInit = {}) => {
      seen.push(new Headers(init.headers as HeadersInit).get('Authorization'));
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const p = new OpenAIProvider({ credential: rotating, model: 'gpt-4o-mini' });
      await p.chat([{ role: 'user', content: 'a' }]);
      await p.chat([{ role: 'user', content: 'b' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(seen, ['Bearer sk-1', 'Bearer sk-2'],
      'a secret resolved once at construction would be identical here');
  });

  it('accepts a static key through the conversion, so a call site is one line', async () => {
    const p = new OpenAIProvider({ credential: staticApiKey('sk-static'), model: 'm' });
    assert.ok(p);
  });

  it('refuses to construct with no credential at all', () => {
    // @ts-expect-error a provider that cannot authenticate is not constructible
    assert.throws(() => new OpenAIProvider({ model: 'm' }));
  });
});
```

Adjust the method name and response body per provider from Step 1, and write the twin for anthropic (`x-api-key`), deepseek and ollama (where the credential is optional, so its third case asserts construction **succeeds** without one).

- [ ] **Step 3: run them and watch them fail.**

```bash
for p in openai-llm anthropic-llm deepseek-llm ollama-llm; do
  node --import tsx/esm --test "packages/$p/src/__tests__/credential.test.ts"
done
```

- [ ] **Step 4: implement**

```ts
// each provider's own config, typed for what THIS target speaks — which is why the
// shared base carries nothing (§4.6.2)
export interface OpenAIConfig extends LLMProviderConfig {
  credential: IApiKeyCredential;        // required: it cannot authenticate without one
  model?: string;
}

// and resolved in the request path, never the constructor: a secret resolved once
// would be frozen for the object's lifetime
private async authorization(): Promise<string> {
  return `Bearer ${await this.credential.secret()}`;
}
```

Ollama's stays `credential?: IApiKeyCredential`, and its header is set only when one is configured. `OllamaProvider extends OpenAIProvider`, so check whether it inherits the change before writing it twice.

- [ ] **Step 5: run all four suites and type-check**

```bash
for p in openai-llm anthropic-llm deepseek-llm ollama-llm; do
  npm test -w "packages/$p"; npx tsc --noEmit -p "packages/$p/tsconfig.json"; echo "$p=$?"
done
```

- [ ] **Step 6: commit**

```bash
git add packages/openai-llm/src packages/anthropic-llm/src packages/deepseek-llm/src packages/ollama-llm/src
git commit -m "feat!: the four LLM providers take a credential, resolved per request

Each config extends LLMProviderConfig, which no longer carries apiKey, so each declares
its own credential typed for what that target speaks — a shared base could only type
the union, and then OpenAIConfig would accept a login it cannot use.

Resolved in the request path, not the constructor: a secret resolved once would be
frozen for the object's lifetime, which is the one thing the contract insists against.
Ollama's stays optional, because it accepts a key today and a gateway may require one."
```

### Task B4: `openai-embedder` takes a credential; `ollama-embedder` is untouched

**Files:**
- Modify: `packages/openai-embedder/src/openai-embedder.ts` — `apiKey: string` required (`:6`), thrown on when missing (`:19`), stored (`:25`), read at two header sites (`:48`, `:109`), both already inside `await fetch(…)`
- Test: `packages/openai-embedder/src/__tests__/credential.test.ts`

**Interfaces:**
- Consumes: `IApiKeyCredential` and `staticApiKey` (B1).
- Produces: `OpenAiEmbedderConfig.credential: IApiKeyCredential`, **required**, replacing `apiKey: string`. Task B10 constructs this, and `EmbedderFactory` implementations in any consumer construct it too.

- [ ] **Step 1: write the failing test**

```ts
// packages/openai-embedder/src/__tests__/credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IApiKeyCredential } from '@mcp-abap-adt/interfaces-auth';
import { OpenAiEmbedder } from '../openai-embedder.js';

describe('OpenAiEmbedder credential', () => {
  it('asks per request, so a rotated secret rotates', async () => {
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
      const e = new OpenAiEmbedder({ model: 'text-embedding-3-small', credential });
      await e.embed(['a']);
      await e.embed(['b']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(seen, ['Bearer sk-1', 'Bearer sk-2']);
  });

  it('still throws when it has no credential, with the message its existing test asserts', () => {
    // @ts-expect-error no credential configured
    assert.throws(() => new OpenAiEmbedder({ model: 'm' }), /API key is required/);
  });
});
```

- [ ] **Step 2: run it and watch it fail**

```bash
node --import tsx/esm --test packages/openai-embedder/src/__tests__/credential.test.ts
```

- [ ] **Step 3: implement**

The class keeps **no config object** — it copies fields (`:14-16`, `:25-30`) — so there is no `this.config` to hand a helper:

```ts
export interface OpenAiEmbedderConfig {
  credential: IApiKeyCredential;        // was: apiKey: string
  baseURL?: string;
  model: string;
}

export class OpenAiEmbedder implements IEmbedderBatch {
  private readonly credential: IApiKeyCredential;
  private readonly baseURL: string;
  readonly model: string;

  constructor(config: OpenAiEmbedderConfig) {
    // The existing message, verbatim: openai-embedder.test.ts asserts on it.
    if (!config.credential) throw new Error('OpenAI API key is required for embedding');
    if (!config.model) throw new Error("OpenAIEmbedder requires a 'model'");
    this.credential = config.credential;
    this.baseURL = (config.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.model = config.model;
  }

  /** Asked per request, from the field — there is no config object to pass. */
  private async authorization(): Promise<string> {
    return `Bearer ${await this.credential.secret()}`;
  }
}
```

Both header sites (`:48`, `:109`) already sit inside `await fetch(…)`, so `Authorization: await this.authorization()` costs no signature.

- [ ] **Step 4: run both suites and type-check**

```bash
npm test -w packages/openai-embedder
npx tsc --noEmit -p packages/openai-embedder/tsconfig.json; echo "EXIT=$?"
```

- [ ] **Step 5: commit**

```bash
git add packages/openai-embedder/src
git commit -m "feat(openai-embedder)!: take a credential, asked per embed call

apiKey was required and held for the object's lifetime; a credential replaces it and is
asked per request. The constructor's existing message is unchanged, because
openai-embedder.test.ts asserts on it and passes unedited.

ollama-embedder is deliberately untouched: it sends Content-Type and nothing else
(ollama.ts:42, :91), so a credential there would be a member nobody calls."
```

### Task B5: the SAP packages take a bearer credential and an `apiBaseUrl`, and stop reading the environment

**Files:**
- Modify: `packages/sap-aicore-llm/src/sap-core-ai-provider.ts` — the credential object at `:29-34` (which holds the service URL too), its read at `:164`, the per-call client at `:561`, destination sites `:71`, `:165`, `:564`
- Modify: `packages/sap-aicore-embedder/src/{foundation-embedder,orchestration-embedder}.ts` — its own `TokenProvider` usage (now in `sap-aicore-auth`), `apiBaseUrl` at `:8`, the header at `:98-101`, and the two-argument `new OrchestrationEmbeddingClient(config, deploymentConfig)` at `orchestration-embedder.ts:50`
- Test: one per package

**Interfaces:**
- Consumes: `IBearerCredential`; `serviceKeyCredential` from Task B2.
- Produces: `credential: IBearerCredential` and `apiBaseUrl: string` on `SapCoreAIConfig` and on the embedder's config, with **no** env fallback inside either, plus an exported `buildDestination`. Task B10's `sap-ai-sdk` branch constructs both from one `serviceKeyCredential` call.

- [ ] **Step 1: write the failing tests** — the destination carries a freshly asked token, `apiBaseUrl` comes from config, and **no** request goes to a token endpoint from inside the provider:

```ts
// packages/sap-aicore-llm/src/__tests__/bearer-credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { buildDestination } from '../sap-core-ai-provider.js';

describe('buildDestination', () => {
  it('asks per call and keeps the address out of the credential', async () => {
    let n = 0;
    const credential: IBearerCredential = { kind: 'bearer', token: async () => `t${++n}` };
    const first = await buildDestination({ apiBaseUrl: 'https://aicore', credential });
    const second = await buildDestination({ apiBaseUrl: 'https://aicore', credential });
    assert.equal(first.headers?.Authorization, 'Bearer t1');
    assert.equal(second.headers?.Authorization, 'Bearer t2');
    assert.equal(first.url, 'https://aicore');
    assert.equal(first.authentication, 'NoAuthentication');
  });
});
```

- [ ] **Step 2: run them and watch them fail**

```bash
node --import tsx/esm --test packages/sap-aicore-llm/src/__tests__/bearer-credential.test.ts
node --import tsx/esm --test packages/sap-aicore-embedder/src/__tests__/bearer-credential.test.ts
```

- [ ] **Step 3: implement**

```ts
// packages/sap-aicore-llm/src/sap-core-ai-provider.ts
export interface SapCoreAIConfig extends LLMProviderConfig {
  credential: IBearerCredential;
  /** The address, a field of its own — not part of the credential (§4.6.3). */
  apiBaseUrl: string;
  model?: string;
}

/** The constructed-destination shape the SDK documents. Built per call, which is free:
 *  the client is already rebuilt per call because tools change between them. */
export async function buildDestination(cfg: {
  apiBaseUrl: string;
  credential: IBearerCredential;
}): Promise<{ url: string; authentication: 'NoAuthentication'; headers: Record<string, string> }> {
  return {
    url: cfg.apiBaseUrl,
    authentication: 'NoAuthentication',
    headers: { Authorization: `Bearer ${await cfg.credential.token()}` },
  };
}
```

Use the constructed-destination shape the SDK documents — `{ url, authentication: 'NoAuthentication', headers: { Authorization } }`. Do **not** reach for `authTokens`: its TypeScript type is `{ type; value; expiresIn?; error: string | null }` with no `http_header` field, so the shape in blog posts does not compile. Build the destination in the **per-call** path, which already exists because the client is rebuilt per call. Delete the `AICORE_SERVICE_KEY` read: the composition root supplies the credential (Task B10), and `config-validator.ts:72`'s rule requiring that variable moves with it.

- [ ] **Step 4: run both suites and type-check**

```bash
npm test -w packages/sap-aicore-llm
npm test -w packages/sap-aicore-embedder
npx tsc --noEmit -p packages/sap-aicore-llm/tsconfig.json; echo "LLM=$?"
npx tsc --noEmit -p packages/sap-aicore-embedder/tsconfig.json; echo "EMB=$?"
grep -rn "AICORE_SERVICE_KEY" packages/sap-aicore-llm/src packages/sap-aicore-embedder/src \
  --include='*.ts' | grep -v '\.test\.' || echo "  neither provider reads the env any more"
```

The last command must print the “neither” line: a provider that still reads it has two sources, and the precedence rule this design deleted would be back.

- [ ] **Step 5: commit**

```bash
git add packages/sap-aicore-llm/src packages/sap-aicore-embedder/src
git commit -m "feat(sap-aicore-*)!: a bearer credential and an apiBaseUrl, and no env read

The credential object held the service URL alongside the OAuth input; the address is not
a credential, so it becomes its own apiBaseUrl field — the name parseServiceKey returns
and sap-aicore-embedder already used. The destination is built per call, which is free,
because the client is already rebuilt per call.

AICORE_SERVICE_KEY is no longer read here. A provider that reads an env var when handed
no credential has two sources again; the composition root reads it and builds the one
credential (Task B10)."
```

### Task B6: the vector stores take a credential, and a connection string carries the address only

**Files:**
- Modify: `packages/qdrant-rag/src/{qdrant-rag,qdrant-rag-provider}.ts` (`apiKey` at `:32`/`:18`, header sites `:56`+`:85`, `:79`, `:108` — all already async)
- Modify: `packages/pg-vector-rag/src/connection.ts` and `packages/hana-vector-rag/src/connection.ts` (configs, and `resolvePgConnectArgs` `:27` / `resolveHanaConnectArgs` `:25`)
- Test: one per package

**Interfaces:**
- Consumes: `IApiKeyCredential` (qdrant), `ISecretLoginCredential` (pg, hana), `staticLogin` (B1).
- Produces: `credential` on `QdrantRagConfig`, `PgVectorRagConfig` and `HanaVectorRagConfig`, replacing `apiKey` and `user`/`password`; `resolvePgConnectArgs` and `resolveHanaConnectArgs` become `async` and refuse a connection string carrying credentials. Tasks B13 and B14 build on these same configs, and B10 constructs them.

- [ ] **Step 1: write the failing tests.** Three behaviours for pg and hana, and the third is the one that changes from the previous derivation:

```ts
// packages/pg-vector-rag/src/__tests__/credential.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { staticLogin } from '@mcp-abap-adt/llm-agent';
import { resolvePgConnectArgs } from '../connection.js';

describe('resolvePgConnectArgs', () => {
  it('takes the identity and the secret from the credential', async () => {
    const args = await resolvePgConnectArgs({
      host: 'h', collectionName: 't', credential: staticLogin('cred_user', 'cred_pw'),
    });
    assert.equal(args.user, 'cred_user');
    assert.equal(args.password, 'cred_pw');
  });

  it('accepts a connection string that carries the ADDRESS only', async () => {
    const args = await resolvePgConnectArgs({
      connectionString: 'postgres://h:5432/db', collectionName: 't',
      credential: staticLogin('cred_user', 'cred_pw'),
    });
    assert.equal(args.user, 'cred_user');
  });

  it('REFUSES a connection string carrying credentials, naming the fix', async () => {
    await assert.rejects(
      () => resolvePgConnectArgs({
        connectionString: 'postgres://u:pw@h/db', collectionName: 't',
        credential: staticLogin('cred_user', 'cred_pw'),
      }),
      /staticLogin/,
      'silently ignoring the embedded password is the failure this replaces',
    );
  });
});
```

Write the hana twin against `resolveHanaConnectArgs` (asserting `uid`/`pwd`, and an `hdbsql://u:pw@h:443` string being refused), and the qdrant one asserting the `api-key` header is asked per request.

- [ ] **Step 2: run them and watch them fail**

```bash
for p in pg-vector-rag hana-vector-rag qdrant-rag; do
  node --import tsx/esm --test "packages/$p/src/__tests__/credential.test.ts"
done
```

- [ ] **Step 3: implement**

```ts
// packages/pg-vector-rag/src/connection.ts
export interface PgVectorRagConfig {
  /** The ADDRESS only. A string carrying credentials is refused below. */
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  credential: ISecretLoginCredential;    // was: user?: string; password?: string
  collectionName: string;
  // … the rest unchanged
}

export async function resolvePgConnectArgs(cfg: PgVectorRagConfig): Promise<PgPoolConfig> {
  if (cfg.connectionString && /\/\/[^/@]*:[^/@]*@/.test(cfg.connectionString)) {
    throw new Error(
      'connectionString must carry the address only; pass the identity and secret as ' +
        'a credential — staticLogin(user, password)',
    );
  }
  const user = cfg.credential.principal;
  const password = await cfg.credential.secret();
  // … then the existing branches, with user/password applied
}
```

Add `credential` and **delete** `user`/`password` from both configs. Each resolver becomes `async` — invisible outside, because neither is in its package's barrel and both packages declare a closed `exports` map with only `"."`, and each resolver's single production caller is already `async` (`pg-vector-rag.ts:62`, `hana-vector-rag.ts:54`). A connection string containing credentials throws at construction with `staticLogin` named in the message. For qdrant, make the header builders `async` — `_headers()` is private with one caller inside `async _fetch`.

- [ ] **Step 4: run all three suites and type-check**

```bash
for p in pg-vector-rag hana-vector-rag qdrant-rag; do
  npm test -w "packages/$p"; npx tsc --noEmit -p "packages/$p/tsconfig.json"; echo "$p=$?"
done
```

The existing `connection.test.ts` in pg and hana needs `await` on the resolver — that edit is expected. Any other test that breaks is a finding.

- [ ] **Step 5: commit**

```bash
git add packages/pg-vector-rag/src packages/hana-vector-rag/src packages/qdrant-rag/src
git commit -m "feat(rag stores)!: a credential replaces apiKey, user and password

One source, so there is nothing to rank: the two packages disagreed about connection
string versus discrete fields (pg returns early and ignores them, hana fills gaps with
??=), and that disagreement disappears with the fields that caused it. A connection
string now carries the address only and one carrying credentials is refused at
construction, with staticLogin named in the message — not silently outranked.

The resolvers become async, which is invisible: neither is in its barrel, both packages
declare a closed exports map with only ".", and each resolver's one production caller
is already async."
```

### Task B7: two typed `IMcpServer` implementations, each demanding its own credential

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
import type { IApiKeyCredential, IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
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
      { url: 'https://mcp.example/mcp', auth: { scheme: 'bearer', credential }, headers: { 'X-Trace': 'abc' } },
      f.factory,
    );

    const client = await server.start();
    assert.equal(client, f.client, 'start() returns the factory\u2019s client');
    assert.equal(f.configs.length, 1);
    const config = f.configs[0];   // already McpConnectionConfig — no narrowing needed
    assert.equal(config.headers?.Authorization, 'Bearer t1');
    assert.equal(config.headers?.['X-Trace'], 'abc', 'static headers survive');
    assert.equal(asked, 1, 'asked once per connection: headers() is synchronous (see above)');
  });

  it('puts an API key in the header the TARGET names, not in Authorization', async () => {
    const f = fakeFactory();
    const credential: IApiKeyCredential = { kind: 'api-key', secret: async () => 'k-1' };
    await new HttpMcpServer(
      { url: 'https://mcp.example/mcp', auth: { scheme: 'header', header: 'x-api-key', credential } },
      f.factory,
    ).start();
    const config = f.configs[0];
    assert.equal(config.headers?.['x-api-key'], 'k-1');
    assert.equal(
      config.headers?.Authorization,
      undefined,
      'the api-key contract says nothing about placement, so assuming Bearer would leave ' +
        'a target that wants x-api-key unauthenticated',
    );
  });

  it('will not accept a bearer credential where a header key is declared', () => {
    const f = fakeFactory();
    const bearer: IBearerCredential = { kind: 'bearer', token: async () => 't' };
    // @ts-expect-error each variant demands the one kind it can use
    void new HttpMcpServer(
      { url: 'https://mcp.example/mcp', auth: { scheme: 'header', header: 'x-api-key', credential: bearer } },
      f.factory,
    );
  });

  it('a static Authorization cannot overwrite the credential', async () => {
    const f = fakeFactory();
    const credential: IBearerCredential = { kind: 'bearer', token: async () => 'tok' };
    await new HttpMcpServer(
      { url: 'https://mcp.example/mcp', auth: { scheme: 'bearer', credential }, headers: { Authorization: 'Bearer stale' } },
      f.factory,
    ).start();
    const config = f.configs[0];   // already McpConnectionConfig — no narrowing needed
    assert.equal(config.headers?.Authorization, 'Bearer tok');
  });

  it('tolerates a factory that returns no close at all', async () => {
    const client = { listTools: async () => [] } as never;
    const server = new HttpMcpServer(
      { url: 'https://mcp.example/mcp', auth: { scheme: 'none' } },
      async () => ({ client }),          // `close` is optional on the contract
    );
    await server.start();
    await server.stop();                 // must not throw
  });

  it('stop() closes exactly once, and is safe to call twice', async () => {
    const f = fakeFactory();
    const server = new HttpMcpServer({ url: 'https://mcp.example/mcp', auth: { scheme: 'none' } }, f.factory);
    await server.start();
    await server.stop();
    await server.stop();
    assert.equal(f.closes(), 1, 'a second stop must not close a connection it does not hold');
  });

  it('stop() before start() does nothing rather than throwing', async () => {
    const f = fakeFactory();
    await new HttpMcpServer({ url: 'https://mcp.example/mcp', auth: { scheme: 'none' } }, f.factory).stop();
    assert.equal(f.closes(), 0);
  });

  it('a second start() refuses rather than leaking the first connection', async () => {
    const f = fakeFactory();
    const server = new HttpMcpServer({ url: 'https://mcp.example/mcp', auth: { scheme: 'none' } }, f.factory);
    await server.start();
    await assert.rejects(() => server.start(), /already started/);
    assert.equal(f.configs.length, 1);
  });

  it('a reconnect asks the credential again', async () => {
    const f = fakeFactory();
    let asked = 0;
    const credential: IBearerCredential = { kind: 'bearer', token: async () => `t${++asked}` };
    const server = new HttpMcpServer(
      { url: 'https://mcp.example/mcp', auth: { scheme: 'bearer', credential } },
      f.factory,
    );
    await server.start();
    await server.stop();
    await server.start();
    const second = f.configs[1];
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
    const config = f.configs[0];
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

/**
 * Where the material goes is the accepting implementation's business (§4): an api key is
 * the same key whether a server wants it as `Authorization: Bearer`, `x-api-key` or
 * `api-key`. So the scheme is declared, not guessed — and declaring it is also what keeps
 * this off the shared union §4.6.2 forbids: each variant demands the ONE kind it can use,
 * and `'none'` makes an unauthenticated target a statement rather than an omission.
 */
export type HttpMcpAuth =
  | { readonly scheme: 'bearer'; readonly credential: IBearerCredential }
  | { readonly scheme: 'header'; readonly header: string; readonly credential: IApiKeyCredential }
  | { readonly scheme: 'none' };

export interface HttpMcpServerConfig {
  url: string;
  /** Required: a target either authenticates or says it does not. */
  auth: HttpMcpAuth;
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
    const { url, auth, headers, timeout } = this.cfg;
    // Resolved HERE, once per connection, because the header seam is synchronous and
    // merged at connect. A reconnect asks again; that is the refresh.
    const authHeaders = await (async (): Promise<Record<string, string>> => {
      switch (auth.scheme) {
        case 'none':
          return {};
        case 'bearer':
          return { Authorization: `Bearer ${await auth.credential.token()}` };
        case 'header':
          // The target named its own header: x-api-key, api-key, or whatever it speaks.
          return { [auth.header]: await auth.credential.secret() };
      }
    })();
    const config: McpConnectionConfig = {
      // `type` is REQUIRED on McpConnectionConfig ('http' | 'stdio',
      // mcp-connection-strategy.ts:33). An earlier draft omitted it and hid the
      // omission behind `as McpConnectionConfig`; no cast is needed once it is there.
      type: 'http',
      url,
      // The credential goes LAST so a stale static header cannot win.
      headers: { ...headers, ...authHeaders },
      ...(timeout !== undefined ? { timeout } : {}),
    };

    const held = await this.createClient(config);
    this.held = held;
    return held.client;
  }

  async stop(): Promise<void> {
    const held = this.held;
    if (!held) return;          // never started, or already stopped
    this.held = undefined;      // cleared FIRST, so a failing close cannot be retried into a double close
    // `close?` is OPTIONAL on McpClientFactoryResult (mcp-connection-strategy.ts:68):
    // a custom factory may legitimately have nothing to clean up, and calling it
    // unconditionally does not compile under strict.
    await held.close?.();
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
      // `args?: string[]` is mutable on the contract, so copy rather than pass a
      // readonly array through a cast.
      args: [...(args ?? [])],
      // The contract's own docstring already states the rule this satisfies:
      // "Pass the caller's own values here; never in `args`, which are visible
      // in `ps`" (mcp-connection-strategy.ts:45-46).
      env: {
        ...(env ?? {}),
        ...(credential && credentialEnvVar
          ? { [credentialEnvVar]: await credential.token() }
          : {}),
      },
      ...(timeout !== undefined ? { timeout } : {}),
    };

    const held = await this.createClient(config);
    this.held = held;
    return held.client;
  }

  async stop(): Promise<void> {
    const held = this.held;
    if (!held) return;
    this.held = undefined;
    await held.close?.();       // optional on the contract — see the http class
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

### Task B8: delete the provider dispatch from `llm-agent-libs`

The single largest removal, and the one that makes the rest true: while a library restates five constructors it does not own, a secret has to travel through a framework config to feed them.

**Files:**
- Modify: `packages/llm-agent-libs/src/providers.ts` — delete `MakeLlmConfig` (`:27`), `makeLlm` (`:173`), `makeDefaultLlm` (`:302`), `DefaultModelResolver` (`:314`) and the five `load*` dynamic-import shims (`:70`, `:88`, `:106`, `:124`, `:142`); the file may cease to exist
- Modify: `packages/llm-agent-libs/src/index.ts` — drop `MakeLlmConfig`, `makeDefaultLlm`, `makeLlm` (`:177-179`) and `DefaultModelResolver`
- Modify: every in-repo caller the compiler names

**Interfaces:**
- Produces: nothing. It **removes** `makeLlm`, `makeDefaultLlm`, `MakeLlmConfig`, `DefaultModelResolver`. `IModelResolver` in core is **untouched** — what held a config was the implementation.

- [ ] **Step 1: write the failing test — a removal's test is that the export is gone**

```ts
// packages/llm-agent-libs/src/__tests__/no-provider-dispatch.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as libs from '../index.js';

describe('llm-agent-libs no longer dispatches providers', () => {
  for (const name of ['makeLlm', 'makeDefaultLlm', 'DefaultModelResolver']) {
    it(`does not export ${name}`, () => {
      assert.equal(
        (libs as Record<string, unknown>)[name],
        undefined,
        `${name} restated a constructor this package does not own, which is why a ` +
          'secret had to travel through MakeLlmConfig to feed it',
      );
    });
  }

  it('still exports the builder, which is the seam that replaces them', () => {
    assert.equal(typeof libs.SmartAgentBuilder, 'function');
  });
});
```

- [ ] **Step 2: run it and watch it fail** — all three are still exported.

```bash
node --import tsx/esm --test packages/llm-agent-libs/src/__tests__/no-provider-dispatch.test.ts
```

- [ ] **Step 3: delete, then let the compiler name every caller**

```bash
npx tsc -b 2>&1 | grep -E "error TS" | sed 's/(.*//' | sort -u
```

Compare that list against the one Task B1's Step 5 recorded. Each caller is either in `llm-agent-server-libs` (Task B9 or B10 owns it) or a test. The known ones: `build-dag-coordinator-deps.ts:89`, `:102`, `:174`, `plan-analysis.ts:461`, `controller.ts:336`, `dag.ts:49`, `coordinator-resolvers.ts:191`, `role-llm-resolver.ts:11`, `:51`, `:66`, `smart-server.ts:954` (the default), `:1036`, `:1043`, `:1052`, `:1875`, `:1888`, `:1900`, `:2020`, and the shape restated as a type at `server-context.ts:26`, `role-llm-resolver.ts:29`, `:38`, `coordinator-resolvers.ts:176`.

**They keep calling a `makeLlm`** — just the injected one from `BuildAgentDeps`, never a library function. The type restatements stay as they are: the seam's signature does not change, and no `role` parameter is added, because those call sites name roles a closed union cannot (`coordinator-resolvers.ts:165` documents the chain as "top-level `llm.<name>` → `llm.main` → `pipelineFallback`").

- [ ] **Step 4: run the whole repository, and expect it red only where B9 and B10 will land**

```bash
npx tsc -b 2>&1 | tail -20
```

Write the remaining errors into the report. If any error is in a package **other** than `llm-agent-server-libs` or `llm-agent-server`, stop: something outside the two composition layers was depending on the dispatch, and that is a finding the spec has not accounted for.

- [ ] **Step 5: commit**

```bash
git add packages/llm-agent-libs/src
git commit -m "feat(llm-agent-libs)!: delete the provider dispatch

makeLlm loaded five provider packages by dynamic import() as optional peers — none of
them declared as a dependency — and restated each of their constructor shapes by hand
(:77, :95, :113, :131, :156). That private copy of five contracts it does not own was
the only reason a secret had to sit in a framework config: MakeLlmConfig.apiKey exists
to feed new DeepSeekProvider({ apiKey }) at :186.

It is also a variation point the consumer owns (principle 5) and glue that belongs to
the assembly (principle 2), and the seam already exists: withMainLlm(llm: ILlm).
DefaultModelResolver goes with it, because building a provider for a newly chosen model
needs a credential. IModelResolver itself is untouched.

BREAKING: makeLlm, makeDefaultLlm, MakeLlmConfig and DefaultModelResolver are removed."
```

### Task B9: the four server DTOs lose their secrets and gain `credentialRef`

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` — `SmartServerLlmConfig.apiKey` (required, `:129`), `SmartServerRagConfig.user`/`password` (`:167-168`), and the default at `:954`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/pipeline.ts` — `PipelineLlmProviderConfig` (`:14-26`), `PipelineRagStoreConfig.apiKey` (`:32`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/skill-plugins-config.ts` — the qdrant store variant (`:19`), threaded at `skill-plugins-host-factory.ts:271`, `:310` and `controller-skill-pipeline-builder.ts:16`, `:47`
- Modify: `packages/llm-agent-server-libs/src/smart-agent/config-validator.ts` — the `AICORE_SERVICE_KEY` rule (`:72`) leaves; a missing `makeLlm` becomes a startup refusal
- Modify: the YAML template and `yaml-loader.ts` (`:15-21`, `:68-81`)
- Test: `packages/llm-agent-server-libs/src/__tests__/credential-ref.test.ts`

**Interfaces:**
- Produces: `credentialRef?: string` on `SmartServerLlmConfig`, `PipelineLlmProviderConfig`, `PipelineRagStoreConfig`, `SmartServerRagConfig` and the qdrant skill store. `BuildAgentDeps.makeLlm` keeps its signature and **loses its default**.

- [ ] **Step 1: write the failing tests**

```ts
// packages/llm-agent-server-libs/src/__tests__/credential-ref.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadYamlConfig } from '../smart-agent/yaml-loader.js';   // confirm the name in Step 2
import { SmartServer } from '../smart-agent/smart-server.js';

describe('serializable configuration carries no secret', () => {
  it('loads a credentialRef and never a value', () => {
    const cfg = loadYamlConfig(`
llm:
  main:
    provider: deepseek
    credentialRef: PRIMARY
    model: deepseek-chat
`);
    assert.equal(cfg.llm?.main?.credentialRef, 'PRIMARY');
    assert.equal((cfg.llm?.main as Record<string, unknown>).apiKey, undefined);
  });

  it('refuses a config that still carries apiKey, naming credentialRef', () => {
    assert.throws(
      () => loadYamlConfig('llm:\n  main:\n    provider: openai\n    apiKey: sk-live\n'),
      /credentialRef/,
      'a silently ignored apiKey would leave an operator believing it was used',
    );
  });

  it('refuses to start without BuildAgentDeps.makeLlm, naming the seam', async () => {
    await assert.rejects(
      () => new SmartServer({ llm: { provider: 'openai', model: 'gpt-4o' } } as never).start(),
      /makeLlm/,
      'the library no longer defaults it, so silence here would be a server with no LLM',
    );
  });
});
```

- [ ] **Step 2: confirm the loader's real export name and run the tests**

```bash
grep -n "^export" packages/llm-agent-server-libs/src/smart-agent/yaml-loader.ts | head
node --import tsx/esm --test packages/llm-agent-server-libs/src/__tests__/credential-ref.test.ts
```

- [ ] **Step 3: implement**

```ts
// smart-server.ts — serializable, so a NAME and never a value
export interface SmartServerLlmConfig {
  provider?: 'deepseek' | 'openai' | 'anthropic' | 'sap-ai-sdk' | 'ollama';
  /** Names a credential the composition root resolves. Omit it and the root's default
   *  applies. The value never enters this object, which is what ${VAR} got wrong. */
  credentialRef?: string;
  url?: string;
  model?: string;
  // apiKey is GONE
}

// and the default that no longer exists (was :954)
this._deps = {
- makeLlm: deps.makeLlm ?? ((cfg) => this._makeLlmDefault(cfg)),
+ makeLlm: deps.makeLlm ?? (() => {
+   throw new Error(
+     'BuildAgentDeps.makeLlm is required: the library no longer constructs providers, ' +
+       'because doing so meant carrying a secret through a framework config',
+   );
+ }),
  // … the other seams unchanged
};
```

Delete `apiKey` from the three config types and `user`/`password` from `SmartServerRagConfig`; add `credentialRef?: string` to all four plus the qdrant skill store. **Keep** the loader, the `${VAR}` substitution machinery and the schema validation in this package — once the shape carries no secret, loading a file is not handling one. Add the two refusals: an `apiKey` still present in YAML, and a missing `makeLlm`. Remove `deps.makeLlm ?? …` at `:954` so the seam is genuinely required. Move `config-validator.ts:72`'s `AICORE_SERVICE_KEY` rule out — only the composition root knows whether it holds a credential.

- [ ] **Step 4: run the package's whole suite**

```bash
npm test -w packages/llm-agent-server-libs 2>&1 | tail -8
npx tsc --noEmit -p packages/llm-agent-server-libs/tsconfig.json; echo "EXIT=$?"
grep -rn "apiKey" packages/llm-agent-server-libs/src --include='*.ts' | grep -v '\.test\.' \
  || echo "  no secret field left in this package's source"
```

Fixtures that set `apiKey` must become `credentialRef` — that edit is expected, and is the migration in miniature. A test that breaks for another reason is a finding.

- [ ] **Step 5: update the YAML template**

```yaml
llm:
  main:
    provider: deepseek
    # nothing here: the composition root's default entry applies
    model: deepseek-chat
  classifier:
    provider: openai
    credentialRef: OPENAI_KEY_CHEAP     # name a second account when you want one
    model: gpt-4o-mini
```

- [ ] **Step 6: commit**

```bash
git add packages/llm-agent-server-libs/src
git commit -m "feat(llm-agent-server-libs)!: serializable config carries a reference, never a secret

Four DTOs lose their secret fields and gain credentialRef: SmartServerLlmConfig.apiKey
(required), PipelineLlmProviderConfig's apiKey and SAP credentials,
PipelineRagStoreConfig.apiKey, SmartServerRagConfig's user/password, and the qdrant skill
store. They ARE the YAML, and a file holds neither an object nor a function, so the fix
is a non-secret name the root resolves — not a field that accepts an instance.

The loader, the env substitution and the schema validation stay here: once the shape
carries no secret, loading a file is not handling one.

BREAKING at runtime as well as in source: BuildAgentDeps.makeLlm is no longer defaulted,
so a deployment that never injected one now refuses at startup naming the seam, rather
than starting with a provider the library chose."
```

### Task B10: `llm-agent-server` becomes the composition root

The last task of this workstream, and the one that makes every removal above land somewhere. The spec's §8 migration carries the reference implementation; this task is that code, in the app, compiling.

**Files:**
- Create: `packages/llm-agent-server/src/composition/credential-for.ts` — the reference resolver
- Create: `packages/llm-agent-server/src/composition/make-llm.ts` — the provider dispatch
- Create: `packages/llm-agent-server/src/composition/model-resolver.ts` — `IModelResolver` for `PUT /v1/config`
- Modify: the app's entry point to pass `BuildAgentDeps.makeLlm` and `modelResolver`
- Test: `packages/llm-agent-server/src/composition/__tests__/*.test.ts`

**Interfaces:**
- Consumes: every credential contract, `staticApiKey`/`staticLogin`, `serviceKeyCredential`, and the five concrete providers — all sixteen of which this package **already** declares as dependencies, unlike `llm-agent-libs` which reached for five by dynamic import.
- Produces: nothing importable. It is the root.

- [ ] **Step 1: copy the reference implementation out of the spec, and compile it**

The spec's §8 migration item 4 holds the whole of `credentialFor`, `DEFAULT_REF` and the dispatch, and that block is **verified**: it is extracted from the spec and compiled under `--strict` against stub declarations. Start from it rather than writing a fourth variant.

```bash
sed -n '/^```ts$/,/^```$/p' docs/superpowers/specs/2026-09-16-auth-contracts-design.md | \
  grep -n "credentialFor" | head -3    # locate the block, then copy it
```

- [ ] **Step 2: write the failing tests — one per rule the example encodes**

```
1. an absent credentialRef resolves to DEFAULT_REF, so a single-account deployment
   that writes nothing in its YAML still starts;
2. an unknown reference throws AT STARTUP, naming the reference — not later, as an
   authentication failure;
3. nothing is read or parsed until a reference asks: a deployment with no
   AICORE_SERVICE_KEY starts fine as long as no entry names it;
4. each provider branch receives a credential of the kind it accepts, and a bearer
   handed to an api-key provider is refused with a message naming the reference;
5. ollama is constructed WITHOUT a credential when its entry has none, and WITH one
   when it does;
6. sap-ai-sdk takes both halves from the entry — credential and apiBaseUrl — so two
   AI Core accounts are two entries and not a second read of one env var.
```

Rule 3 is the one a previous draft of the spec got wrong twice, so assert it explicitly: unset the variable, resolve a different reference, and expect no throw.

- [ ] **Step 3: run them and watch them fail**

```bash
node --import tsx/esm --test 'packages/llm-agent-server/src/composition/__tests__/*.test.ts'
```

- [ ] **Step 4: implement, and wire the app**

```ts
// packages/llm-agent-server/src/index.ts (or wherever the server is constructed)
import { credentialFor, DEFAULT_REF } from './composition/credential-for.js';
import { makeLlm } from './composition/make-llm.js';
import { modelResolver } from './composition/model-resolver.js';

const server = new SmartServer(config, {
  makeLlm,          // required now: the library defaults nothing (Task B9)
  modelResolver,    // optional, and what PUT /v1/config needs
});
```

Pass `makeLlm` and `modelResolver` into `BuildAgentDeps`. `IModelResolver.resolve(modelName, role)` is unchanged; the implementation constructs with the credential this root holds and picks **its own** temperature per role, because the library's `main ? 0.7 : 0.1` was a policy with our numbers in it and does not move.

- [ ] **Step 5: the whole repository must now be green**

```bash
npm run lint:check && echo "LINT=0"
npx tsc -b && echo "BUILD=0"
node --import tsx/esm --test $(git ls-files 'packages/*/src/**/*.test.ts') 2>&1 | tail -12
```

`tsc -b` returning 0 here is the workstream's real completion test: every error Task B1 created has been claimed by the task that owned it.

- [ ] **Step 6: commit**

```bash
git add packages/llm-agent-server/src
git commit -m "feat(llm-agent-server): become the composition root

It reads the environment, turns a credentialRef into a credential, dispatches the five
providers and implements IModelResolver behind PUT /v1/config. This is the code the
library used to hold, and holding it there was the only reason a secret had to travel
through a framework config.

This package already declared all sixteen provider packages explicitly, which is why the
dispatch belongs here and not in llm-agent-libs, which reached for five by dynamic
import(). Being the example is its job (principle 2), so this is also the reference every
other consumer copies — the spec's §8 migration shows the same code."
```
## Phase B, workstream 3 — RAG identity, attributes and a catalog that can be read back

These eight tasks survive the re-derivation unchanged in substance: §4.6.2's rewrite did not touch §6. The only edit is in Task B11, which no longer adds a `credential` to `EmbedderFactoryConfig` — Task B1 **removes** that field and nothing replaces it.

### Task B11: the record, and the two provider members that make it usable

A provider is handed the **store** name, not the logical one: `SimpleRagRegistry.createCollection` computes `storeName = storeNameFor(params)` and calls `provider.createCollection(storeName, …)` (`:189`, `:193`). It cannot derive the logical name either — `storeNameFor` (`:31`) returns `${base}_${digest}` with `base` sanitized by `[^a-zA-Z0-9_] → _` and truncated to fit 63 characters. So the logical name must be written, and read back beside the attributes.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/rag.ts` (`IRagProvider.createCollection` ~`:209-216`, `listCollections?` ~`:219`, `IRagRegistry` ~`:163`)
- Test: `packages/llm-agent/src/__tests__/rag-collection-record.test.ts`

**Interfaces:**
- Produces — and Tasks B13 through B17 use these exact names:
  - `RagCollectionRecord { storeName; name; scope?; sessionId?; userId?; attributes? }`
  - `RagCallerIdentity { sessionId; userId? }` — declared here, in `llm-agent`; Task B16 requires it
  - `IRagProvider.describeCollections?(): Promise<Result<readonly RagCollectionRecord[], RagError>>`
  - `IRagProvider.openCollection?(record): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>`
  - `IRagProvider.createCollection(name, opts)` gains `collectionName?: string` and `attributes?: unknown`
  - `IRagRegistry.createCollection(params)` gains `attributes?: unknown`
  - `RagCollectionAuthorization = 'public' | 'owner' | 'role'` and `RagCollectionMeta.authorization?` — the second of §6.1's two axes, which the meta does not carry today; Task B16 reads it to decide what a global permits

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
   * role-gated collection be read. Task B16 fails closed as well, so both
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

### Task B12: the failure names itself

`IRagProvider.deleteCollection?` returns an undifferentiated `Result<void, RagError>` (`:218`), and the tool turns any error into `{ ok: true, warning: '… was removed, but its data could not be deleted' }` (`rag-collection-tools.ts:220-225`) — so a catalog failure would be reported as data loss after a successful removal. A typed error carries the phase, as the rest of `rag/corrections/errors.ts` already does and as interfaces decision 25 asks.

**Files:**
- Modify: `packages/llm-agent/src/rag/corrections/errors.ts` (beside `DeleteUnsupportedError` ~`:62`)
- Modify: `packages/llm-agent/src/rag/mcp-tools/rag-collection-tools.ts` (delete handler ~`:215-226`)
- Test: `packages/llm-agent/src/rag/__tests__/catalog-record-delete-error.test.ts`

**Interfaces:**
- Produces: `CatalogRecordDeleteError extends RagError`. **Tasks B13 and B14 raise it** — pg/hana and qdrant, the packages that own a catalog. The delete handler's branch is added here and must survive B16's rewrite of the tool entries.

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

### Task B13: pg and hana gain a catalog, and delete the record before the data

The same change twice, so one task and one diff. **These packages own the backend catalog, so resurrection is stopped here or nowhere** — the core wiring can be complete and still leak without this. Both packages take an injectable `clientFactory?: () => PgClient | HanaClient`, so none of this needs a live database.

**Files:**
- Modify: `packages/pg-vector-rag/src/{schema,pg-vector-rag-provider}.ts`
- Modify: `packages/hana-vector-rag/src/{schema,hana-vector-rag-provider}.ts`
- Test: `packages/pg-vector-rag/src/__tests__/catalog.test.ts` and its hana twin

**Interfaces:**
- Consumes: `RagCollectionRecord` (B11), `CatalogRecordDeleteError` (B12).
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

### Task B14: qdrant gains a catalog — establish the mechanism before building on it

The design records the Qdrant catalog as **unverified**: it exposes no collection-level metadata we have checked. So this task starts by finding out, and the answer may change its shape. Do not skip Step 1 and assume the fallback.

**Interfaces:**
- Consumes: `RagCollectionRecord` (B11), `CatalogRecordDeleteError` (B12), and the credential on `QdrantRagConfig` (B6).
- Produces: `describeCollections()`, `openCollection()` and a record-first `deleteCollection()` on `QdrantRagProvider` — the same three members Task B13 produces for pg and hana, so a consumer sees one shape across all three stores. Task B17's hydration calls them.

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

The same four behaviours as Task B13, against a `fetch` fake rather than a SQL client:

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

### Task B15: the registry adopts an existing store

`register()` cannot do this: it sets `storeName: name` (`:99`), assuming the two are equal — true for a directly registered collection, false for every hydrated one.

**Files:**
- Modify: `packages/llm-agent/src/interfaces/rag.ts` (`IRagRegistry.adopt?`)
- Modify: `packages/llm-agent/src/rag/registry/simple-rag-registry.ts`
- Test: `packages/llm-agent/src/rag/__tests__/adopt.test.ts`

**Interfaces:**
- Consumes: `RagCollectionRecord` (B11).
- Produces: `IRagRegistry.adopt?(record, rag, editor?): void`, honouring a store name that differs from the logical name. Task B17's factory calls it.

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

### Task B16: the tool entries are built for one caller

The security change, and the largest behavioural one. Five of the seven handlers take the `RagToolContext` they are given and ignore it; a sixth trusts it. After this task identity comes from construction only.

**Files:**
- Modify: `packages/llm-agent/src/rag/mcp-tools/rag-collection-tools.ts`
- Test: `packages/llm-agent/src/rag/__tests__/tool-identity.test.ts`

**Interfaces:**
- Consumes: `RagCallerIdentity` (B11).
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

### Task B17: a session can own its registry, and hydrate it

`SessionGraphFactoryOptions.ragRegistry` is one shared `IRagRegistry` (`session-graph-factory.ts:93`), handed to every build (`:228`) and the object `closeSession` is called on at dispose (`:280`). Its own comment — *"GLOBAL … shared; the per-call scope filter isolates"* — is the model being replaced.

**Files:**
- Modify: `packages/llm-agent-libs/src/session/session-graph-factory.ts`
- Test: `packages/llm-agent-libs/src/__tests__/session-registry-factory.test.ts`

**Interfaces:**
- Consumes: `IRagRegistry.adopt?` (B15), `describeCollections`/`openCollection` — declared in B11, implemented in B13 and B14 — the factory is where a consumer strings them together.
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

### Task B18: changelogs, documentation, and the migration note

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
for p in llm-agent llm-agent-libs llm-agent-server-libs llm-agent-server llm-agent-mcp \
         openai-llm anthropic-llm deepseek-llm ollama-llm openai-embedder \
         qdrant-rag pg-vector-rag hana-vector-rag \
         sap-aicore-llm sap-aicore-embedder sap-aicore-auth; do
  echo "--- packages/$p/CHANGELOG.md"; head -3 "packages/$p/CHANGELOG.md"
done
```

Each gets an `## [Unreleased]` section saying what a consumer must do, not what we did. No version numbers: the version is decided at the release by what has accumulated (§10).

- [ ] **Step 3: point the root changelog at the spec's migration note — do not restate it**

The spec's §8 carries **seven** migration items, each with its before/after and the error a
consumer will actually see. Restating them here is how the two drift: an earlier version of
this plan copied three of them inline and they were stale within two commits. The root
changelog lists their titles and links the section:

````markdown
## [Unreleased]

### Migration

Seven changes need an edit, and none is optional. Each is written out in full — with its
before/after and the compiler error you will see — in
`docs/superpowers/specs/2026-09-16-auth-contracts-design.md` §8:

1. Replace a plain key with a credential (`staticApiKey` / `staticLogin`).
2. Construct your LLM provider yourself and hand in the instance — `makeLlm`,
   `makeDefaultLlm`, `MakeLlmConfig` and `DefaultModelResolver` are gone.
3. Build the SAP AI Core credential in your composition root, via `serviceKeyCredential`
   from the new `@mcp-abap-adt/sap-aicore-auth`.
4. Supply `BuildAgentDeps.makeLlm` — the library no longer defaults it — and move
   `apiKey: ${VAR}` to `credentialRef: VAR`.
5. Build the RAG collection tools with an identity.
6. Stop reading identity from the tool context.
7. Narrow a widened logger option before reading it.
````

Before committing, count the spec's items and compare with this list. If the numbers differ,
the spec moved and the list is stale — fix the list, never the spec.

- [ ] **Step 4: update the threat model**

```markdown
**State: mitigated.** The tool entries are built with the caller's identity bound
in — required, not optional — so the only collections they can address are that
caller's and the globals, and no framework tool mutates a global at all. Landed
in Task B16 of the plan; see `docs/ARCHITECTURE.md` principle 8.
```

AS-6's **State** changes from "latent, not live" to that, naming the commit from Task B16, and its Known Limitations row is removed. Keep the description of what was wrong: a threat model that forgets what it fixed cannot tell whether a regression is new.

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

The security change is Task B16: five of seven collection handlers ignored the
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


---

## Self-review

This section records a review that was **run**, not a checklist to run later.

**This plan is a re-derivation, and that is the first thing to know about it.** Ten review rounds changed the spec's §4 from *"add a credential beside `apiKey`"* to *"a secret belongs in a contract only where the secret is the contract"*. The previous derivation's workstream 2 is wrong in every particular — it put a `credential` on `LLMProviderConfig`, kept `makeLlm`, and never mentioned `credentialRef`, `sap-aicore-auth` or the composition root. It was not patched; it was replaced. Phase A and workstream 3 are carried over, because §4.6.2's rewrite touched neither.

**Spec coverage, section by section.** §3.3-3.4 are workstream 1, merged; §3.5 → B7. §4.1, §4.4, §4.5 → B1-B7. §4.6.1 (address-only connection strings) → B6. §4.6.2 — the section that changed most — is spread across B1 (the two contract removals, the conversions), B2 (`sap-aicore-auth`), B3-B6 (concrete constructors), B8 (the dispatch deleted), B9 (`credentialRef`, the lost default) and B10 (the composition root). §4.6.3 (`apiBaseUrl`) → B5. §5 and §5.1 → B16. §6.1 → B11 and B16. §6.2 needs no task: it deletes a design, and the constructor credential it leaves behind is B6. §6.3 → B11-B15. §6.4 → B17. §7 is workstream 4, merged. §8's migration → B18.

**Not in any task, deliberately:** `AccessCheck` anywhere (§5); a composite registry key (§6.4); delegated identity to HANA or Qdrant (§9.1); converging the two logger names (§9.9); anything deepening the `IF NOT EXISTS` assumption (§9.10); a `role` parameter on `BuildAgentDeps.makeLlm` (§4.6.2 — its twenty call sites name roles a closed union cannot); and `ollama-embedder`, which authenticates not at all.

**What this pass found and fixed while writing:**

- The reusable half was nearly truncated mid-task: `## [Unreleased]` appears **inside** Task B18's changelog example, and cutting the old plan at that heading would have shipped a task whose last four steps were missing. Extracted by task boundary instead.
- Task B18 told an implementer to copy §8's *three* migration items inline. The spec has **seven**, and an inline copy is exactly how the two drifted the last time. It now lists titles and points at the section, with an instruction to compare the counts before committing.
- Its changelog loop covered eight packages; sixteen are touched. Corrected, including the new `sap-aicore-auth`.
- Task B1 is the only task allowed to end with `tsc -b` red, and it says so: removing a field from two contracts breaks the packages that read it, and each is claimed by a later task. Its Step 5 writes the compiler's error list into the report, and Task B10's Step 5 treats `tsc -b` returning 0 as the workstream's completion test — so the scope is measured at the start and closed at the end rather than predicted in between.

- **The MCP task I recovered from history was older than the rule it had to obey.** It carried `credential?: IApiKeyCredential | IBearerCredential` — the shared union §4.6.2 forbids — optional, so a bearer-only target compiled with no credential or with an api key. And it built `Authorization: Bearer …` for **any** credential, though §4 says an api key is the same key whether a server wants it as `Authorization`, `x-api-key` or `api-key`, and that the placement is the accepting implementation's business. Replaced by a discriminated `HttpMcpAuth`: each variant demands the one kind it can use, `'header'` names the header, and `'none'` makes an unauthenticated target a statement rather than an omission. Two tests were added for exactly what was wrong — an api key landing in `x-api-key` and not in `Authorization`, and a bearer credential refused where a header key is declared.
- **Renumbering left stale dependency annotations, and my first audit of them produced a false positive.** B13 said its record came from B9 and its error from B10 (now B11 and B12); B15, B16 and B17 pointed at B9 and B13; and B12 claimed “Tasks B11 and B12 raise it” when the raisers are B13 and B14, the two packages that own a catalog. All corrected. The audit also reported B10 citing B11, which was my own script slicing a workstream header into the wrong block — worth recording, because an audit that cannot tell a real reference from its own boundary error is one finding away from wasting a round.
- **Five tasks had no `Produces` block, and that block is how a later task learns names.** B1, B4, B5, B6, B11 and B14 now have one. A2, A3 and B18 do not, and should not: two hand work to the user and one writes documentation.
- **Two dependencies were imported and never declared.** Task B10 imports the credential contracts and `sap-aicore-auth` into `llm-agent-server`, which B1's list omitted and B2 added only to the embedder. A workspace would have hidden both through hoisting while a published server carried undeclared dependencies.
- **I reintroduced the defect the previous derivation's self-review had fixed.** The freshly written workstream 2 shipped **22 of 104 steps with no code**, and Task B7 said “as written in the previous derivation” — the “Similar to Task N” antipattern the skill names, and the exact thing the last pass had removed. B7 was recovered in full from git history; B3, B4, B5, B6, B9 and B10 gained their implementation snippets and commit commands. Two steps remain prose, and both are decisions rather than edits: handing the publish to the user, and choosing Qdrant's catalog mechanism from what Step 1 found.

**Type consistency.** `credential` is the property name on every concrete config; `credentialRef` on every serializable one; `apiBaseUrl` is the AI Core endpoint everywhere (`parseServiceKey` returns it, `sap-aicore-embedder` already calls it that); `staticApiKey`/`staticLogin` are declared once, in B1, and used by B3-B6 and B10. `RagCollectionRecord` uses `name` for the logical name and `storeName` for the physical one in B11, B13, B14 and B15 alike.

**The gate.** No Phase B task may run before Task A3's two registry commands answer 1.1.0.

---

## Execution

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — tasks run in this session with checkpoints for review.

Which approach?
