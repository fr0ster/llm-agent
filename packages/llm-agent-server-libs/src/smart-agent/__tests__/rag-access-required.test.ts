import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BuilderConfigError } from '@mcp-abap-adt/llm-agent-libs';
import { buildAgent } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

test('SmartServer fails closed without configured RAG access pending Task 8', async () => {
  await assert.rejects(
    () =>
      buildAgent(
        { llm: { model: 'test' }, skipModelValidation: true },
        constructionSeams,
      ),
    (error: Error) =>
      error instanceof BuilderConfigError &&
      error.message === 'ragAccess is required',
  );
});
