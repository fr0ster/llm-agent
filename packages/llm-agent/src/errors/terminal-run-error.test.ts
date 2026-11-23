import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
  const wrapped = new SmartAgentError(
    'Wrapped transport failure',
    'LLM_HTTP_ERROR',
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
