# MCP Lifetime and Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the framework one seam for starting, stopping and identifying an MCP server, so lifetime and per-caller credentials stop being glue rewritten inside every assembly.

**Architecture:** A new `IMcpServer` contract (`start`/`stop`/optional `descriptor`) joins the existing `McpClientFactory`, which becomes one way to build one. `SmartAgentBuilder.withMcpServers` starts them in `build()` and pushes each `stop()` into the `closeFns` the handle already awaits. `SessionGraphFactory` gains an optional `mcpServerFactory(identity)` plus a new optional `closePipeline` hook, so a per-caller teardown runs before anything is deleted and the servers stop last. The stdio implementation finally passes its own `env`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), npm workspaces, `node:test` via `tsx` (`node --import tsx/esm --test 'src/**/*.test.ts'` per package, `npm test` fans out), Biome for lint and format.

**Spec:** `docs/superpowers/specs/2026-09-16-auth-contracts-design.md` (§3, §10.1; base `0eb7b766`)

## Global Constraints

- **Additive minor.** Nothing is removed, and no existing path changes behaviour. A consumer that ignores every seam below keeps exactly today's behaviour.
- **Deprecations are markers only:** `mcpClientFactory`, `mcpClientFactoryWithDescriptors`, `buildPerSessionMcpClients` and `mcpSharedClient` get `@deprecated` JSDoc and keep working until the next major. `closeBySession` is a local `Map` inside `buildSessionLifecycle`, not an option — nothing can be tagged on it, so it gets a code comment saying it serves the deprecated path only. `McpClientFactory` stays as the default implementation's factory (`mcpServerFromFactory` consumes it) and is deprecated **only** as the consumer-facing seam.
- **Exactly one owner per server:** the builder starts what `withMcpServers` gave it and stops it in `closeFns`; the session factory starts what `mcpServerFactory` gave it and stops it on dispose. `buildAgent` on the session path receives **clients** and therefore uses `withMcpClients`, never `withMcpServers` — otherwise `stop()` runs twice.
- **Reconnection stays with `IMcpConnectionStrategy`.** `start()` is called once per instance; the framework never restarts one.
- **Typed stdio/http implementations are NOT in this workstream.** Spec §8's `llm-agent-mcp` row lists them beside `env`, but §3.3 says each demands its credential in its own constructor — and the credential contracts are workstream 2. This workstream ships the generic adapter (`mcpServerFromFactory`) and `env`; the typed implementations land with workstream 2, and §8's row has been amended to say so. Do not report §8 complete from this plan.
- **A malformed descriptor set throws; it is never downgraded.** Descriptors here come from the caller's own `IMcpServer[]`, so a partly-filled set is a caller bug, and silently falling back to positional pairing would rename every tool from its `label` to `s${slotIndex}` (`buildNamespacedTools`, INTEGRATION.md:1858) with nothing reporting it. Spec §3.4 defines "none → positional" only.
- **Descriptor invariant is unchanged** (`packages/llm-agent/src/interfaces/assert-client-descriptors.ts`): descriptors are all-or-none and their count equals the client count; `slotIndex` values are unique non-negative integers; `configuredSlotCount`, when given, must be strictly greater than the largest `slotIndex`.
- **Teardown order on the new path:** `closePipeline` → `ragRegistry.closeSession` → `onDispose` (where its docstring already promises it) → `stop()` last.
- All artifacts in English. Conventional Commits. Commit after every task.

---

## File structure

| file | responsibility |
|---|---|
| `packages/llm-agent/src/interfaces/mcp-server.ts` | **new** — the `IMcpServer` contract, nothing else |
| `packages/llm-agent/src/interfaces/mcp-server-from-factory.ts` | **new** — the adapter turning an `McpClientFactory` + config into an `IMcpServer`. Beside the contract, like `assert-client-descriptors.ts`: this package keeps its one runtime MCP helper in `interfaces/` and re-exports it from the root |
| `packages/llm-agent/src/interfaces/index.ts` | export the contract beside the other MCP contracts |
| `packages/llm-agent/src/index.ts` | export the adapter |
| `packages/llm-agent-libs/src/builder.ts` | `withMcpServers`; start in `build()`; `stop()` into `closeFns` |
| `packages/llm-agent-libs/src/session/session-graph-factory.ts` | optional `mcpServerFactory` and `closePipeline`; four-step teardown |
| `packages/llm-agent-mcp/src/client.ts` | `env` on the stdio transport |
| `packages/llm-agent-mcp/src/factory.ts` | `env` threaded from `McpConnectionConfig` |
| `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts` | consume the seam; deprecate the glue |
| `CHANGELOG.md`, `docs/INTEGRATION.md` | what a consumer needs to know |

---

### Task 1: The `IMcpServer` contract and its adapter

