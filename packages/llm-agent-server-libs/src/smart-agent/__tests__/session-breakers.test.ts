/**
 * Spec §14.2 (circuit breaker) and §14.4 (a cancellation is not a failure):
 * one LLM breaker per `llm:` key behind every role, and one embedder breaker
 * fed by the server's real embedding calls.
 */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import {
  CircuitBreaker,
  CircuitBreakerLlm,
  type CircuitState,
  type IEmbedder,
  type ILlm,
  type IModelResolver,
  type IRetrievalEmbedder,
  isBatchEmbedder,
  LlmError,
  withCircuitBreaker,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import type { IRoleLlmResolver } from '../llm/role-llm-resolver.js';
import { resolveRetrievalEmbedder } from '../resolve-agent-embedder.js';
import { SmartServer, type SmartServerConfig } from '../smart-server.js';
import { constructionSeams, stubLlm } from './construction-seams.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const text = body !== undefined ? JSON.stringify(body) : undefined;
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(text !== undefined
            ? { 'Content-Length': Buffer.byteLength(text) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            raw: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (text !== undefined) req.write(text);
    req.end();
  });
}

async function healthStates(port: number): Promise<CircuitState[]> {
  const res = await httpRequest(port, 'GET', '/health');
  const body = JSON.parse(res.raw) as {
    circuitBreakers?: Array<{ index: number; state: CircuitState }>;
  };
  return (body.circuitBreakers ?? []).map((b) => b.state);
}

const chat = (port: number, sessionId: string) =>
  httpRequest(port, 'POST', '/v1/chat/completions', {
    messages: [{ role: 'user', content: 'hi' }],
    session_id: sessionId,
  });

/** An LLM whose every call fails; counts calls. */
function failingLlm(model: string, counter?: { n: number }): ILlm {
  const error = () => new LlmError(`${model} is down`, 'LLM_ERROR');
  return {
    model,
    chat: async () => {
      if (counter) counter.n++;
      return { ok: false, error: error() };
    },
    streamChat: async function* () {
      if (counter) counter.n++;
      yield { ok: false, error: error() };
    },
  } as unknown as ILlm;
}

