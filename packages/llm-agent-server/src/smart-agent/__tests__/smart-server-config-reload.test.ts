/**
 * Fix #14: PUT /v1/config (and hot-reload) must invalidate per-session
 * SmartAgent graphs + the worker-LLM cache so the next request observes
 * the just-applied config. Without this, chat routes dispatch to
 * `graph.agent` (the per-session SmartAgent) which was built with the
 * OLD config — the PUT is a no-op for existing sessions, and even fresh
 * cookies whose worker LLMs got cached during the original build keep
 * pointing at the stale instances.
 *
 * We exercise the public PUT /v1/config endpoint (real HTTP), then poke
 * the private `_workerLlmCache` and `_lifecycle.registry` via a typed
 * cast to confirm the invalidation actually fired.
 */

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import type { ILlm, IModelResolver } from '@mcp-abap-adt/llm-agent';
import { makeLlm as makeTestLlm } from '@mcp-abap-adt/llm-agent-libs/testing';
import { SmartServer } from '../smart-server.js';

interface ServerInternals {
  _workerLlmCache: Map<string, unknown>;
  _lifecycle?: { registry: { size: number } };
  _mainLlm?: ILlm;
  cfg: {
    agent?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
  };
}

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  cookieHeader?: string,
): Promise<{
  status: number;
  body: unknown;
  setCookie?: string | string[];
}> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
    };
    if (bodyStr !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    if (cookieHeader) headers.Cookie = cookieHeader;
    const req = request(
      { host: '127.0.0.1', port, method, path, headers },
      (res) => {
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
          resolve({
            status: res.statusCode ?? 0,
            body: parsed,
            setCookie: res.headers['set-cookie'],
          });
        });
      },
    );
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

describe('PUT /v1/config — invalidates session graphs + worker cache (Fix #14)', () => {
  it('clears _workerLlmCache and disposes session graphs after agent update', async () => {
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      agent: { maxIterations: 10 },
    });
    const handle = await server.start();
    const internals = server as unknown as ServerInternals;
    try {
      // Seed the worker-LLM cache so we can observe it getting cleared.
      // (The PUT path's clear is unconditional — we don't actually need a
      // session built first; checking cache.size === 0 after the PUT is
      // enough on its own. We seed it manually to make the regression
      // bite if the clear line is removed.)
      internals._workerLlmCache.set('seed', {});
      assert.equal(
        internals._workerLlmCache.size,
        1,
        'precondition: cache seeded',
      );

      // Acquire a session graph so the registry has at least one live entry
      // we can observe being disposed by the invalidate.
      const usage = await httpRequest(handle.port, 'GET', '/v1/usage');
      assert.equal(usage.status, 200);
      assert.ok(
        (internals._lifecycle?.registry.size ?? 0) >= 1,
        'precondition: at least one session graph live',
      );

      // PUT /v1/config — agent field only (no model resolver wired).
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        agent: { maxIterations: 25 },
      });
      assert.equal(res.status, 200);

      // Post-condition: worker cache cleared AND session graphs gone.
      assert.equal(
        internals._workerLlmCache.size,
        0,
        '_workerLlmCache cleared',
      );
      assert.equal(
        internals._lifecycle?.registry.size,
        0,
        'session registry drained',
      );
    } finally {
      await handle.close();
    }
  });

  it('updates _mainLlm and invalidates when models change', async () => {
    const newMain = { ...makeTestLlm([{ content: 'ok' }]), model: 'gpt-4o' };
    const resolver: IModelResolver = {
      async resolve(name: string): Promise<ILlm> {
        if (name === 'gpt-4o') return newMain;
        throw new Error(`Unknown model: ${name}`);
      },
    };
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      modelResolver: resolver,
    });
    const handle = await server.start();
    const internals = server as unknown as ServerInternals;
    try {
      const originalMain = internals._mainLlm;
      assert.ok(originalMain, 'precondition: _mainLlm captured at start');

      internals._workerLlmCache.set('seed', {});
      // Build a session so we can verify invalidation.
      await httpRequest(handle.port, 'GET', '/v1/usage');
      assert.ok((internals._lifecycle?.registry.size ?? 0) >= 1);

      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        models: { mainModel: 'gpt-4o' },
      });
      assert.equal(res.status, 200);

      assert.equal(internals._mainLlm, newMain, '_mainLlm swapped');
      assert.equal(internals._workerLlmCache.size, 0, 'worker cache cleared');
      assert.equal(
        internals._lifecycle?.registry.size,
        0,
        'session registry drained',
      );
    } finally {
      await handle.close();
    }
  });

  it('Fix #17: PUT /v1/config patches this.cfg.agent so next buildSessionAgent sees the update', async () => {
    const server = new SmartServer({
      port: 0,
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      agent: { maxIterations: 10, maxToolCalls: 5 },
    });
    const handle = await server.start();
    const internals = server as unknown as ServerInternals;
    try {
      assert.equal(internals.cfg.agent?.maxIterations, 10);
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        agent: { maxIterations: 25 },
      });
      assert.equal(res.status, 200);
      // The PUT must deep-merge into this.cfg.agent so a freshly-built session
      // graph reads the updated value, not the startup value.
      assert.equal(
        internals.cfg.agent?.maxIterations,
        25,
        'this.cfg.agent.maxIterations updated',
      );
      // Deep-merge: untouched fields preserved.
      assert.equal(
        internals.cfg.agent?.maxToolCalls,
        5,
        'untouched agent fields preserved (deep-merge, not replace)',
      );
    } finally {
      await handle.close();
    }
  });
});
