import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FieldCheck } from '../config-fields.js';
import { resolveLlmSection } from '../resolve-config-sections.js';

describe('resolveLlmSection — temperatures', () => {
  it('leaves an unset temperature unset instead of defaulting it', () => {
    const llm = resolveLlmSection(
      {
        llm: { provider: 'sap-ai-sdk', model: 'gpt-5' },
      },
      new FieldCheck(),
    ) as { temperature?: number; classifierTemperature?: number };
    assert.equal(llm.temperature, undefined);
    assert.equal(llm.classifierTemperature, undefined);
  });

  it('keeps a configured temperature, 0 included', () => {
    const llm = resolveLlmSection(
      {
        llm: {
          provider: 'sap-ai-sdk',
          model: 'gpt-4o',
          temperature: 0,
          classifierTemperature: '0.2',
        },
      },
      new FieldCheck(),
    ) as { temperature?: number; classifierTemperature?: number };
    assert.equal(llm.temperature, 0);
    assert.equal(llm.classifierTemperature, 0.2);
  });
});

describe('resolveLlmSection — resourceGroup', () => {
  it('keeps a flat llm.resourceGroup', () => {
    const llm = resolveLlmSection(
      {
        llm: { provider: 'sap-ai-sdk', model: 'gpt-4o', resourceGroup: 'rg-1' },
      },
      new FieldCheck(),
    ) as { resourceGroup?: string };
    assert.equal(llm.resourceGroup, 'rg-1');
  });

  it('keeps a map entry resourceGroup', () => {
    const llm = resolveLlmSection(
      {
        llm: {
          main: {
            provider: 'sap-ai-sdk',
            model: 'gpt-4o',
            resourceGroup: 'rg-2',
          },
        },
      },
      new FieldCheck(),
    ) as { main: { resourceGroup?: string } };
    assert.equal(llm.main.resourceGroup, 'rg-2');
  });
});
