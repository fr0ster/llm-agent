import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  CircuitBreaker,
  FallbackRag,
  type IEmbedder,
  InMemoryRag,
  type IRetrievalEmbedder,
  SimpleRagRegistry,
  type SmartAgentHandle,
  withCircuitBreaker,
} from '@mcp-abap-adt/llm-agent';
import { testRagAccess } from '@mcp-abap-adt/llm-agent/testing/rag-access-testing';
import {
  bindRagEmbedderBreaker,
  SmartAgentBuilder,
} from '@mcp-abap-adt/llm-agent-libs';
import { EmbedderCircuitBreakers } from '../embedder-circuit-breakers.js';
import { constructionSeams } from './construction-seams.js';
import { TestSmartServer } from './rag-identity-fixture.js';

it('configured embedder identities ignore store names and property order', () => {
  const breakers = new EmbedderCircuitBreakers({});
  const main = breakers.resolve(
    {
      store: { type: 'in-memory', collectionName: 'main' },
      embedder: { provider: 'ollama', model: 'shared' },
    },
    undefined,
  );
  assert.ok(main);
  assert.equal(
    breakers.resolve(
      {
        store: { type: 'in-memory', collectionName: 'worker' },
        embedder: { model: 'shared', url: undefined, provider: 'ollama' },
      },
      undefined,
    ),
    main,
  );
  assert.notEqual(
    breakers.resolve(
      {
        store: { type: 'in-memory' },
        embedder: { provider: 'ollama', model: 'other' },
      },
      undefined,
    ),
    main,
  );
  assert.equal(breakers.list().length, 2);
});

it('embedder accounts have separate breakers and keyword stores need none', () => {
  const breakers = new EmbedderCircuitBreakers({});
  const store = { type: 'in-memory' } as const;
  assert.notEqual(
    breakers.resolve(
      {
        store,
        embedder: { provider: 'openai', model: 'shared', credentialRef: 'a' },
      },
      undefined,
    ),
    breakers.resolve(
      {
        store,
        embedder: { provider: 'openai', model: 'shared', credentialRef: 'b' },
      },
      undefined,
    ),
  );
  assert.equal(breakers.resolve({ store }, undefined), undefined);
  assert.equal(breakers.list().length, 2);
});

