import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmCallRecord } from '../interfaces/request-logger.js';
import {
  EMBEDDING_CONTEXT_EXCEEDED,
  MODEL_CONTEXT_EXCEEDED,
  SmartAgentError,
} from '../interfaces/types.js';
import { withUsageAttribution } from './error-usage.js';
import { toEmbeddingError, withEmbeddingError } from './rag-error.js';
import {
  contextExceededError,
  overflowError,
  terminalRunError,
  toRunError,
} from './terminal-run-error.js';

const overflow = new SmartAgentError('Prompt too long', MODEL_CONTEXT_EXCEEDED);

test('overflow wins through a deeper cause chain and another terminal wrapper', () => {
  let error: Error = overflow;
  for (const label of [
    'provider',
    'embedder',
    'retriever',
    'tool',
    'adapter',
    'executor',
  ]) {
    error = new Error(label, { cause: error });
  }
  const wrapped = Object.assign(
    new SmartAgentError('Wrapped transport failure', 'LLM_HTTP_ERROR'),
    { cause: error },
  );
  assert.equal(contextExceededError(wrapped), overflow);
  assert.equal(terminalRunError(wrapped), overflow);
});

test('context overflow detection terminates on a cycle and leaves other terminal codes alone', () => {
  const ordinary = new SmartAgentError('Aborted', 'ABORTED');
  Object.assign(ordinary, { cause: ordinary });
  assert.equal(contextExceededError(ordinary), undefined);
  assert.equal(terminalRunError(ordinary), ordinary);
});

test('normalizes SDK embedding size errors with a status and original cause', () => {
  const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
  const usageCalls: LlmCallRecord[] = [
    {
      callId: 'embed',
      component: 'embedding',
      model: 'test',
      durationMs: 1,
      ...usage,
    },
  ];
  const error = Object.assign(
    new Error('Request failed with status code 400'),
    {
      response: {
        status: 400,
        data: { error: { code: 'context_length_exceeded' } },
      },
      usage,
      usageCalls,
    },
  );
  const failure = toEmbeddingError(error);
  assert.ok(failure);
  assert.equal(failure.code, EMBEDDING_CONTEXT_EXCEEDED);
  assert.equal(failure.status, 400);
  assert.equal(failure.cause, error);
  assert.equal(failure.usage, usage);
  assert.equal(failure.usageCalls, usageCalls);
  assert.equal(
    terminalRunError(new Error('RAG wrapper', { cause: failure })),
    failure,
  );
});

test('normalization recognizes abort reasons through wrappers and telemetry copies', () => {
  const reason = new Error('Cancelled', { cause: overflow });
  const signal = AbortSignal.abort(reason);
  const usage = { promptTokens: 3, completionTokens: 0, totalTokens: 3 };
  const error = new Error('Wrapper', {
    cause: withUsageAttribution(reason, { usage }),
  });
  assert.equal(overflowError(error, signal), undefined);
  const normalized = toRunError(error, 'FALLBACK', signal);
  assert.equal(normalized.code, 'ABORTED');
  assert.equal(normalized.message, reason.message);
  assert.equal(normalized.usage, usage);
});

test('cancellation takes precedence over a nested overflow without a signal', () => {
  for (const error of [
    Object.assign(new Error('Cancelled', { cause: overflow }), {
      name: 'AbortError',
    }),
    Object.assign(new DOMException('Cancelled', 'AbortError'), {
      cause: overflow,
    }),
    { code: 'ABORTED', cause: overflow, message: 'Cancelled' },
  ]) {
    assert.equal(overflowError(error), undefined);
    assert.equal(toRunError(error, 'FALLBACK').code, 'ABORTED');
  }
});

test('the embedding boundary preserves ordinary rejections and types signal reasons', async () => {
  const usage = { promptTokens: 4, completionTokens: 0, totalTokens: 4 };
  const cause = Object.assign(new Error('Request rejected'), {
    status: 400,
    usage,
  });
  const request = async () => {
    throw cause;
  };
  await assert.rejects(withEmbeddingError(request), (error) => error === cause);
  const signal = AbortSignal.abort(cause);
  await assert.rejects(withEmbeddingError(request, signal), {
    code: 'ABORTED',
    cause,
    usage,
  });
  await assert.rejects(
    withEmbeddingError(request, signal, 'preserve-rejection'),
    (error) => error === cause,
  );
});