**Files:**
- Create: `packages/llm-agent/src/interfaces/mcp-server.ts`
- Create: `packages/llm-agent/src/interfaces/mcp-server-from-factory.ts`
- Create: `packages/llm-agent/src/interfaces/mcp-server-from-factory.test.ts` (beside the source, exactly like `interfaces/assert-client-descriptors.test.ts`; the package's `test` script is `node --import tsx/esm --test --test-reporter=spec 'src/**/*.test.ts'`, which picks up both layouts)
- Modify: `packages/llm-agent/src/interfaces/index.ts` (the MCP export block, currently lines 73–82)
- Modify: `packages/llm-agent/src/index.ts` (add the adapter export)

**Interfaces:**
- Consumes: `IMcpClient`, `McpClientDescriptor`, `McpClientFactory`, `McpClientFactoryResult`, `McpConnectionConfig` — all already exported from `./interfaces/index.js`.
- Produces: `interface IMcpServer { readonly descriptor?: McpClientDescriptor; start(): Promise<IMcpClient>; stop(): Promise<void> }` and `function mcpServerFromFactory(factory: McpClientFactory, config: McpConnectionConfig, descriptor?: McpClientDescriptor): IMcpServer`. Tasks 2, 4 and 5 depend on both.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent/src/interfaces/mcp-server-from-factory.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IMcpClient,
  McpConnectionConfig,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from './index.js';
import { mcpServerFromFactory } from './mcp-server-from-factory.js';

function stubClient(): IMcpClient {
  return {
    async listTools(): Promise<Result<McpTool[], McpError>> {
      return { ok: true, value: [] };
    },
    async callTool(): Promise<Result<McpToolResult, McpError>> {
      return { ok: true, value: { content: [] } };
    },
  } as unknown as IMcpClient;
}

const config: McpConnectionConfig = { type: 'stdio', command: 'echo' };

test('start() calls the factory once and returns its client', async () => {
  const client = stubClient();
  let calls = 0;
  const server = mcpServerFromFactory(async (cfg) => {
    calls++;
    assert.equal(cfg, config);
    return { client };
  }, config);

  assert.equal(await server.start(), client);
  assert.equal(calls, 1);
});

test('stop() calls the close the factory returned', async () => {
  let closed = 0;
  const server = mcpServerFromFactory(
    async () => ({ client: stubClient(), close: () => { closed++; } }),
    config,
  );

  await server.start();
  await server.stop();
  assert.equal(closed, 1);
});

test('stop() before start() is a no-op, and stop() is idempotent', async () => {
  let closed = 0;
  const server = mcpServerFromFactory(
    async () => ({ client: stubClient(), close: async () => { closed++; } }),
    config,
  );

  await server.stop();
  assert.equal(closed, 0);

  await server.start();
  await server.stop();
  await server.stop();
  assert.equal(closed, 1);
});

test('start() twice throws rather than leaking the first client', async () => {
  const server = mcpServerFromFactory(
    async () => ({ client: stubClient() }),
    config,
  );

  await server.start();
  await assert.rejects(() => server.start(), /already started/);
});

test('the adapter is single-use: start() after stop() throws', async () => {
  const server = mcpServerFromFactory(
    async () => ({ client: stubClient() }),
    config,
  );

  await server.start();
  await server.stop();
  // `IMcpServer` says an implementation that cannot be restarted throws.
  // This one cannot: reconnection is `IMcpConnectionStrategy`'s job.
  await assert.rejects(() => server.start(), /already stopped/);
});

test('the descriptor is carried through untouched', () => {
  const server = mcpServerFromFactory(
    async () => ({ client: stubClient() }),
    config,
    { slotIndex: 2, label: 'abap' },
  );

  assert.deepEqual(server.descriptor, { slotIndex: 2, label: 'abap' });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -w @mcp-abap-adt/llm-agent`
Expected: FAIL — `Cannot find module './mcp-server-from-factory.js'`.

- [ ] **Step 3: Write the contract**

Create `packages/llm-agent/src/interfaces/mcp-server.ts`:

```ts
import type { IMcpClient } from './mcp-client.js';
import type { McpClientDescriptor } from './mcp-connection-strategy.js';

/**
 * An MCP server this process owns the lifetime of: a spawned stdio child, a
 * held HTTP connection, or an in-process embedded server.
 *
 * Using a server is `IMcpClient`; starting and stopping one is this. The
 * credential a particular target needs is demanded by the implementation's own
 * constructor, typed for that target — the framework never sees it.
 *
 * Reconnection is NOT here: `IMcpConnectionStrategy` owns outage handling.
 * `start()` is called once per instance; an implementation that cannot be
 * restarted after `stop()` throws.
 */
export interface IMcpServer {
  /**
   * Stable identity for tool namespacing, forwarded by wrappers. When absent,
   * array position is the pairing — exactly as today.
   */
  readonly descriptor?: McpClientDescriptor;
  start(): Promise<IMcpClient>;
  stop(): Promise<void>;
}
```

- [ ] **Step 4: Write the adapter**

Create `packages/llm-agent/src/interfaces/mcp-server-from-factory.ts` (the import style is `assert-client-descriptors.ts`'s — siblings by relative path):

```ts
import type { IMcpClient } from './mcp-client.js';
import type {
  McpClientDescriptor,
  McpClientFactory,
  McpConnectionConfig,
} from './mcp-connection-strategy.js';
import type { IMcpServer } from './mcp-server.js';

/**
 * Builds an `IMcpServer` from the existing `McpClientFactory`, so the default
 * implementation and anything already written against it keep working.
 *
 * `stop()` is the `close` the factory returned; a factory that returns none
 * has nothing to stop.
 *
 * **Single-use.** Once stopped, this instance cannot be started again —
 * reconnection is `IMcpConnectionStrategy`'s job, not a restarted server's.
 * A `stop()` before any `start()` is a no-op and leaves the instance usable.
 */
export function mcpServerFromFactory(
  factory: McpClientFactory,
  config: McpConnectionConfig,
  descriptor?: McpClientDescriptor,
): IMcpServer {
  let state: 'idle' | 'started' | 'stopped' = 'idle';
  let close: (() => Promise<void> | void) | undefined;

  return {
    ...(descriptor ? { descriptor } : {}),
    async start(): Promise<IMcpClient> {
      if (state === 'started') throw new Error('IMcpServer already started');
      if (state === 'stopped')
        throw new Error('IMcpServer already stopped; build a new one');
      const result = await factory(config);
      state = 'started';
      close = result.close;
      return result.client;
    },
    async stop(): Promise<void> {
      const pending = close;
      close = undefined;
      if (state === 'started') state = 'stopped';
      if (pending) await pending();
    },
  };
}
```

- [ ] **Step 5: Export both**

In `packages/llm-agent/src/interfaces/index.ts`, directly after the `export type { IMcpClient } from './mcp-client.js';` line, add:

```ts
export type { IMcpServer } from './mcp-server.js';
```

In `packages/llm-agent/src/index.ts`, beside line 12's `export { assertClientDescriptors } from './interfaces/assert-client-descriptors.js';`:

```ts
export { mcpServerFromFactory } from './interfaces/mcp-server-from-factory.js';
```

- [ ] **Step 6: Run the tests and the build**

Run: `npm test -w @mcp-abap-adt/llm-agent && npm run build -w @mcp-abap-adt/llm-agent && npm run lint:check`
Expected: all five tests pass; build clean; Biome reports no new warnings.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent/src/interfaces/mcp-server.ts \
        packages/llm-agent/src/interfaces/mcp-server-from-factory.ts \
        packages/llm-agent/src/interfaces/mcp-server-from-factory.test.ts \
        packages/llm-agent/src/interfaces/index.ts packages/llm-agent/src/index.ts
git commit -m "feat(llm-agent): IMcpServer, and an adapter from the existing factory

Starting a server and using one are different jobs: IMcpClient is the second,
IMcpServer is the first. mcpServerFromFactory keeps McpClientFactory as one
way to build one, with stop() being the close it already returns."
```

---

### Task 2: `withMcpServers` on the builder

**Files:**
- Modify: `packages/llm-agent-libs/src/builder.ts` (field beside `_mcpClients` at :169; method beside `withMcpClients` at :339; start in `build()` at the `this._mcpClients` branch, :986; `closeFns` already exist at :973 and are awaited at :1368)
- Create: `packages/llm-agent-libs/src/__tests__/mcp-servers-di.test.ts`

**Interfaces:**
- Consumes: `IMcpServer` (Task 1).
- Produces: `SmartAgentBuilder.withMcpServers(servers: IMcpServer[]): this`. Task 5 uses it.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/__tests__/mcp-servers-di.test.ts`. It mirrors
`mcp-clients-di.test.ts` exactly: the stubs are local to the file, the builder is
imported dynamically inside each test ("to avoid pulling in heavy deps at module
level"), the constructor takes `{}`, and the clients are observed through
`handle.agent.healthCheck()` — one `health.value.mcp` entry per client — because
that is what the handle exposes.

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  ILlm,
  IMcpClient,
  IMcpServer,
  LlmStreamChunk,
  LlmTool,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';

function stubMcpClient(id: string): IMcpClient {
  const tools: McpTool[] = [
    { name: `${id}-tool`, description: `Tool from ${id}`, inputSchema: {} },
  ];
  return {
    async listTools(): Promise<Result<McpTool[], McpError>> {
      return { ok: true, value: tools };
    },
    async callTool(
      _name: string,
      _args: Record<string, unknown>,
    ): Promise<Result<McpToolResult, McpError>> {
      return { ok: true, value: { content: [] } };
    },
  };
}

function stubLlm(): ILlm {
  return {
    async chat(_messages: unknown[], _tools?: LlmTool[], _options?: CallOptions) {
      return {
        ok: true as const,
        value: { content: 'ok', toolCalls: [], finishReason: 'stop' as const },
      };
    },
    async *streamChat(
      _messages: unknown[],
      _tools?: LlmTool[],
      _options?: CallOptions,
    ): AsyncGenerator<Result<LlmStreamChunk, Error>> {
      yield { ok: true as const, value: { content: 'ok', finishReason: 'stop' as const } };
    },
  };
}

function stubServer(id: string, log: string[]): IMcpServer {
  return {
    async start() {
      log.push(`start:${id}`);
      return stubMcpClient(id);
    },
    async stop() {
      log.push(`stop:${id}`);
    },
  };
}

describe('SmartAgentBuilder.withMcpServers()', () => {
  it('starts every server and hands its client to the agent', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const log: string[] = [];

    const handle = await new SmartAgentBuilder({})
      .withMainLlm(stubLlm())
      .withMcpServers([stubServer('a', log), stubServer('b', log)])
      .build();

    try {
      assert.deepEqual(log, ['start:a', 'start:b']);
      const health = await handle.agent.healthCheck();
      assert.ok(health.ok);
      assert.equal(health.value.mcp.length, 2);
    } finally {
      await handle.close();
    }

    assert.deepEqual(log, ['start:a', 'start:b', 'stop:a', 'stop:b']);
  });

  it('a half-filled descriptor set throws instead of renaming tools behind the caller', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const log: string[] = [];
    const described: IMcpServer = {
      descriptor: { slotIndex: 0, label: 'abap' },
      async start() {
        return stubMcpClient('d');
      },
      async stop() {},
    };

    // One server carries a descriptor, one does not. Dropping the pair would
    // silently re-namespace `abap__Search` to `s0__Search`, so this is a
    // caller bug and must be loud.
    await assert.rejects(
      () =>
        new SmartAgentBuilder({})
          .withMainLlm(stubLlm())
          .withMcpServers([described, stubServer('e', log)])
          .build(),
      /descriptor/i,
    );

    // Whatever was started before the throw is stopped again.
    assert.deepEqual(log, ['start:e', 'stop:e']);
  });

  it('withMcpServers and withMcpClients together are a configuration error', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const log: string[] = [];

    await assert.rejects(
      () =>
        new SmartAgentBuilder({})
          .withMainLlm(stubLlm())
          .withMcpClients([stubMcpClient('c')])
          .withMcpServers([stubServer('a', log)])
          .build(),
      /withMcpClients/,
    );
  });

  it('withMcpClients is untouched: nothing is started, nothing is stopped', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');

    const handle = await new SmartAgentBuilder({})
      .withMainLlm(stubLlm())
      .withMcpClients([stubMcpClient('c')])
      .build();

    try {
      const health = await handle.agent.healthCheck();
      assert.ok(health.ok);
      assert.equal(health.value.mcp.length, 1);
    } finally {
      await handle.close();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -w @mcp-abap-adt/llm-agent-libs`
Expected: FAIL — `builder.withMcpServers is not a function`.

- [ ] **Step 3: Add the field and the method**

In `packages/llm-agent-libs/src/builder.ts`, beside `private _mcpClients?: IMcpClient[];`:

```ts
  private _mcpServers?: IMcpServer[];
```

Beside `withMcpClients` (line 339):

```ts
  /**
   * Servers this builder owns: `build()` starts each one and `handle.close()`
   * stops it. Use this when the caller knows HOW a server is started — a stdio
   * child with its own environment, an HTTP target with a credential — rather
   * than handing over an already-connected client.
   *
   * Beside `withMcpClients`, never replacing it: a consumer that already holds
   * clients keeps passing clients. Setting BOTH is a configuration error and
   * `build()` throws, rather than one silently winning over the other.
   *
   * Every server must carry a `descriptor`, or none may — a partly-filled set
   * throws, because dropping it would re-namespace tools from their `label`
   * to `s${slotIndex}` with nothing reporting it.
   */
  withMcpServers(servers: IMcpServer[]): this {
    this._mcpServers = servers;
    return this;
  }
```

The file's type import from `@mcp-abap-adt/llm-agent` currently brings in `IMcpClient` but **not** `McpClientDescriptor`; Step 4 uses both, so add `IMcpServer` and `McpClientDescriptor` to it.

- [ ] **Step 4: Start them in `build()`**

In `build()`, replace the opening of the injected-clients branch (line 986, `if (this._mcpClients) {`) with:

```ts
    if (this._mcpServers) {
      if (this._mcpClients)
        throw new Error(
          'withMcpServers and withMcpClients are mutually exclusive: pass clients you already hold, or servers this builder should start',
        );

      // A partly-filled descriptor set is a caller bug: dropping it would
      // re-namespace every tool from its label to `s${slotIndex}`. Check
      // before starting anything.
      const descriptors = this._mcpServers
        .map((s) => s.descriptor)
        .filter((d): d is McpClientDescriptor => d !== undefined);
      if (descriptors.length !== 0 && descriptors.length !== this._mcpServers.length)
        throw new Error(
          `withMcpServers: ${descriptors.length} of ${this._mcpServers.length} servers carry a descriptor — descriptors are all or none`,
        );

      // Caller-provided servers: start each, keep its stop() for handle.close().
      // Auto-connect and vectorization are skipped, exactly as on the
      // `withMcpClients` branch.
      const started: IMcpClient[] = [];
      try {
        for (const server of this._mcpServers) {
          started.push(await server.start());
          closeFns.push(() => server.stop());
        }
      } catch (err) {
        // Stop what did start, so a failure half-way leaves no live child.
        for (const fn of closeFns.splice(0)) await fn();
        throw err;
      }
      mcpClients = started;
      mcpClientDescriptors = descriptors.length > 0 ? descriptors : undefined;
    } else if (this._mcpClients) {
```

`closeFns.splice(0)` is safe here because this branch runs before any other closer is registered; if the implementer finds `closeFns` already populated at this point, they must capture the starting length instead and unwind only their own entries. `assertClientDescriptors` still runs downstream and stays the last word on uniqueness and count.

- [ ] **Step 5: Run the tests**

Run: `npm test -w @mcp-abap-adt/llm-agent-libs && npm run build -w @mcp-abap-adt/llm-agent-libs`
Expected: the three new tests pass, and every existing builder test still passes.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-libs/src/builder.ts \
        packages/llm-agent-libs/src/__tests__/mcp-servers-di.test.ts
git commit -m "feat(llm-agent-libs): withMcpServers, started by build and stopped by close

The handle already awaits closeFns; a started server's stop() goes there, so
one owner starts it and the same owner stops it."
```

---

### Task 3: stdio passes its own environment

**Files:**
- Modify: `packages/llm-agent-mcp/src/client.ts` (`MCPClientConfig` opens at :79; its `command?`/`args?` pair is at :144–145, under the comment `For stdio: command and args to execute`; the `StdioClientTransport` construction is at :317)
- Modify: `packages/llm-agent-mcp/src/factory.ts` (`toMcpClientWrapperConfig`)
- Modify: `packages/llm-agent/src/interfaces/mcp-connection-strategy.ts` (`McpConnectionConfig`)
- Create: `packages/llm-agent-mcp/src/__tests__/stdio-env.test.ts`

**Interfaces:**
- Produces: `McpConnectionConfig.env?: Record<string, string>` and `MCPClientConfig.env?: Record<string, string>`, threaded into `StdioClientTransport`.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-mcp/src/__tests__/stdio-env.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpConnectionConfig } from '@mcp-abap-adt/llm-agent';
import { toMcpClientWrapperConfig } from '../factory.js';

test('stdio config carries env through to the wrapper config', () => {
  const config: McpConnectionConfig = {
    type: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { TOKEN: 'per-caller' },
  };

  const wrapper = toMcpClientWrapperConfig(config);

  assert.equal(wrapper.transport, 'stdio');
  assert.deepEqual(wrapper.env, { TOKEN: 'per-caller' });
});

test('an stdio config without env stays without one', () => {
  const wrapper = toMcpClientWrapperConfig({ type: 'stdio', command: 'node' });
  assert.equal('env' in wrapper, false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -w @mcp-abap-adt/llm-agent-mcp`
Expected: FAIL — `env` is not a property of `McpConnectionConfig`, and the wrapper config has none.

- [ ] **Step 3: Add `env` to both configs**

In `packages/llm-agent/src/interfaces/mcp-connection-strategy.ts`, inside `McpConnectionConfig`, after `args?: string[];`:

```ts
  /**
   * Environment for a spawned stdio child. When omitted the SDK falls back to
   * `getDefaultEnvironment()` — a sanitised subset of THIS process's
   * environment — which every child of every caller then shares. Pass the
   * caller's own values here; never in `args`, which are visible in `ps`.
   */
  env?: Record<string, string>;
```

In `packages/llm-agent-mcp/src/client.ts`, inside `MCPClientConfig`, after the `command?`/`args?` pair at :144–145:

```ts
  /** Environment for the spawned stdio child. See `McpConnectionConfig.env`. */
  env?: Record<string, string>;
```

- [ ] **Step 4: Thread it through**

In `packages/llm-agent-mcp/src/factory.ts`, in the stdio branch of `toMcpClientWrapperConfig`, beside the existing spreads:

```ts
      ...(config.env ? { env: config.env } : {}),
```

In `packages/llm-agent-mcp/src/client.ts`, at the `StdioClientTransport` construction (line 317):

```ts
      const stdioTransport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args || [],
        ...(this.config.env ? { env: this.config.env } : {}),
      });
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w @mcp-abap-adt/llm-agent-mcp && npm run build -w @mcp-abap-adt/llm-agent-mcp`
Expected: both new tests pass; nothing else changes.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent/src/interfaces/mcp-connection-strategy.ts \
        packages/llm-agent-mcp/src/client.ts packages/llm-agent-mcp/src/factory.ts \
        packages/llm-agent-mcp/src/__tests__/stdio-env.test.ts
git commit -m "feat(llm-agent-mcp): a stdio child can be given its own environment

Without env the SDK hands every child getDefaultEnvironment() — a subset of
the host's own — so no caller's credentials could ever reach one."
```

---

### Task 4: `mcpServerFactory` and `closePipeline` on the session factory

**Files:**
- Modify: `packages/llm-agent-libs/src/session/session-graph-factory.ts` (`SessionGraphFactoryOptions`; `build()`; the `dispose` closure)
- Create: `packages/llm-agent-libs/src/session/__tests__/session-graph-factory-servers.test.ts`

**Interfaces:**
- Consumes: `IMcpServer` (Task 1).
- Produces: `SessionGraphFactoryOptions.mcpServerFactory?: (identity: SessionGraphIdentity) => IMcpServer[]` and `SessionGraphFactoryOptions.closePipeline?: (sessionId: string) => Promise<void>`. Task 5 uses both.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-libs/src/session/__tests__/session-graph-factory-servers.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type IMcpClient,
  type IMcpServer,
  InMemoryRagProvider,
  type IRagRegistry,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import { SessionGraphFactory } from '../session-graph-factory.js';

function makeRagRegistry(): IRagRegistry {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(new InMemoryRagProvider({ name: 'mem' }));
  const reg = new SimpleRagRegistry();
  reg.setProviderRegistry(providers);
  return reg;
}

function stubClient(): IMcpClient {
  return {
    async listTools() {
      return { ok: true as const, value: [] };
    },
    async callTool() {
      return { ok: true as const, value: { content: [] } };
    },
  } as unknown as IMcpClient;
}

function stubServer(id: string, log: string[]): IMcpServer {
  return {
    async start() {
      log.push(`start:${id}`);
      return stubClient();
    },
    async stop() {
      log.push(`stop:${id}`);
    },
  };
}

test('mcpServerFactory receives the identity, and its clients reach buildAgent', async () => {
  const log: string[] = [];
  const seen: string[] = [];
  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    mcpServerFactory: (identity) => {
      seen.push(identity.sessionId);
      return [stubServer('a', log)];
    },
    toolsRag: undefined,
    ragRegistry: makeRagRegistry(),
    buildAgent: async (parts) => {
      assert.equal(parts.mcpClients.length, 1);
      return undefined;
    },
  });

  await factory.build({ sessionId: 's1' });
  assert.deepEqual(seen, ['s1']);
  assert.deepEqual(log, ['start:a']);
});

test('teardown runs closePipeline, then closeSession, then onDispose, then stop', async () => {
  const order: string[] = [];
  const ragRegistry = {
    closeSession: async () => {
      order.push('closeSession');
      return { ok: true as const, value: undefined };
    },
  } as unknown as IRagRegistry;

  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    mcpServerFactory: () => [
      {
        async start() {
          return stubClient();
        },
        async stop() {
          order.push('stop');
        },
      },
    ],
    closePipeline: async () => {
      order.push('closePipeline');
    },
    onDispose: async () => {
      order.push('onDispose');
    },
    toolsRag: undefined,
    ragRegistry,
    buildAgent: async () => undefined,
  });

  const graph = await factory.build({ sessionId: 's1' });
  await graph.dispose();

  assert.deepEqual(order, ['closePipeline', 'closeSession', 'onDispose', 'stop']);
});

test('without mcpServerFactory nothing changes: mcpClientFactory is used and no stop runs', async () => {
  const order: string[] = [];
  const ragRegistry = {
    closeSession: async () => {
      order.push('closeSession');
      return { ok: true as const, value: undefined };
    },
  } as unknown as IRagRegistry;

  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [stubClient()],
    onDispose: async () => {
      order.push('onDispose');
    },
    toolsRag: undefined,
    ragRegistry,
    buildAgent: async (parts) => {
      assert.equal(parts.mcpClients.length, 1);
      return undefined;
    },
  });

  const graph = await factory.build({ sessionId: 's1' });
  await graph.dispose();

  assert.deepEqual(order, ['closeSession', 'onDispose']);
});

test('adopting mcpServerFactory alone compiles and runs: no deprecated stub needed', async () => {
  const factory = new SessionGraphFactory({
    mcpServerFactory: () => [
      {
        async start() {
          return stubClient();
        },
        async stop() {},
      },
    ],
    toolsRag: undefined,
    ragRegistry: makeRagRegistry(),
    buildAgent: async (parts) => {
      assert.equal(parts.mcpClients.length, 1);
      return undefined;
    },
  });

  const graph = await factory.build({ sessionId: 's1' });
  await graph.dispose();
});

test('no factory at all is a configuration error, named in the message', async () => {
  const factory = new SessionGraphFactory({
    toolsRag: undefined,
    ragRegistry: makeRagRegistry(),
    buildAgent: async () => undefined,
  });

  await assert.rejects(
    () => factory.build({ sessionId: 's1' }),
    /mcpServerFactory/,
  );
});

test('a partly-filled descriptor set throws before any server is started', async () => {
  let started = 0;
  const factory = new SessionGraphFactory({
    mcpServerFactory: () => [
      {
        descriptor: { slotIndex: 0, label: 'abap' },
        async start() {
          started++;
          return stubClient();
        },
        async stop() {},
      },
      {
        async start() {
          started++;
          return stubClient();
        },
        async stop() {},
      },
    ],
    toolsRag: undefined,
    ragRegistry: makeRagRegistry(),
    buildAgent: async () => undefined,
  });

  await assert.rejects(() => factory.build({ sessionId: 's1' }), /descriptor/i);
  assert.equal(started, 0);
});

test('a failing stop is surfaced, not thrown', async () => {
  const warnings: string[] = [];
  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    mcpServerFactory: () => [
      {
        async start() {
          return stubClient();
        },
        async stop() {
          throw new Error('boom');
        },
      },
    ],
    toolsRag: undefined,
    ragRegistry: makeRagRegistry(),
    buildAgent: async () => undefined,
    logger: {
      log: (e) => {
        if (e.type === 'warning') warnings.push(e.message);
      },
    },
  });

  const graph = await factory.build({ sessionId: 's1' });
  await graph.dispose();
  assert.equal(warnings.some((m) => m.includes('boom')), true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -w @mcp-abap-adt/llm-agent-libs`
Expected: FAIL — `mcpServerFactory` is not a known option, so no server starts and the order assertion sees `['closeSession', 'onDispose']`.

- [ ] **Step 3: Add the two options**

In `SessionGraphFactoryOptions`, above `mcpClientFactory`:

```ts
  /**
   * Servers for THIS caller: the factory starts each one before `buildAgent`,
   * hands the clients over, and stops them last on dispose. Takes the identity,
   * which is what per-caller credentials need and what `mcpClientFactory` never
   * had.
   *
   * When set it takes precedence over `mcpClientFactory` and
   * `mcpClientFactoryWithDescriptors`.
   */
  readonly mcpServerFactory?: (identity: SessionGraphIdentity) => IMcpServer[];

  /**
   * Per-session teardown that must run BEFORE the session's RAG collections are
   * deleted — closing a pipeline still in flight, which must not write into a
   * collection being removed.
   *
   * `onDispose` keeps its documented place after `closeSession`; this hook is
   * the one that runs first.
   */
  readonly closePipeline?: (sessionId: string) => Promise<void>;
```

Mark the two older factories deprecated **and make `mcpClientFactory` optional**, so adopting the new seam does not force a consumer to keep a dummy deprecated callback forever:

```ts
  /**
   * @deprecated Use `mcpServerFactory`, which also owns lifetime and receives
   * the identity. Optional since this release: supply exactly one of
   * `mcpServerFactory`, `mcpClientFactoryWithDescriptors` or this.
   */
  readonly mcpClientFactory?: (identity: SessionGraphIdentity) => IMcpClient[];
```

and the same `@deprecated` tag above `mcpClientFactoryWithDescriptors`.

Widening a required field to optional is additive — every existing consumer still compiles — but it means `build()` must now say so when a caller supplies none of the three. Add that check at the top of `build()`:

```ts
    if (
      !this.opts.mcpServerFactory &&
      !this.opts.mcpClientFactoryWithDescriptors &&
      !this.opts.mcpClientFactory
    )
      throw new Error(
        'SessionGraphFactory needs one of mcpServerFactory, mcpClientFactoryWithDescriptors or mcpClientFactory',
      );
```

- [ ] **Step 4: Start the servers in `build()`**

In `build()`, replace the client-resolution block with:

```ts
    let mcpClients: IMcpClient[];
    let mcpClientDescriptors: readonly McpClientDescriptor[] | undefined;
    let configuredSlotCount: number | undefined;
    const startedServers: IMcpServer[] = [];
    if (this.opts.mcpServerFactory) {
      const servers = this.opts.mcpServerFactory(identity);
      const descriptors = servers
        .map((s) => s.descriptor)
        .filter((d): d is McpClientDescriptor => d !== undefined);
      // All or none — see the builder's identical check and why it throws.
      if (descriptors.length !== 0 && descriptors.length !== servers.length)
        throw new Error(
          `mcpServerFactory: ${descriptors.length} of ${servers.length} servers carry a descriptor — descriptors are all or none`,
        );

      const clients: IMcpClient[] = [];
      try {
        for (const server of servers) {
          clients.push(await server.start());
          startedServers.push(server);
        }
      } catch (err) {
        for (const server of startedServers.splice(0)) {
          try {
            await server.stop();
          } catch {
            // The original failure is what the caller needs to see.
          }
        }
        throw err;
      }
      mcpClients = clients;
      mcpClientDescriptors = descriptors.length > 0 ? descriptors : undefined;
      // Nothing was filtered out of a configured set, so there is no original
      // count to preserve; array position is the pairing.
      configuredSlotCount = undefined;
    } else if (this.opts.mcpClientFactoryWithDescriptors) {
      const built = this.opts.mcpClientFactoryWithDescriptors(identity);
      mcpClients = built.clients;
      mcpClientDescriptors = built.clientDescriptors;
      configuredSlotCount = built.configuredSlotCount;
    } else {
      // The guard at the top of build() has already ruled out "none set".
      mcpClients = this.opts.mcpClientFactory?.(identity) ?? [];
    }
```

- [ ] **Step 5: Extend the dispose closure**

Inside the `dispose: async (sessionId) => {` closure, **before** the existing `closeSession` call:

```ts
        // Runs first: a pipeline still in flight must not write into a session
        // collection that `closeSession` is about to delete. Best-effort, like
        // every other step here.
        if (this.opts.closePipeline) {
          try {
            await this.opts.closePipeline(sessionId);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (this.opts.logger) {
              this.opts.logger.log({
                type: 'warning',
                traceId: `session:${sessionId}`,
                message: `session_close_pipeline_failed: ${message}`,
              });
            } else {
              console.warn(
                `[session] closePipeline(${sessionId}) failed: ${message}`,
              );
            }
          }
        }
```

And **after** the existing `onDispose` block, still inside the closure:

```ts
        // Last: the clients outlive the pipeline that was still calling them.
        for (const server of startedServers) {
          try {
            await server.stop();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (this.opts.logger) {
              this.opts.logger.log({
                type: 'warning',
                traceId: `session:${sessionId}`,
                message: `session_mcp_stop_failed: ${message}`,
              });
            } else {
              console.warn(
                `[session] mcp stop(${sessionId}) failed: ${message}`,
              );
            }
          }
        }
```

Add `IMcpServer` to the type imports at the top of the file.

- [ ] **Step 6: Run the tests**

Run: `npm test -w @mcp-abap-adt/llm-agent-libs && npm run build -w @mcp-abap-adt/llm-agent-libs`
Expected: the four new tests pass, and `session-graph-factory.test.ts` — which uses `mcpClientFactory` and no new option — passes unchanged. That existing test is the proof that the old path did not move.

- [ ] **Step 7: Commit**

```bash
git add packages/llm-agent-libs/src/session/session-graph-factory.ts \
        packages/llm-agent-libs/src/session/__tests__/session-graph-factory-servers.test.ts
git commit -m "feat(llm-agent-libs): per-caller MCP servers, with a teardown that ends last

mcpServerFactory takes the identity that buildPerSessionMcpClients never had.
closePipeline is a new hook rather than a moved one: onDispose keeps the place
its own docstring promises, so a consumer that declines both sees no change."
```

---

### Task 5: `llm-agent-server-libs` consumes the seam

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/index.ts` (the options block around :68–83; the `SessionGraphFactory` construction; `closeBySession`)
- Create: `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/__tests__/mcp-server-factory-wiring.test.ts`

**Interfaces:**
- Consumes: `mcpServerFactory`, `closePipeline` (Task 4); `IMcpServer` (Task 1).
- Produces: an optional `buildPerSessionMcpServers?: (identity: SessionGraphIdentity) => IMcpServer[]` option, taking precedence over `buildPerSessionMcpClients`.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/__tests__/mcp-server-factory-wiring.test.ts`.
The exported composer is `buildSessionLifecycle(opts: SessionLifecycleOptions)`; its
required options are `idleTtlMs`, `maxSessions`, `cookieName`, `mcpClients`,
`toolsRag`, `ragRegistry` and `buildAgent`; and the returned object's `acquire`
takes a **session id string**, not an identity object.

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IMcpClient, IMcpServer, IRagRegistry } from '@mcp-abap-adt/llm-agent';
import { buildSessionLifecycle } from '../index.js';

function stubClient(): IMcpClient {
  return {
    async listTools() {
      return { ok: true as const, value: [] };
    },
    async callTool() {
      return { ok: true as const, value: { content: [] } };
    },
  } as unknown as IMcpClient;
}

const ragRegistry = {
  closeSession: async () => ({ ok: true as const, value: undefined }),
} as unknown as IRagRegistry;

const base = {
  idleTtlMs: 60_000,
  maxSessions: 4,
  cookieName: 'sid',
  mcpClients: [] as IMcpClient[],
  toolsRag: undefined,
  ragRegistry,
  buildAgent: async () => undefined,
};

describe('buildSessionLifecycle — per-session MCP servers', () => {
  it('forwards buildPerSessionMcpServers, identity and all, ahead of the client builder', async () => {
    const seen: string[] = [];
    let clientBuilderCalls = 0;

    const lifecycle = buildSessionLifecycle({
      ...base,
      buildPerSessionMcpClients: () => {
        clientBuilderCalls++;
        return { clients: [stubClient()], close: async () => {} };
      },
      buildPerSessionMcpServers: (identity): IMcpServer[] => {
        seen.push(identity.sessionId);
        return [
          {
            async start() {
              return stubClient();
            },
            async stop() {},
          },
        ];
      },
    });

    try {
      await lifecycle.acquire('s1');
      assert.deepEqual(seen, ['s1']);
      assert.equal(clientBuilderCalls, 0);
    } finally {
      await lifecycle.disposeAll();
    }
  });

  it('mcpSharedClient does not suppress the server factory', async () => {
    const seen: string[] = [];

    const lifecycle = buildSessionLifecycle({
      ...base,
      mcpSharedClient: true,
      buildPerSessionMcpServers: (identity): IMcpServer[] => {
        seen.push(identity.sessionId);
        return [
          {
            async start() {
              return stubClient();
            },
            async stop() {},
          },
        ];
      },
    });

    try {
      await lifecycle.acquire('s1');
      // `mcpSharedClient` only ever gated `buildPerSessionMcpClients`; a
      // caller wanting one shared server returns the same instance each time.
      assert.deepEqual(seen, ['s1']);
    } finally {
      await lifecycle.disposeAll();
    }
  });

  it('without it, the existing per-session client builder still runs', async () => {
    let clientBuilderCalls = 0;

    const lifecycle = buildSessionLifecycle({
      ...base,
      buildPerSessionMcpClients: () => {
        clientBuilderCalls++;
        return { clients: [stubClient()], close: async () => {} };
      },
    });

    try {
      await lifecycle.acquire('s1');
      assert.equal(clientBuilderCalls, 1);
    } finally {
      await lifecycle.disposeAll();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -w @mcp-abap-adt/llm-agent-server-libs`
Expected: FAIL — `buildPerSessionMcpServers` is not a known option, so the client builder runs instead.

- [ ] **Step 3: Add the option and pass it through**

Add to `SessionLifecycleOptions`, beside `buildPerSessionMcpClients`:

```ts
  /**
   * Per-session MCP servers. Preferred over `buildPerSessionMcpClients`: it
   * receives the identity, and `SessionGraphFactory` owns start and stop, so
   * this module keeps no `close` of its own.
   *
   * `mcpSharedClient` does not apply: a caller that wants one shared server
   * returns the same instance from every call.
   */
  buildPerSessionMcpServers?: (identity: SessionGraphIdentity) => IMcpServer[];
```

In the `new SessionGraphFactory({...})` call, beside the two existing factories:

```ts
    ...(opts.buildPerSessionMcpServers
      ? { mcpServerFactory: opts.buildPerSessionMcpServers }
      : {}),
```

Leave `mcpClientFactory` and `mcpClientFactoryWithDescriptors` exactly as they are. Both stay populated; Task 4 gives `mcpServerFactory` precedence, so when it is set they are simply not called — and when it is not set, today's behaviour stands untouched.

The file already imports `IMcpClient`, `ILogger`, `IRag`, `IRagRegistry` and `McpClientDescriptor` from `@mcp-abap-adt/llm-agent`, and `SessionAgentParts`, `SessionGraph`, `SessionGraphFactory`, `SessionRegistry`, `SmartAgent` from `@mcp-abap-adt/llm-agent-libs`. Add `IMcpServer` to the first import and `SessionGraphIdentity` to the second — neither is imported here today.

- [ ] **Step 4: Deprecate the glue in place**

Add `@deprecated` JSDoc to the two options, keeping their existing docstrings and changing no behaviour:

```ts
  /**
   * [keep the existing docstring here, verbatim]
   *
   * @deprecated Use `buildPerSessionMcpServers`: it receives the identity and
   * the session factory owns the lifetime.
   */
  buildPerSessionMcpClients?: () => {
    clients: IMcpClient[];
    clientDescriptors?: readonly McpClientDescriptor[];
    configuredSlotCount?: number;
    close: () => Promise<void>;
  };

  /**
   * [keep the existing docstring here, verbatim]
   *
   * @deprecated Opting out of per-session isolation belongs to the assembly,
   * not this module.
   */
  mcpSharedClient?: boolean;
```

`closeBySession` is a local `Map` inside `buildSessionLifecycle`, not an option, so there is nothing to tag. Put a comment on its declaration instead:

```ts
  // Serves the deprecated `buildPerSessionMcpClients` path only: a server built
  // through `buildPerSessionMcpServers` is stopped by the session factory.
  const closeBySession = new Map<string, () => Promise<void>>();
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w @mcp-abap-adt/llm-agent-server-libs && npm run build`
Expected: the new test passes; every existing session-lifecycle test passes unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/session-lifecycle/
git commit -m "feat(llm-agent-server-libs): take per-session servers from the framework seam

The glue stays and keeps working, deprecated: an assembly should not have to
own MCP lifetime, and buildPerSessionMcpClients never saw who was asking."
```

---

### Task 6: Tell consumers what they gained

Documentation is not only the changelog: every doc describing the behaviour that changed is updated in this task, not later.

**Files:**
- Modify: `CHANGELOG.md` (the `[Unreleased]` section)
- Modify: `docs/INTEGRATION.md` (new section; and `McpConnectionConfig` is already discussed at :1852, so `env` belongs in that field's company)
- Modify: `docs/ARCHITECTURE.md` (`### 5. MCP Layer`, which opens at :427 — the `Reconnection` bullet at :445 is where "who starts and stops a server" now needs one sentence)
- Modify: `packages/llm-agent-mcp/README.md` (`## Exports` at :8 and the stdio config in `## Usage` at :15 — `env` is a new field a reader of that file must see)

- [ ] **Step 1: CHANGELOG entry**

Under `## [Unreleased]`, add:

```markdown
### Added

- **`IMcpServer`** — starting and stopping an MCP server is now a contract of
  its own, beside `IMcpClient` which is only about using one. One implementation
  per way of starting: a spawned stdio child, a held HTTP connection, an
  in-process server. `mcpServerFromFactory` builds one from the existing
  `McpClientFactory`, whose `close` becomes `stop()`.
- **`SmartAgentBuilder.withMcpServers`** — `build()` starts them and
  `handle.close()` stops them, through the `closeFns` it already awaited.
  Passing both this and `withMcpClients` is a configuration error rather than
  one silently winning, and a set where only some servers carry a `descriptor`
  throws — dropping it would re-namespace tools from their `label` to
  `s${slotIndex}` with nothing reporting it.
- **`SessionGraphFactoryOptions.mcpServerFactory`** — per-caller servers, given
  the identity that `buildPerSessionMcpClients` never received, started before
  the agent is built and stopped last on dispose.
- **`SessionGraphFactoryOptions.closePipeline`** — teardown that runs before the
  session's RAG collections are deleted, so a pipeline still in flight cannot
  write into a collection being removed. `onDispose` keeps its documented place
  after `closeSession`.
- **`McpConnectionConfig.env`** — a spawned stdio child can be given its own
  environment. Without it the MCP SDK falls back to a sanitised subset of this
  process's environment, which every child of every caller then shares.

### Deprecated

Nothing is removed; all of these keep working until the next major.

- `SessionGraphFactoryOptions.mcpClientFactory` and
  `mcpClientFactoryWithDescriptors` — superseded by `mcpServerFactory`.
- `buildPerSessionMcpClients` and `mcpSharedClient` in
  `@mcp-abap-adt/llm-agent-server-libs`.
- `McpClientFactory` as a consumer-facing seam. It stays as the default
  implementation's factory, which `mcpServerFromFactory` consumes.
```

- [ ] **Step 2: INTEGRATION.md section**

Add a section showing both paths verbatim:

````markdown
## Owning an MCP server's lifetime

A client is something you call; a server is something you start and stop. Hand
the framework servers when you know how yours is started — and, for a stdio
child, with what environment:

```ts
import { mcpServerFromFactory } from '@mcp-abap-adt/llm-agent';
import { createDefaultMcpClient } from '@mcp-abap-adt/llm-agent-mcp';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';

const server = mcpServerFromFactory(createDefaultMcpClient, {
  type: 'stdio',
  command: 'my-mcp',
  env: { API_TOKEN: tokenForThisCaller },   // never in args: visible in ps
});

const handle = await new SmartAgentBuilder(cfg)
  .withMainLlm(llm)
  .withMcpServers([server])
  .build();

await handle.close();   // stops every server it started
```

Per session, the factory does the same and knows who is asking:

```ts
import { SessionGraphFactory } from '@mcp-abap-adt/llm-agent-libs';

new SessionGraphFactory({
  mcpServerFactory: (identity) => [serverFor(identity.userId)],
  closePipeline: async (sessionId) => pipelines.get(sessionId)?.close(),
  ragRegistry,
  toolsRag,
  buildAgent,
});
```

Teardown then runs in one order: `closePipeline`, the session's RAG
`closeSession`, your `onDispose`, and the servers' `stop()` last.
````

- [ ] **Step 3: ARCHITECTURE.md and the MCP README**

In `docs/ARCHITECTURE.md`, in `### 5. MCP Layer`, beside the `Reconnection` bullet:

```markdown
- **Lifetime** — `IMcpServer` (`start`/`stop`, optional `descriptor`) is how a
  caller hands over a server the framework should own: `withMcpServers` starts
  them in `build()` and stops them in `handle.close()`;
  `SessionGraphFactory.mcpServerFactory(identity)` does the same per session and
  stops them last on dispose. Using a server stays `IMcpClient`, and
  reconnection stays `IMcpConnectionStrategy`'s — a stopped server is not
  restarted.
```

In `packages/llm-agent-mcp/README.md`, add `env` to the stdio example under `## Usage` and one line under `## Exports` noting that `createDefaultMcpClient` is what `mcpServerFromFactory` wraps.

- [ ] **Step 4: Verify and commit**

Run: `npm run lint:check && npm run build && npm test`
Expected: clean across all workspaces.

```bash
git add CHANGELOG.md docs/INTEGRATION.md docs/ARCHITECTURE.md \
        packages/llm-agent-mcp/README.md
git commit -m "docs: the MCP lifetime seam, and what it replaces"
```

---

## Verification of the whole workstream

Run from the repository root:

```bash
npm run build && npm test && npm run lint:check
```

Expected:
- every workspace builds;
- the new tests pass alongside the existing ones — in particular
  `session-graph-factory.test.ts`, which exercises the old `mcpClientFactory`
  path and must be untouched by all of this;
- Biome reports no new warnings.

The claim this workstream makes, and what proves it: **a consumer who ignores
every new option sees no change.** The proof is that the pre-existing tests of
the builder and the session factory pass without modification. If any of them
needed editing, the change stopped being additive — stop and report it rather
than adjusting the test.
