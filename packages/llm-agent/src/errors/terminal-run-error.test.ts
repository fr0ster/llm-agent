import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMBEDDING_CONTEXT_EXCEEDED,
  MODEL_CONTEXT_EXCEEDED,
  SmartAgentError,
} from '../interfaces/types.js';
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

test('embedding context overflow is terminal without HTTP metadata', () => {
  const embedding = new SmartAgentError(
    'Input exceeds context',
    EMBEDDING_CONTEXT_EXCEEDED,
  );
  const wrapped = new Error('Embedding failed', { cause: embedding });
  assert.equal(terminalRunError(wrapped), embedding);
  assert.equal(contextExceededError(wrapped), undefined);
  assert.equal(
    terminalRunError(new Error('Prompt overflow', { cause: overflow })),
    overflow,
  );
});

test('context overflow detection terminates on a cycle and leaves other terminal codes alone', () => {
  const ordinary = new SmartAgentError('Aborted', 'ABORTED');
  Object.assign(ordinary, { cause: ordinary });
  assert.equal(contextExceededError(ordinary), undefined);
  assert.equal(terminalRunError(ordinary), ordinary);
});
