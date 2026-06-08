import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmComponent } from '@mcp-abap-adt/llm-agent';
import { CATEGORY_MAP } from '../default-request-logger.js';

test("LlmComponent includes 'executor' mapped to 'request'", () => {
  const c: LlmComponent = 'executor';
  assert.equal(CATEGORY_MAP[c], 'request');
});
