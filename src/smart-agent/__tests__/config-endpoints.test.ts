import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import { SmartAgent } from '../agent.js';
import type { ILlm } from '../interfaces/llm.js';
import type { IModelResolver } from '../interfaces/model-resolver.js';
import { SmartServer } from '../smart-server.js';
import { makeDefaultDeps, makeLlm as makeTestLlm } from '../testing/index.js';

function makeResolver(results: Record<string, ILlm | Error>): IModelResolver {
  return {
    async resolve(modelName: string): Promise<ILlm> {
      const result = results[modelName];
      if (!result) throw new Error(`Unknown model: ${modelName}`);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const options = {
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr !== undefined
          ? { 'Content-Length': Buffer.byteLength(bodyStr) }
          : {}),
      },
    };
    const req = request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, raw: text });
      });
    });
    req.on('error', reject);
    if (bodyStr !== undefined) {
      req.write(bodyStr);
    }
    req.end();
  });
}

describe('SmartAgent.getAgentConfig', () => {
  it('returns only whitelisted fields', () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, {
      maxIterations: 10,
      maxToolCalls: 5,
      ragQueryK: 15,
      toolUnavailableTtlMs: 30_000,
      showReasoning: true,
      historyAutoSummarizeLimit: 20,
      classificationEnabled: true,
      ragRetrievalMode: 'auto',
      ragTranslationEnabled: true,
      ragUpsertEnabled: false,
      // These should NOT appear in the output:
      timeoutMs: 5000,
      tokenLimit: 4096,
      smartAgentEnabled: true,
    });

    const config = agent.getAgentConfig();

    assert.deepEqual(config, {
      maxIterations: 10,
      maxToolCalls: 5,
      ragQueryK: 15,
      toolUnavailableTtlMs: 30_000,
      showReasoning: true,
      historyAutoSummarizeLimit: 20,
      classificationEnabled: true,
      ragRetrievalMode: 'auto',
      ragTranslationEnabled: true,
      ragUpsertEnabled: false,
    });
  });

  it('returns defaults for omitted optional fields', () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, { maxIterations: 5 });

    const config = agent.getAgentConfig();

    assert.equal(config.maxIterations, 5);
    assert.equal(config.maxToolCalls, undefined);
    assert.equal(config.classificationEnabled, undefined);
  });
});

describe('GET /v1/config', () => {
  it('returns models and agent config', async () => {
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      agent: { maxIterations: 8 },
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'GET', '/v1/config');
      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      assert.ok(body.models);
      assert.ok(body.agent);
      const agent = body.agent as Record<string, unknown>;
      assert.equal(agent.maxIterations, 8);
    } finally {
      await handle.close();
    }
  });

  it('works with /config alias', async () => {
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'GET', '/config');
      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      assert.ok(body.models);
    } finally {
      await handle.close();
    }
  });

  it('returns only whitelisted fields, not raw SmartAgentConfig', async () => {
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      agent: { maxIterations: 5, timeoutMs: 9999, tokenLimit: 4096 },
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'GET', '/v1/config');
      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      const agent = body.agent as Record<string, unknown>;
      assert.equal(agent.maxIterations, 5);
      assert.equal(agent.timeoutMs, undefined);
      assert.equal(agent.tokenLimit, undefined);
    } finally {
      await handle.close();
    }
  });
});

