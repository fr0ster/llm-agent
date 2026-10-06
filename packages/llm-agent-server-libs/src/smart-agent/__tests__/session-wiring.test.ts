/**
 * Spec §14.1: the output validator, skill manager, LLM-call strategy, query
 * expander and client adapters reach the per-session agents that serve
 * requests. Skills are vectorized into the tools store by the startup build
 * only. The YAML `mcp:` auto-connect stays startup-only (see
 * mcp-single-connect.test.ts).
 */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import type {
  IClientAdapter,
  IOutputValidator,
  IQueryExpander,
  IRag,
  ISkill,
  ISkillManager,
  LoadedPlugins,
} from '@mcp-abap-adt/llm-agent';
import { RagError } from '@mcp-abap-adt/llm-agent';
import {
  emptyLoadedPlugins,
  SmartAgentBuilder,
} from '@mcp-abap-adt/llm-agent-libs';
import { parse } from 'yaml';
import { resolveSmartServerConfig } from '../config.js';
import {
  type BuildAgentDeps,
  SmartServer,
  type SmartServerConfig,
} from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

const BASE_YAML = `
llm:
  provider: openai
  model: gpt-4o
rag:
  store:
    type: in-memory
`;

function configFrom(text: string): SmartServerConfig {
  return {
    ...resolveSmartServerConfig(
      {},
      parse(text),
      {},
      { skipProviderRuntimeChecks: true },
    ),
    port: 0,
    skipModelValidation: true,
  } as SmartServerConfig;
}

function pluginsWith(extra: Partial<LoadedPlugins>) {
  return { load: async () => ({ ...emptyLoadedPlugins(), ...extra }) };
}

function post(
  port: number,
  sessionId: string,
  stream = false,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      session_id: sessionId,
      ...(stream ? { stream: true } : {}),
    });
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

/** Runs `sessions` requests, one per session id, against a started server. */
async function serve(
  server: SmartServer,
  sessions: string[],
  stream = false,
): Promise<void> {
  const handle = await server.start();
  try {
    for (const id of sessions) {
      assert.equal(await post(handle.port, id, stream), 200);
    }
  } finally {
    await handle.close();
  }
}

// A whole ISkill: the skill-select stage reads `getContent`. (Before the
// chat route answered a failed request with 502, the missing method failed
// the request behind a 200 placeholder.)
const SKILL: ISkill = {
  name: 'demo',
  description: 'a demo skill',
  meta: { name: 'demo', description: 'a demo skill' },
  getContent: async () => ({ ok: true, value: 'demo body' }),
  listResources: async () => ({ ok: true, value: [] }),
  readResource: async () => ({ ok: true, value: '' }),
} as unknown as ISkill;

function spySkillManager() {
  const calls = { list: 0 };
  const manager: ISkillManager = {
    listSkills: async () => {
      calls.list++;
      return { ok: true, value: [SKILL] };
    },
    getSkill: async () => ({ ok: true, value: SKILL }),
    matchSkills: async () => ({ ok: true, value: [SKILL] }),
  };
  return { manager, calls };
}