for (const mode of ['different', 'same', 'disabled'] as const) {
  it(`worker embedder breaker: ${mode}`, async () => {
    const handles: SmartAgentHandle[] = [];
    const embedders: IRetrievalEmbedder[] = [];
    let calls = 0;
    const main: IEmbedder = { embed: async () => ({ vector: [1] }) };
    const worker: IEmbedder =
      mode === 'same'
        ? main
        : {
            embed: async () => {
              calls++;
              throw new Error('worker embedder down');
            },
          };
    const original = SmartAgentBuilder.prototype.build;
    SmartAgentBuilder.prototype.build = async function () {
      const result = await original.call(this);
      if (result.ok) handles.push(result.value);
      return result;
    };
    const server = new TestSmartServer(
      {
        port: 0,
        skipModelValidation: true,
        llm: { main: { provider: 'ollama', model: 'stub' } },
        ...(mode === 'disabled'
          ? {}
          : {
              circuitBreaker: { failureThreshold: 1, recoveryWindowMs: 60_000 },
            }),
        rag: { store: { type: 'in-memory' } },
        subAgentConfigs: [
          {
            name: 'worker',
            config: {
              skipModelValidation: true,
              embedder: worker,
              rag: { store: { type: 'in-memory' } },
            },
          },
        ],
      },
      {
        ...constructionSeams,
        embedder: main,
        makeRag: async (input) => {
          if (input.embedder) embedders.push(input.embedder);
          return constructionSeams.makeRag(input);
        },
      },
    );
    const running = await server.start();
    try {
      const response = await fetch(
        `http://127.0.0.1:${running.port}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'hi' }],
            session_id: 'worker-test',
          }),
        },
      );
      await response.text();
      assert.ok(handles.length >= 3, 'main and session workers were built');
      const mainHandle = handles[1];
      const workerHandle = handles[0];
      if (mode === 'disabled') {
        assert.ok(handles.every((h) => h.circuitBreakers.length === 0));
        assert.ok(
          handles.every(
            (h) => !(h.ragStores.tools?.rag instanceof FallbackRag),
          ),
        );
        return;
      }
      assert.ok(workerHandle.ragStores.tools?.rag instanceof FallbackRag);
      const breaker = workerHandle.circuitBreakers[0];
      assert.ok(breaker);
      assert.ok(
        handles.filter((h) => h.circuitBreakers.includes(breaker)).length >= 2,
        'the session worker reuses the primary worker breaker',
      );
      if (mode === 'same') {
        assert.ok(
          mainHandle.circuitBreakers.includes(breaker),
          'main and worker share the breaker',
        );
        return;
      }
      assert.equal(
        mainHandle.circuitBreakers.includes(breaker),
        false,
        'different embedder has its own breaker',
      );
      const retrieval = embedders.at(-1);
      assert.ok(retrieval);
      const ctrl = new AbortController();
      ctrl.abort();
      await assert.rejects(
        retrieval.embedQuery('cancelled', { signal: ctrl.signal }),
      );
      assert.equal(breaker.state, 'closed', 'cancellation does not count');
      await assert.rejects(
        retrieval.embedQuery('fail'),
        /worker embedder down/,
      );
      assert.equal(breaker.state, 'open');
      assert.ok(mainHandle.circuitBreakers.every((b) => b.state === 'closed'));
      const before = calls;
      const store = workerHandle.ragStores.tools?.rag;
      assert.ok(store);
      const result = await store.query(
        {
          text: 'fallback',
          toVector: async () => {
            throw new Error('must use keyword fallback');
          },
        },
        5,
      );
      assert.equal(result.ok, true);
      assert.equal(calls, before);
      const health = await fetch(`http://127.0.0.1:${running.port}/health`);
      const body = (await health.json()) as {
        circuitBreakers: { state: string; label?: string }[];
      };
      assert.equal(
        body.circuitBreakers.filter((b) => b.state === 'open').length,
        1,
      );
      assert.ok(
        body.circuitBreakers.some(
          (b) => b.state === 'open' && b.label?.startsWith('embedder:'),
        ),
      );
    } finally {
      SmartAgentBuilder.prototype.build = original;
      await running.close();
    }
  });
}

it('provider aliases and wrapper options share the resolved embedder breaker', () => {
  const breakers = new EmbedderCircuitBreakers({});
  const store = { type: 'in-memory' } as const;
  const main = breakers.resolve(
    {
      store,
      embedder: {
        provider: 'sap-ai-core',
        model: 'shared',
        credentialRef: 'account',
      },
    },
    undefined,
  );
  assert.ok(main);
  assert.equal(
    breakers.resolve(
      {
        store,
        embedder: {
          provider: 'sap-aicore',
          model: 'shared',
          credentialRef: 'account',
          scenario: 'orchestration',
          maxBatchSize: 8,
        },
      },
      undefined,
    ),
    main,
  );
  assert.notEqual(
    breakers.resolve(
      {
        store,
        embedder: {
          provider: 'sap-aicore',
          model: 'other',
          credentialRef: 'account',
        },
      },
      undefined,
    ),
    main,
  );
});

for (const guarded of [false, true]) {
  it(`worker breaker preserves shared parent collection (guarded: ${guarded})`, async () => {
    const parentBreaker = new CircuitBreaker({ failureThreshold: 1 });
    const workerBreaker = new CircuitBreaker({ failureThreshold: 1 });
    const primary = new InMemoryRag();
    bindRagEmbedderBreaker(primary, parentBreaker);
    await primary
      .writer()
      .upsertRaw('parent-doc', 'parent collection document', {});
    const parent = guarded
      ? new FallbackRag(primary, new InMemoryRag(), parentBreaker)
      : primary;
    const registry = new SimpleRagRegistry();
    registry.register('parent', parent, undefined, {
      scope: 'global',
      displayName: 'collection',
    });
    const own = new InMemoryRag();
    bindRagEmbedderBreaker(own, workerBreaker);
    registry.register('worker', own, undefined, {
      scope: 'global',
      displayName: 'collection',
    });
    const result = await new SmartAgentBuilder({ skipModelValidation: true })
      .withRagAccess(testRagAccess())
      .withMainLlm(
        await constructionSeams.makeLlm({ provider: 'ollama', model: 'stub' }),
      )
      .withCircuitBreakers({ embedder: workerBreaker })
      .setToolsRag(own)
      .setRagRegistry(registry)
      .build();
    assert.ok(result.ok);
    try {
      assert.equal(registry.get('parent', 'global'), parent);
      const workerStore = registry.get('worker', 'global');
      assert.ok(workerStore instanceof FallbackRag);
      assert.equal(workerStore.breaker, workerBreaker);
      const failing = withCircuitBreaker(
        {
          embed: async () => {
            throw new Error('worker failed');
          },
        },
        workerBreaker,
      );
      await assert.rejects(failing.embed('fail'), /worker failed/);
      assert.equal(workerBreaker.state, 'open');
      assert.equal(parentBreaker.state, 'closed');
      assert.equal(registry.get('parent', 'global'), parent);
      const found = await parent.query(
        { text: 'parent collection', toVector: async () => [1] },
        5,
      );
      assert.ok(found.ok);
      assert.equal(found.value[0]?.text, 'parent collection document');
    } finally {
      await result.value.close();
    }
  });
}