describe('PUT /v1/config', () => {
  it('updates agent parameters and returns updated config', async () => {
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      agent: { maxIterations: 10 },
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        agent: { maxIterations: 20, classificationEnabled: false },
      });
      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      const agent = body.agent as Record<string, unknown>;
      assert.equal(agent.maxIterations, 20);
      assert.equal(agent.classificationEnabled, false);
    } finally {
      await handle.close();
    }
  });

  it('rejects unsupported agent fields', async () => {
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        agent: { timeoutMs: 9999 },
      });
      assert.equal(res.status, 400);
    } finally {
      await handle.close();
    }
  });

  it('rejects invalid JSON body', async () => {
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
    });
    const handle = await server.start();
    try {
      // Send raw non-JSON body
      const res = await new Promise<{
        status: number;
        body: unknown;
        raw: string;
      }>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: handle.port,
            method: 'PUT',
            path: '/v1/config',
            headers: { 'Content-Type': 'application/json' },
          },
          (httpRes) => {
            const chunks: Buffer[] = [];
            httpRes.on('data', (c: Buffer) => chunks.push(c));
            httpRes.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              let parsed: unknown;
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = text;
              }
              resolve({
                status: httpRes.statusCode ?? 0,
                body: parsed,
                raw: text,
              });
            });
          },
        );
        req.on('error', reject);
        req.write('not-json');
        req.end();
      });
      assert.equal(res.status, 400);
    } finally {
      await handle.close();
    }
  });

  it('returns 405 for unsupported methods on /v1/config', async () => {
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'DELETE', '/v1/config');
      assert.equal(res.status, 405);
    } finally {
      await handle.close();
    }
  });

  it('works with /config alias for PUT', async () => {
    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      agent: { maxIterations: 10 },
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'PUT', '/config', {
        agent: { maxIterations: 15 },
      });
      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      const agent = body.agent as Record<string, unknown>;
      assert.equal(agent.maxIterations, 15);
    } finally {
      await handle.close();
    }
  });
});

describe('PUT /v1/config — models', () => {
  it('resolves and reconfigures models when resolver is set', async () => {
    const newMain = { ...makeTestLlm([{ content: 'ok' }]), model: 'gpt-4o' };
    const resolver = makeResolver({ 'gpt-4o': newMain });

    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      modelResolver: resolver,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        models: { mainModel: 'gpt-4o' },
      });
      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      const models = body.models as Record<string, unknown>;
      assert.equal(models.mainModel, 'gpt-4o');
    } finally {
      await handle.close();
    }
  });

  it('returns 400 when models sent but no resolver configured', async () => {
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        models: { mainModel: 'gpt-4o' },
      });
      assert.equal(res.status, 400);
      const body = res.body as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      assert.ok(
        String(error.message).includes('model resolver not configured'),
      );
    } finally {
      await handle.close();
    }
  });

  it('returns 500 when model resolution fails', async () => {
    const resolver = makeResolver({
      'bad-model': new Error('Provider unreachable'),
    });

    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      modelResolver: resolver,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        models: { mainModel: 'bad-model' },
      });
      assert.equal(res.status, 500);
    } finally {
      await handle.close();
    }
  });

  it('returns 500 for unknown model name', async () => {
    const resolver: IModelResolver = {
      async resolve(modelName: string): Promise<ILlm> {
        throw new Error(`Unknown model: ${modelName}`);
      },
    };
    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      modelResolver: resolver,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        models: { mainModel: 'nonexistent-model' },
      });
      assert.equal(res.status, 500);
      const body = res.body as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      assert.ok(String(error.message).includes('nonexistent-model'));
    } finally {
      await handle.close();
    }
  });

  it('is atomic — no changes applied when one model resolution fails', async () => {
    const goodLlm = {
      ...makeTestLlm([{ content: 'ok' }]),
      model: 'good-model',
    };
    const resolver = makeResolver({
      'good-model': goodLlm,
      'bad-model': new Error('resolution failed'),
    });

    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      modelResolver: resolver,
      agent: { maxIterations: 10 },
    });
    const handle = await server.start();
    try {
      // Attempt to update both models + agent param — one model fails
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        models: { mainModel: 'good-model', classifierModel: 'bad-model' },
        agent: { maxIterations: 99 },
      });
      assert.equal(res.status, 500);

      // Verify nothing changed
      const getRes = await httpRequest(handle.port, 'GET', '/v1/config');
      const body = getRes.body as Record<string, unknown>;
      const agent = body.agent as Record<string, unknown>;
      assert.equal(agent.maxIterations, 10); // unchanged
    } finally {
      await handle.close();
    }
  });
});
