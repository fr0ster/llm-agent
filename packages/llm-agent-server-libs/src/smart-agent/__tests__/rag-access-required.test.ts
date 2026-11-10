import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAgent, ServerConfigError } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

test('SmartServer fails closed without configured RAG access', async () => {
  await assert.rejects(
    () =>
      buildAgent(
        // @ts-expect-error Deliberately omit the mandatory trusted identity configuration.
        Object.assign(
          {},
          { llm: { model: 'test' }, skipModelValidation: true },
        ),
        constructionSeams,
      ),
    (error: Error) => error instanceof ServerConfigError,
  );
});
