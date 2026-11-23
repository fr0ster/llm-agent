import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmError, MODEL_CONTEXT_EXCEEDED } from '@mcp-abap-adt/llm-agent';
import { streamWithContextOverflow } from './response-helpers.js';

test('HTTP streams deliver rejected overflow to the response formatter as a terminal chunk', async () => {
  const overflow = new LlmError('Prompt too long', MODEL_CONTEXT_EXCEEDED);
  async function* source() {
    yield await Promise.reject(new Error('Agent failure', { cause: overflow }));
  }
  const chunks = [];
  for await (const chunk of streamWithContextOverflow(source()))
    chunks.push(chunk);
  assert.deepEqual(chunks, [{ ok: false, error: overflow }]);
});
