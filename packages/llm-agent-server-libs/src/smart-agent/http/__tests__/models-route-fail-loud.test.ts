/**
 * Spec §10.5.6 L7 — a model provider that fails to list its models is an
 * error: `GET /v1/models` and `GET /v1/embedding-models` answer 502 with
 * `jsonError` carrying the provider's code, never 200 with a placeholder / [].
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmError } from '@mcp-abap-adt/llm-agent';
import {
  handleEmbeddingModelsList,
  handleModelsList,
} from '../models-route-handler.js';
import type { RouteContext } from '../route-table.js';

function rcWith(modelProvider: unknown) {
  const reply: { status?: number; body?: string } = {};
  const rc = {
    rawUrl: '/v1/models',
    modelProvider,
    res: {
      writeHead(status: number) {
        reply.status = status;
      },
      end(text?: string) {
        reply.body = text;
      },
    },
  } as unknown as RouteContext;
  return { rc, reply };
}

const failed = {
  ok: false as const,
  error: new LlmError('provider down', 'LLM_HTTP_503'),
};

describe('L7: the models routes fail loud', () => {
  it('getModels ok:false → 502 jsonError with the code', async () => {
    const { rc, reply } = rcWith({ getModels: async () => failed });
    await handleModelsList(rc);
    assert.equal(reply.status, 502);
    const body = JSON.parse(reply.body ?? '{}');
    assert.match(body.error.message, /provider down/);
    assert.equal(body.error.type, 'api_error');
    assert.equal(body.error.code, 'LLM_HTTP_503');
    assert.equal(body.data, undefined, 'no placeholder list');
  });

  it('getEmbeddingModels ok:false → 502 jsonError with the code', async () => {
    const { rc, reply } = rcWith({
      getModels: async () => ({ ok: true, value: [] }),
      getEmbeddingModels: async () => failed,
    });
    await handleEmbeddingModelsList(rc);
    assert.equal(reply.status, 502);
    const body = JSON.parse(reply.body ?? '{}');
    assert.match(body.error.message, /provider down/);
    assert.equal(body.error.type, 'api_error');
    assert.equal(body.error.code, 'LLM_HTTP_503');
  });

  it('getModels rejecting → 502 jsonError with its code', async () => {
    const { rc, reply } = rcWith({
      getModels: async () => {
        throw new LlmError('socket hang up', 'LLM_TRANSPORT');
      },
    });
    await handleModelsList(rc);
    assert.equal(reply.status, 502);
    const body = JSON.parse(reply.body ?? '{}');
    assert.match(body.error.message, /socket hang up/);
    assert.equal(body.error.type, 'api_error');
    assert.equal(body.error.code, 'LLM_TRANSPORT');
  });

  it('getEmbeddingModels rejecting (a plain Error) → 502 jsonError', async () => {
    const { rc, reply } = rcWith({
      getModels: async () => ({ ok: true, value: [] }),
      getEmbeddingModels: async () => {
        throw new Error('boom');
      },
    });
    await handleEmbeddingModelsList(rc);
    assert.equal(reply.status, 502);
    const body = JSON.parse(reply.body ?? '{}');
    assert.match(body.error.message, /boom/);
    assert.equal(body.error.type, 'api_error');
  });

  it('a successful listing still answers 200 with the models', async () => {
    const { rc, reply } = rcWith({
      getModels: async () => ({ ok: true, value: [{ id: 'gpt-x' }] }),
    });
    await handleModelsList(rc);
    assert.equal(reply.status, 200);
    const body = JSON.parse(reply.body ?? '{}');
    assert.deepEqual(
      body.data.map((m: { id: string }) => m.id),
      ['gpt-x'],
    );
  });
});
