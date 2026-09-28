import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SmartServerConfig } from '@mcp-abap-adt/llm-agent-server-libs';
import { roleLlmConfigs } from './roles.js';

const knobs = async (llm: unknown) =>
  (await roleLlmConfigs(llm as SmartServerConfig['llm'])).map(
    ({ role, cfg }) => [role, cfg.model, cfg.temperature, cfg.maxTokens],
  );

describe('roleLlmConfigs', () => {
  it('carries each role temperature and maxTokens as the server sends them', async () => {
    assert.deepEqual(
      await knobs({
        main: {
          provider: 'sap-ai-sdk',
          model: 'gpt-5',
          temperature: 0.7,
          classifierTemperature: 0.1,
          maxTokens: 1000,
        },
      }),
      [
        ['main', 'gpt-5', 0.7, 1000],
        ['classifier', 'gpt-5', 0.1, 1000],
      ],
    );
  });

  it('builds a declared classifier and helper as written', async () => {
    assert.deepEqual(
      await knobs({
        main: { provider: 'sap-ai-sdk', model: 'a' },
        classifier: { provider: 'sap-ai-sdk', model: 'c', temperature: 0.2 },
        helper: { provider: 'sap-ai-sdk', model: 'h', maxTokens: 50 },
      }),
      [
        ['main', 'a', undefined, undefined],
        ['classifier', 'c', 0.2, undefined],
        ['helper', 'h', undefined, 50],
      ],
    );
  });

  it('adds a named entry as written', async () => {
    assert.deepEqual(
      await knobs({
        main: { provider: 'sap-ai-sdk', model: 'a' },
        reviewer: { provider: 'sap-ai-sdk', model: 'r', temperature: 1 },
      }),
      [
        ['main', 'a', undefined, undefined],
        ['classifier', 'a', undefined, undefined],
        ['reviewer', 'r', 1, undefined],
      ],
    );
  });

  it('reads a flat llm: block as main', async () => {
    assert.deepEqual(
      await knobs({ provider: 'sap-ai-sdk', model: 'gpt-4o', temperature: 0 }),
      [
        ['main', 'gpt-4o', 0, undefined],
        ['classifier', 'gpt-4o', undefined, undefined],
      ],
    );
  });
});