describe('session agents carry the server wiring (§14.1)', () => {
  it('a plugin output validator is invoked on a session request', async () => {
    const seen: string[] = [];
    const outputValidator: IOutputValidator = {
      validate: async (content) => {
        seen.push(content);
        return { ok: true, value: { valid: true } };
      },
    };
    const server = new SmartServer(
      {
        ...configFrom(BASE_YAML),
        pluginLoader: pluginsWith({ outputValidator }),
      },
      { ...constructionSeams },
    );
    await serve(server, ['s-1']);
    assert.equal(seen.length, 1, 'exactly one validation per request');
  });

  it('a skill manager reaches the skill-select stage of a session request', async () => {
    const { manager, calls } = spySkillManager();
    const server = new SmartServer(
      {
        ...configFrom(BASE_YAML),
        pluginLoader: pluginsWith({}),
        skillManager: manager,
      },
      { ...constructionSeams },
    );
    const handle = await server.start();
    try {
      const atStartup = calls.list;
      assert.equal(await post(handle.port, 's-1'), 200);
      assert.ok(
        calls.list > atStartup,
        'the session agent never listed the skills',
      );
    } finally {
      await handle.close();
    }
  });

  it('agent.llmCallStrategy: non-streaming makes a session LLM use chat, not streamChat', async () => {
    const used = { chat: 0, streamChat: 0 };
    const server = new SmartServer(
      {
        ...configFrom(`${BASE_YAML}agent:\n  llmCallStrategy: non-streaming\n`),
        pluginLoader: pluginsWith({}),
      },
      {
        ...constructionSeams,
        makeLlm: async (cfg) =>
          ({
            model: cfg.model,
            chat: async () => {
              used.chat++;
              return { ok: true, value: { content: 'ok', toolCalls: [] } };
            },
            streamChat: async function* () {
              used.streamChat++;
              yield { ok: true, value: { content: 'ok' } };
            },
          }) as never,
      } as BuildAgentDeps,
    );
    await serve(server, ['s-1'], true);
    assert.equal(used.streamChat, 0, 'a streaming call reached the LLM');
    assert.ok(used.chat > 0, 'the LLM was never called through chat');
  });

  it('skills are vectorized once at startup, never per session (N=3)', async () => {
    const { manager } = spySkillManager();
    const upserts: string[] = [];
    const makeRag: BuildAgentDeps['makeRag'] = async (input) => {
      const rag = (await constructionSeams.makeRag(input)) as IRag;
      const writerOf = rag.writer?.bind(rag);
      if (writerOf) {
        rag.writer = () => {
          const w = writerOf();
          if (!w) return w;
          const upsertRaw = w.upsertRaw.bind(w);
          w.upsertRaw = (id, ...rest) => {
            if (id.startsWith('skill:')) upserts.push(id);
            return upsertRaw(id, ...rest);
          };
          return w;
        };
      }
      return rag;
    };
    const server = new SmartServer(
      {
        ...configFrom(BASE_YAML),
        pluginLoader: pluginsWith({}),
        skillManager: manager,
      },
      { ...constructionSeams, makeRag },
    );
    await serve(server, ['s-1', 's-2', 's-3']);
    assert.deepEqual(upserts, ['skill:demo']);
  });

  it('S-5: a skill that cannot be written into the tools store fails start()', async () => {
    const { manager } = spySkillManager();
    const makeRag: BuildAgentDeps['makeRag'] = async (input) => {
      const rag = (await constructionSeams.makeRag(input)) as IRag;
      const writerOf = rag.writer?.bind(rag);
      if (writerOf) {
        rag.writer = () => {
          const w = writerOf();
          if (!w) return w;
          const upsertRaw = w.upsertRaw.bind(w);
          w.upsertRaw = async (id, ...rest) =>
            id.startsWith('skill:')
              ? { ok: false as const, error: new RagError('skill store down') }
              : upsertRaw(id, ...rest);
          return w;
        };
      }
      return rag;
    };
    const server = new SmartServer(
      {
        ...configFrom(BASE_YAML),
        pluginLoader: pluginsWith({}),
        skillManager: manager,
      },
      { ...constructionSeams, makeRag },
    );
    await assert.rejects(server.start(), /skill "demo".*skill store down/);
  });

  it('the query expander and the client adapters reach the session builder', async () => {
    const queryExpander: IQueryExpander = {
      expand: async (q: string) => ({ ok: true, value: q }),
    } as unknown as IQueryExpander;
    const pluginAdapter = {
      name: 'plugin-adapter',
    } as unknown as IClientAdapter;
    const diAdapter = { name: 'di-adapter' } as unknown as IClientAdapter;
    const proto = SmartAgentBuilder.prototype;
    const origExpander = proto.withQueryExpander;
    const origAdapter = proto.withClientAdapter;
    const expanders: IQueryExpander[] = [];
    const adapters: IClientAdapter[] = [];
    proto.withQueryExpander = function (this: SmartAgentBuilder, e) {
      expanders.push(e);
      return origExpander.call(this, e);
    };
    proto.withClientAdapter = function (this: SmartAgentBuilder, a) {
      adapters.push(a);
      return origAdapter.call(this, a);
    };
    try {
      const server = new SmartServer(
        {
          ...configFrom(BASE_YAML),
          pluginLoader: pluginsWith({
            queryExpander,
            clientAdapters: [pluginAdapter],
          }),
          clientAdapters: [diAdapter],
        },
        { ...constructionSeams },
      );
      const handle = await server.start();
      try {
        expanders.length = 0;
        adapters.length = 0;
        assert.equal(await post(handle.port, 's-1'), 200);
        assert.deepEqual(expanders, [queryExpander]);
        assert.deepEqual(adapters.slice(0, 2), [diAdapter, pluginAdapter]);
        assert.equal(adapters.length, 3, 'DI, plugin, then the default');
      } finally {
        await handle.close();
      }
    } finally {
      proto.withQueryExpander = origExpander;
      proto.withClientAdapter = origAdapter;
    }
  });

  it('each session agent gets its own LLM-call strategy instance (fallback is stateful)', async () => {
    const strategies: unknown[] = [];
    const proto = SmartAgentBuilder.prototype;
    const orig = proto.withLlmCallStrategy;
    proto.withLlmCallStrategy = function (this: SmartAgentBuilder, s) {
      strategies.push(s);
      return orig.call(this, s);
    };
    try {
      const server = new SmartServer(
        {
          ...configFrom(`${BASE_YAML}agent:\n  llmCallStrategy: fallback\n`),
          pluginLoader: pluginsWith({}),
        },
        { ...constructionSeams },
      );
      const handle = await server.start();
      try {
        strategies.length = 0;
        assert.equal(await post(handle.port, 's-a'), 200);
        assert.equal(await post(handle.port, 's-b'), 200);
        assert.ok(strategies.length >= 2);
        assert.equal(
          new Set(strategies).size,
          strategies.length,
          'a strategy instance was shared between builders',
        );
      } finally {
        await handle.close();
      }
    } finally {
      proto.withLlmCallStrategy = orig;
    }
  });
});
