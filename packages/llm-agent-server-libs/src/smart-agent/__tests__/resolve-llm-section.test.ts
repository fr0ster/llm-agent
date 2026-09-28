import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { optionalNumber } from '../llm-config-map.js';
import { resolveLlmSection } from '../resolve-config-sections.js';

describe('resolveLlmSection — temperatures', () => {
  it('leaves an unset temperature unset instead of defaulting it', () => {
    const llm = resolveLlmSection({
      llm: { provider: 'sap-ai-sdk', model: 'gpt-5' },
    }) as { temperature?: number; classifierTemperature?: number };
    assert.equal(llm.temperature, undefined);
    assert.equal(llm.classifierTemperature, undefined);
  });

  it('keeps a configured temperature, 0 included', () => {
    const llm = resolveLlmSection({
      llm: {
        provider: 'sap-ai-sdk',
        model: 'gpt-4o',
        temperature: 0,
        classifierTemperature: '0.2',
      },
    }) as { temperature?: number; classifierTemperature?: number };
    assert.equal(llm.temperature, 0);
    assert.equal(llm.classifierTemperature, 0.2);
  });
});

describe('optionalNumber', () => {
  it('maps unset to undefined and anything else to a number', () => {
    assert.equal(optionalNumber(undefined), undefined);
    assert.equal(optionalNumber(null), undefined);
    assert.equal(optionalNumber('0.5'), 0.5);
    assert.equal(optionalNumber(0), 0);
  });
});

describe('resolveLlmSection — resourceGroup', () => {
  it('keeps a flat llm.resourceGroup', () => {
    const llm = resolveLlmSection({
      llm: { provider: 'sap-ai-sdk', model: 'gpt-4o', resourceGroup: 'rg-1' },
    }) as { resourceGroup?: string };
    assert.equal(llm.resourceGroup, 'rg-1');
  });

  it('keeps a map entry resourceGroup', () => {
    const llm = resolveLlmSection({
      llm: {
        main: {
          provider: 'sap-ai-sdk',
          model: 'gpt-4o',
          resourceGroup: 'rg-2',
        },
      },
    }) as { main: { resourceGroup?: string } };
    assert.equal(llm.main.resourceGroup, 'rg-2');
  });
});
