/**
 * Spec §10.5.12 U8, §13 B15, D83 (5): the server's YAML `agent.toolUnavailableTtlMs`
 * is the opt-in for `HeuristicToolAvailabilityPolicy({ ttlMs })` — set → injected
 * into the main agent and every worker, unset → none (no 600000 default).
 * `PUT /v1/config` refuses the key; an invalid value fails the start.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import {
  emptyLoadedPlugins,
  HeuristicToolAvailabilityPolicy,
  SmartAgentBuilder,
} from '@mcp-abap-adt/llm-agent-libs';
import { resolveSmartServerConfig } from '../config.js';
import { ConfigFieldError } from '../config-fields.js';
import { SmartServer, type SmartServerConfig } from '../smart-server.js';
import { loadYamlConfig } from '../yaml-loader.js';
import { constructionSeams } from './construction-seams.js';

const noPlugins = { load: async () => emptyLoadedPlugins() };

const MAIN = `llm:
  provider: openai
  model: gpt-4o
subagents:
  - name: worker
    config: ./worker.yaml
`;

/** The real start config of `main` (with `worker` as the worker's file), through `resolveSmartServerConfig`. */
function resolveFrom(
  t: TestContext,
  main: string,
  worker = 'skipModelValidation: true\n',
): SmartServerConfig {
  const dir = mkdtempSync(join(tmpdir(), 'tool-availability-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mainPath = join(dir, 'smart-server.yaml');
  writeFileSync(mainPath, main);
  writeFileSync(join(dir, 'worker.yaml'), worker);
  return {
    ...resolveSmartServerConfig(
      {},
      loadYamlConfig(mainPath, {}),
      {},
      {
        configPath: mainPath,
        skipProviderRuntimeChecks: true,
      },
    ),
    port: 0,
    skipModelValidation: true,
    pluginLoader: noPlugins,
  } as SmartServerConfig;
}

type Built = { worker: boolean; policy: unknown };

/** Every agent the server builds, with the tool availability policy its builder holds. */
async function builtAgents(cfg: SmartServerConfig): Promise<Built[]> {
  const proto = SmartAgentBuilder.prototype;
  const origBuild = proto.build;
  const built: Built[] = [];
  let inWorker = 0;
  proto.build = function (this: SmartAgentBuilder) {
    built.push({
      worker: inWorker > 0,
      policy: (this as unknown as { _toolAvailabilityPolicy?: unknown })
        ._toolAvailabilityPolicy,
    });
    return origBuild.call(this);
  };
  try {
    const server = new SmartServer(cfg, constructionSeams);
    const self = server as unknown as {
      buildSubAgent: (...a: unknown[]) => Promise<unknown>;
    };
    const origSub = self.buildSubAgent;
    self.buildSubAgent = async function (this: unknown, ...a: unknown[]) {
      inWorker++;
      try {
        return await origSub.apply(this, a);
      } finally {
        inWorker--;
      }
    };
    const handle = await server._buildEmbeddedAgent();
    await handle.close();
  } finally {
    proto.build = origBuild;
  }
  assert.ok(
    built.some((b) => b.worker),
    'a worker agent was built',
  );
  assert.ok(
    built.some((b) => !b.worker),
    'a main agent was built',
  );
  return built;
}

function ttlOf(policy: unknown): number {
  assert.ok(
    policy instanceof HeuristicToolAvailabilityPolicy,
    `expected a HeuristicToolAvailabilityPolicy, got ${String(policy)}`,
  );
  // The heuristic answers its TTL for a "not found" error.
  const decision = policy.onToolError('T', 'object not found');
  assert.ok(decision);
  return decision.ttlMs;
}

describe('U8: agent.toolUnavailableTtlMs opts in to the heuristic policy', () => {
  it('unset → no policy injected into the main agent or a worker; the config holds no default', async (t) => {
    const cfg = resolveFrom(t, MAIN);
    assert.equal(cfg.agent?.toolUnavailableTtlMs, undefined);
    assert.ok(!('toolUnavailableTtlMs' in (cfg.agent ?? {})));
    const built = await builtAgents(cfg);
    assert.deepEqual(
      built.map((b) => b.policy),
      built.map(() => undefined),
    );
  });

  it('5000 → a HeuristicToolAvailabilityPolicy with ttlMs 5000 in the main agent and the worker', async (t) => {
    const cfg = resolveFrom(t, `${MAIN}agent:\n  toolUnavailableTtlMs: 5000\n`);
    assert.equal(cfg.agent?.toolUnavailableTtlMs, 5000);
    const built = await builtAgents(cfg);
    for (const b of built) assert.equal(ttlOf(b.policy), 5000);
  });

  it("a worker's own agent.toolUnavailableTtlMs wins over the parent's", async (t) => {
    const cfg = resolveFrom(
      t,
      `${MAIN}agent:\n  toolUnavailableTtlMs: 5000\n`,
      'skipModelValidation: true\nagent:\n  toolUnavailableTtlMs: 7000\n',
    );
    const built = await builtAgents(cfg);
    for (const b of built)
      assert.equal(ttlOf(b.policy), b.worker ? 7000 : 5000);
  });

  it('an invalid value fails the start with the shared validator’s error', (t) => {
    const cases: [unknown, string][] = [
      [
        'soon',
        'invalid config — agent.toolUnavailableTtlMs must be a finite number, got "soon"',
      ],
      [-1, 'invalid config — agent.toolUnavailableTtlMs must be >= 0, got -1'],
    ];
    for (const [value, message] of cases) {
      assert.throws(
        () =>
          resolveFrom(
            t,
            `${MAIN}agent:\n  toolUnavailableTtlMs: ${JSON.stringify(value)}\n`,
          ),
        (err: unknown) =>
          err instanceof ConfigFieldError && err.message === message,
        String(value),
      );
    }
  });

  it('PUT /v1/config with agent.toolUnavailableTtlMs → 400, the key is not updatable', async () => {
    const server = new SmartServer(
      {
        ...(resolveSmartServerConfig(
          {},
          { llm: { provider: 'openai', model: 'gpt-4o' } },
          {},
          { skipProviderRuntimeChecks: true },
        ) as SmartServerConfig),
        port: 0,
        skipModelValidation: true,
        pluginLoader: noPlugins,
      },
      constructionSeams,
    );
    const handle = await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: { toolUnavailableTtlMs: 1 } }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: { message: string } };
      assert.equal(
        body.error.message,
        'Unsupported agent config fields: toolUnavailableTtlMs',
      );
    } finally {
      await handle.close();
    }
  });
});