/** An LLM that never answers until its call's signal aborts; counts calls. */
function hangingLlm(model: string, counter: { n: number }): ILlm {
  const wait = (signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (!signal || signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  return {
    model,
    chat: async (_m: unknown, _t: unknown, o?: { signal?: AbortSignal }) => {
      counter.n++;
      await wait(o?.signal);
      return { ok: false, error: new LlmError('aborted', 'ABORTED') };
    },
    streamChat: async function* (
      _m: unknown,
      _t: unknown,
      o?: { signal?: AbortSignal },
    ) {
      counter.n++;
      await wait(o?.signal);
      yield { ok: false, error: new LlmError('aborted', 'ABORTED') };
    },
  } as unknown as ILlm;
}

type Internals = {
  roleLlm(): IRoleLlmResolver;
  _llmBreakers?: { list(): readonly CircuitBreaker[] };
  _embedderBreaker?: CircuitBreaker;
  _resolvedEmbedder?: IRetrievalEmbedder;
  _buildEmbeddedAgent(): Promise<{
    agent: {
      process(
        text: string,
        options?: { signal?: AbortSignal },
      ): Promise<unknown>;
    };
    close: () => Promise<void>;
  }>;
  buildServerCtx(scope: unknown): Promise<{
    resolveLlm(role: string): Promise<ILlm>;
    resolveNamedLlm(key: string): Promise<ILlm>;
  }>;
  _workers: unknown;
};
const internals = (s: SmartServer) => s as unknown as Internals;

function breakerOf(llm: ILlm): CircuitBreaker {
  assert.ok(llm instanceof CircuitBreakerLlm, 'the LLM is breaker-guarded');
  return llm.breaker;
}

const innerOf = (llm: CircuitBreakerLlm): ILlm =>
  (llm as unknown as { inner: ILlm }).inner;

const stubEmbedder: IEmbedder = { embed: async () => ({ vector: [0, 0, 1] }) };

// ---------------------------------------------------------------------------
// LLM breakers
// ---------------------------------------------------------------------------

describe('SmartServer LLM breakers — one per llm: key behind every role', () => {
  it('two failing HTTP chats open the main breaker; /health reports it', async () => {
    const server = new SmartServer(
      {
        port: 0,
        skipModelValidation: true,
        circuitBreaker: { failureThreshold: 2 },
        llm: {
          main: { provider: 'openai', model: 'm-main' },
          classifier: { provider: 'openai', model: 'm-cls' },
        },
        agent: { classificationEnabled: false },
      } as unknown as SmartServerConfig,
      {
        ...constructionSeams,
        makeLlm: async (c) =>
          c.model === 'm-main' ? failingLlm('m-main') : stubLlm(c.model),
      },
    );
    const handle = await server.start();
    try {
      const breakers = internals(server)._llmBreakers;
      assert.ok(breakers, 'circuitBreaker: builds the LLM breakers');
      const mainBreaker = breakerOf(
        await internals(server).roleLlm().resolve('main'),
      );
      const at = breakers.list().indexOf(mainBreaker);
      assert.ok(at >= 0);
      assert.deepEqual(
        new Set(await healthStates(handle.port)),
        new Set(['closed']),
      );
      await chat(handle.port, 's-1');
      await chat(handle.port, 's-1');
      const states = await healthStates(handle.port);
      assert.equal(states[at], 'open', 'the main breaker opened');
      assert.equal(
        states.filter((s) => s === 'open').length,
        1,
        'no other breaker moved',
      );
      assert.equal(
        states.length,
        breakers.list().length + 1,
        '/health lists every LLM breaker and the embedder breaker',
      );
    } finally {
      await handle.close();
    }
  });

  it('a controller planner role (ctx.resolveLlm) failing twice opens its key, not main', async () => {
    const server = new SmartServer(
      {
        skipModelValidation: true,
        circuitBreaker: { failureThreshold: 2 },
        llm: {
          main: { provider: 'openai', model: 'm-main' },
          planner: { provider: 'openai', model: 'm-planner' },
        },
        pipeline: {
          name: 'controller',
          config: { subagents: { evaluator: {}, planner: {}, executor: {} } },
        },
      } as unknown as SmartServerConfig,
      {
        ...constructionSeams,
        makeLlm: async (c) =>
          c.model === 'm-planner' ? failingLlm('m-planner') : stubLlm(c.model),
        embedder: stubEmbedder,
      },
    );
    const { agent, close } = await internals(server)._buildEmbeddedAgent();
    try {
      await agent.process('do a task');
      await agent.process('do a task');
      const role = internals(server).roleLlm();
      assert.equal(breakerOf(await role.resolve('planner')).state, 'open');
      assert.equal(breakerOf(await role.resolve('main')).state, 'closed');
    } finally {
      await close();
    }
  });

  it('a controller role naming its key (ctx.resolveNamedLlm) failing twice opens that key', async () => {
    const server = new SmartServer(
      {
        skipModelValidation: true,
        circuitBreaker: { failureThreshold: 2 },
        llm: {
          main: { provider: 'openai', model: 'm-main' },
          cheap: { provider: 'openai', model: 'm-cheap' },
        },
        pipeline: {
          name: 'controller',
          config: {
            subagents: {
              evaluator: {},
              planner: { llm: 'cheap' },
              executor: {},
            },
          },
        },
      } as unknown as SmartServerConfig,
      {
        ...constructionSeams,
        makeLlm: async (c) =>
          c.model === 'm-cheap' ? failingLlm('m-cheap') : stubLlm(c.model),
        embedder: stubEmbedder,
      },
    );
    const { agent, close } = await internals(server)._buildEmbeddedAgent();
    try {
      await agent.process('do a task');
      await agent.process('do a task');
      const role = internals(server).roleLlm();
      assert.equal(breakerOf(await role.resolveNamed('cheap')).state, 'open');
      assert.equal(breakerOf(await role.resolve('main')).state, 'closed');
    } finally {
      await close();
    }
  });

  it('a stepper planner role failing twice opens its key, not main', async () => {
    const server = new SmartServer(
      {
        skipModelValidation: true,
        circuitBreaker: { failureThreshold: 2 },
        llm: {
          main: { provider: 'openai', model: 'm-main' },
          planner: { provider: 'openai', model: 'm-planner' },
        },
        pipeline: { name: 'stepper', config: { mode: 'planned-react' } },
      } as unknown as SmartServerConfig,
      {
        ...constructionSeams,
        makeLlm: async (c) =>
          c.model === 'm-planner' ? failingLlm('m-planner') : stubLlm(c.model),
        embedder: stubEmbedder,
      },
    );
    const { agent, close } = await internals(server)._buildEmbeddedAgent();
    try {
      await agent.process('do a task');
      await agent.process('do a task');
      const role = internals(server).roleLlm();
      assert.equal(breakerOf(await role.resolve('planner')).state, 'open');
      assert.equal(breakerOf(await role.resolve('main')).state, 'closed');
    } finally {
      await close();
    }
  });

  it('two sessions resolving one key share one breaker; no builder gets a double-wrapped LLM', async () => {
    const seen: ILlm[] = [];
    const proto = SmartAgentBuilder.prototype;
    const orig = {
      main: proto.withMainLlm,
      cls: proto.withClassifierLlm,
      helper: proto.withHelperLlm,
    };
    proto.withMainLlm = function (this: SmartAgentBuilder, l: ILlm) {
      seen.push(l);
      return orig.main.call(this, l);
    };
    proto.withClassifierLlm = function (this: SmartAgentBuilder, l: ILlm) {
      seen.push(l);
      return orig.cls.call(this, l);
    };
    proto.withHelperLlm = function (this: SmartAgentBuilder, l: ILlm) {
      seen.push(l);
      return orig.helper.call(this, l);
    };
    const server = new SmartServer(
      {
        port: 0,
        skipModelValidation: true,
        circuitBreaker: { failureThreshold: 2 },
        llm: {
          main: { provider: 'openai', model: 'm-main' },
          helper: { provider: 'openai', model: 'm-helper' },
          reviewer: { provider: 'openai', model: 'm-reviewer' },
        },
      } as unknown as SmartServerConfig,
      { ...constructionSeams, embedder: stubEmbedder },
    );
    const handle = await server.start();
    try {
      await chat(handle.port, 's-a');
      await chat(handle.port, 's-b');
      const s = internals(server);
      s._workers = {
        build: async () => new Map(),
        drain: async () => {},
        cache: new Map(),
      };
      const ctxOf = (id: string) =>
        s.buildServerCtx({
          sessionId: id,
          parts: {
            sessionId: id,
            mcpClients: [],
            toolsRag: undefined,
            ragRegistry: {} as never,
            logger: undefined,
          },
        });
      const [a, b] = [await ctxOf('s-a'), await ctxOf('s-b')];
      const ra = await a.resolveLlm('reviewer');
      const rb = await b.resolveNamedLlm('reviewer');
      assert.equal(breakerOf(ra), breakerOf(rb), 'one breaker per key');
      assert.equal(
        breakerOf(await a.resolveLlm('main')),
        breakerOf(await b.resolveLlm('main')),
      );
      assert.notEqual(
        breakerOf(await a.resolveLlm('main')),
        breakerOf(ra),
        'a different key, a different breaker',
      );
      assert.ok(seen.length >= 6, 'startup and both sessions built');
      for (const l of seen) {
        const guarded = breakerOf(l);
        assert.ok(guarded);
        assert.equal(
          innerOf(l as CircuitBreakerLlm) instanceof CircuitBreakerLlm,
          false,
          'never a breaker over a breaker',
        );
      }
    } finally {
      proto.withMainLlm = orig.main;
      proto.withClassifierLlm = orig.cls;
      proto.withHelperLlm = orig.helper;
      await handle.close();
    }
  });

  it('PUT /v1/config swapping main gives it a fresh breaker; a ready CircuitBreakerLlm reports its own', async () => {
    const swapped = stubLlm('m-swapped');
    const ownBreaker = new CircuitBreaker({ failureThreshold: 2 });
    const own = new CircuitBreakerLlm(failingLlm('m-own'), ownBreaker);
    const modelResolver: IModelResolver = {
      resolve: async (name) => {
        if (name === 'm-swapped') return swapped;
        if (name === 'm-own') return own;
        throw new Error(`unknown model ${name}`);
      },
    };
    const server = new SmartServer(
      {
        port: 0,
        skipModelValidation: true,
        modelResolver,
        circuitBreaker: { failureThreshold: 2 },
        llm: {
          main: { provider: 'openai', model: 'm-main' },
          classifier: { provider: 'openai', model: 'm-cls' },
        },
        agent: { classificationEnabled: false },
      } as unknown as SmartServerConfig,
      {
        ...constructionSeams,
        makeLlm: async (c) =>
          c.model === 'm-main' ? failingLlm('m-main') : stubLlm(c.model),
      },
    );
    const handle = await server.start();
    try {
      const role = internals(server).roleLlm();
      const breakers = internals(server)._llmBreakers;
      assert.ok(breakers);
      const first = breakerOf(await role.resolve('main'));
      const at = breakers.list().indexOf(first);
      await chat(handle.port, 's-1');
      await chat(handle.port, 's-1');
      assert.equal((await healthStates(handle.port))[at], 'open');

      // Swap main for a plain instance: a fresh, closed breaker takes its place.
      const put = await httpRequest(handle.port, 'PUT', '/v1/config', {
        models: { mainModel: 'm-swapped' },
      });
      assert.equal(put.status, 200);
      const second = breakerOf(await role.resolve('main'));
      assert.notEqual(second, first);
      assert.equal(breakers.list().includes(first), false, 'the old is gone');
      assert.equal(breakers.list().indexOf(second), at);
      assert.equal((await healthStates(handle.port))[at], 'closed');

      // Swap main for a ready CircuitBreakerLlm: not wrapped again, its breaker reported.
      const put2 = await httpRequest(handle.port, 'PUT', '/v1/config', {
        models: { mainModel: 'm-own' },
      });
      assert.equal(put2.status, 200);
      assert.equal(await role.resolve('main'), own, 'not wrapped again');
      assert.equal(breakers.list()[at], ownBreaker);
      assert.equal((await healthStates(handle.port))[at], 'closed');
      await chat(handle.port, 's-2');
      await chat(handle.port, 's-2');
      assert.equal(ownBreaker.state, 'open', 'the new model moves its breaker');
      assert.equal((await healthStates(handle.port))[at], 'open');
    } finally {
      await handle.close();
    }
  });

  it('caller-cancelled requests never open the breaker (CallOptions.signal through process)', async () => {
    const calls = { n: 0 };
    const server = new SmartServer(
      {
        skipModelValidation: true,
        circuitBreaker: { failureThreshold: 2 },
        llm: { main: { provider: 'openai', model: 'm-main' } },
        agent: { classificationEnabled: false },
      } as unknown as SmartServerConfig,
      {
        ...constructionSeams,
        makeLlm: async (c) =>
          c.model === 'm-main' ? hangingLlm('m-main', calls) : stubLlm(c.model),
      },
    );
    const { agent, close } = await internals(server)._buildEmbeddedAgent();
    try {
      for (let i = 0; i < 3; i++) {
        const ctrl = new AbortController();
        const run = agent.process('hi', { signal: ctrl.signal });
        setImmediate(() => ctrl.abort());
        await run;
      }
      assert.ok(calls.n >= 3, 'every request reached the main LLM');
      const main = breakerOf(await internals(server).roleLlm().resolve('main'));
      assert.equal(main.state, 'closed');
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// Embedder breaker
// ---------------------------------------------------------------------------

describe('SmartServer embedder breaker — fed by the retrieval embedder', () => {
  it("failing embeds open the embedder breaker; LLM breakers stay closed; a request fails with the store's error (R1, R5)", async () => {
    let embeds = 0;
    const failing = {
      embed: async () => {
        embeds++;
        throw new Error('embedder down');
      },
      embedBatch: async () => {
        embeds++;
        throw new Error('embedder down');
      },
    } as IEmbedder;
    const server = new SmartServer(
      {
        port: 0,
        skipModelValidation: true,
        circuitBreaker: { failureThreshold: 4, recoveryWindowMs: 60_000 },
        llm: { main: { provider: 'openai', model: 'm-main' } },
        rag: { store: { type: 'in-memory' } },
        agent: { classificationEnabled: false },
      } as unknown as SmartServerConfig,
      { ...constructionSeams, embedder: failing },
    );
    const handle = await server.start();
    try {
      const s = internals(server);
      const embedderBreaker = s._embedderBreaker;
      assert.ok(embedderBreaker, 'circuitBreaker: builds the embedder breaker');
      // R1: no store re-embeds a failed query; each store (tools, history)
      // embeds the text itself because the pipeline has no query embedder
      // (TextOnlyEmbedding); R5: the store's error fails the request
      // (CIRCUIT_OPEN once open).
      const res1 = await chat(handle.port, 's-1');
      assert.notEqual(res1.status, 200, res1.raw);
      assert.equal(embeds, 2, 'one counted embed per store');
      assert.equal(embedderBreaker.state, 'closed');
      const res2 = await chat(handle.port, 's-2');
      assert.notEqual(res2.status, 200, res2.raw);
      assert.equal(embeds, 4);
      const states = await healthStates(handle.port);
      assert.equal(states.at(-1), 'open', 'the embedder breaker is last');
      assert.deepEqual(
        states.slice(0, -1),
        states.slice(0, -1).map(() => 'closed'),
        'the LLM breakers stay closed',
      );
      const before = embeds;
      const res = await chat(handle.port, 's-3');
      assert.notEqual(res.status, 200, res.raw);
      assert.match(res.raw, /CIRCUIT_OPEN/);
      assert.equal(embeds, before, 'no embedding call while open');
    } finally {
      await handle.close();
    }
  });

  it('a caller-cancelled embed does not count against the embedder breaker', async () => {
    const failing = {
      embed: async () => {
        throw new Error('aborted');
      },
    } as IEmbedder;
    const server = new SmartServer(
      {
        port: 0,
        skipModelValidation: true,
        circuitBreaker: { failureThreshold: 2 },
        llm: { main: { provider: 'openai', model: 'm-main' } },
        rag: { store: { type: 'in-memory' } },
      } as unknown as SmartServerConfig,
      { ...constructionSeams, embedder: failing },
    );
    const handle = await server.start();
    try {
      const s = internals(server);
      const retrieval = s._resolvedEmbedder;
      assert.ok(retrieval);
      for (let i = 0; i < 3; i++) {
        const ctrl = new AbortController();
        ctrl.abort();
        await assert.rejects(() =>
          retrieval.embedQuery('x', { signal: ctrl.signal }),
        );
      }
      assert.equal(s._embedderBreaker?.state, 'closed');
    } finally {
      await handle.close();
    }
  });

  it('resolveRetrievalEmbedder applies the wrap to each asymmetric half, below the role', async () => {
    const calls: string[] = [];
    const half = (inputType: string): IEmbedder =>
      ({
        embed: async () => {
          calls.push(inputType);
          return { vector: [1] };
        },
        embedBatch: async (texts: string[]) => {
          calls.push(`${inputType}:batch`);
          return texts.map(() => ({ vector: [1] }));
        },
      }) as IEmbedder;
    const wrapped: IEmbedder[] = [];
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    const retrieval = await resolveRetrievalEmbedder(
      {
        store: { type: 'in-memory' },
        embedder: { provider: 'ollama', model: 'e', asymmetric: true },
      } as never,
      undefined,
      (cfg) => half(String((cfg as { inputType?: string }).inputType)),
      {},
      undefined,
      (e) => {
        const w = withCircuitBreaker(e, breaker);
        wrapped.push(w);
        return w;
      },
    );
    assert.ok(retrieval);
    assert.equal(wrapped.length, 2, 'both halves wrapped');
    for (const w of wrapped) {
      assert.equal(isBatchEmbedder(w), true, 'batch capability kept');
    }
    await retrieval.embedDocument('d');
    await retrieval.embedQuery('q');
    await retrieval.embedDocuments?.(['d1', 'd2']);
    assert.deepEqual(calls, ['document', 'query', 'document:batch']);
  });

  it('resolveRetrievalEmbedder applies the wrap to a symmetric embedder', async () => {
    let wraps = 0;
    const retrieval = await resolveRetrievalEmbedder(
      undefined,
      stubEmbedder,
      constructionSeams.resolveEmbedder,
      {},
      undefined,
      (e) => {
        wraps++;
        return e;
      },
    );
    assert.ok(retrieval);
    assert.equal(wraps, 1);
  });
});
