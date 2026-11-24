import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMBEDDING_CONTEXT_EXCEEDED,
  MODEL_CONTEXT_EXCEEDED,
  SmartAgentError,
} from '../interfaces/types.js';
import { toEmbeddingError } from './rag-error.js';
import {
  contextExceededError,
  terminalRunError,
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
  const error = Object.assign(
    new Error('Request failed with status code 400'),
    {
      response: {
        status: 400,
        data: { error: { code: 'context_length_exceeded' } },
      },
    },
  );
  const failure = toEmbeddingError(error);
  assert.equal(failure.code, EMBEDDING_CONTEXT_EXCEEDED);
  assert.equal(failure.status, 400);
  assert.equal(failure.cause, error);
  assert.equal(
    terminalRunError(new Error('RAG wrapper', { cause: failure })),
    failure,
  );
});
