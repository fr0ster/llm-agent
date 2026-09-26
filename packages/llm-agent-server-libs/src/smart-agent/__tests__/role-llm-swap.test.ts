import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import type { IEmbedder, ILlm, IModelResolver } from '@mcp-abap-adt/llm-agent';
import { SessionRequestLogger } from '@mcp-abap-adt/llm-agent-libs';
import { makeLlm as makeTestLlm } from '@mcp-abap-adt/llm-agent-libs/testing';
import { SmartServer, type SmartServerConfig } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

function put(port: number, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(text),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

type Ctx = {
  resolveLlm(role: string): Promise<ILlm>;
  resolveNamedLlm(key: string): Promise<ILlm>;
};

test('PUT /v1/config swaps main and classifier for the next lookup, strict or default', async () => {
  const mk = (model: string) =>
    ({ ...makeTestLlm([{ content: 'ok' }]), model }) as ILlm;
  const swapped = mk('m-swapped');
  const swappedClassifier = mk('m-classifier-swapped');
  const modelResolver: IModelResolver = {
    resolve: async (name) => {
      if (name === 'm-swapped') return swapped;
      if (name === 'm-classifier-swapped') return swappedClassifier;
      throw new Error(`unknown model ${name}`);
    },
  };
  const built: string[] = [];
  const server = new SmartServer(
    {
      port: 0,
      skipModelValidation: true,
      modelResolver,
      llm: {
        main: { provider: 'openai', model: 'm-main' },
        classifier: { provider: 'openai', model: 'm-classifier' },
        reviewer: { provider: 'openai', model: 'm-reviewer' },
      },
    } as unknown as SmartServerConfig,
    {
      // B9's assertConstructionSeams runs in the constructor, so every required seam
      // is named; this test overrides only makeLlm.
      ...constructionSeams,
      makeLlm: async (c) => {
        built.push(c.model ?? '');
        return mk(c.model ?? '');
      },
      embedder: {
        embed: async () => ({ vector: [0] }),
      } as unknown as IEmbedder,
    },
  );
  const handle = await server.start();
  try {
    // A session's context, built BEFORE the swap. Stub the worker registry so the
    // context needs no sub-agents; drain() is what PUT calls on it.
    const s = server as unknown as Record<string, unknown>;
    s._workers = {
      build: async () => new Map(),
      drain: async () => {},
      cache: new Map(),
    };
    const ctx = (await (
      server as unknown as {
        buildServerCtx(scope: unknown): Promise<Record<string, unknown>>;
      }
    ).buildServerCtx({
      sessionId: 's1',
      parts: {
        sessionId: 's1',
        mcpClients: [],
        toolsRag: undefined,
        ragRegistry: {} as never,
        logger: new SessionRequestLogger(),
      },
    })) as Record<string, unknown> & Ctx;

    assert.equal(
      'llmMap' in ctx,
      false,
      'the configs are not handed to a step (§4.6.6)',
    );
    assert.equal('pipelineFallback' in ctx, false);
    assert.equal((await ctx.resolveLlm('main')).model, 'm-main');

    const heldClassifierBefore = await ctx.resolveNamedLlm('classifier');
    assert.equal(
      heldClassifierBefore,
      await ctx.resolveLlm('classifier'),
      'strict and default agree',
    );

    assert.equal(
      await put(handle.port, '/v1/config', {
        models: {
          mainModel: 'm-swapped',
          classifierModel: 'm-classifier-swapped',
        },
      }),
      200,
    );

    assert.equal(
      await ctx.resolveLlm('main'),
      swapped,
      'the next lookup observes the swap',
    );
    assert.equal(
      await ctx.resolveLlm('no-such-entry'),
      swapped,
      'a key with no entry is the held main',
    );
    assert.equal(await ctx.resolveNamedLlm('main'), swapped);
    assert.equal(
      await ctx.resolveNamedLlm('classifier'),
      swappedClassifier,
      'a worker naming the classifier key reaches the instance PUT swapped (§4.6.6)',
    );
    assert.equal(
      built.filter((m) => m === 'm-classifier').length,
      1,
      'a declared llm.classifier builds the held classifier, once — not main at classifierTemperature (§4.6.6)',
    );

    const r1 = await ctx.resolveLlm('reviewer');
    const r2 = await ctx.resolveNamedLlm('reviewer');
    assert.equal(r1, r2);
    assert.equal(
      built.filter((m) => m === 'm-reviewer').length,
      1,
      'built once per key',
    );
    await assert.rejects(() => ctx.resolveNamedLlm('cheep'), /'cheep'/);
  } finally {
    await handle.close();
  }
});
