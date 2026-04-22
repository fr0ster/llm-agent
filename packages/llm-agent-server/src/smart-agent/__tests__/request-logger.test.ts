import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DefaultRequestLogger } from '../logger/default-request-logger.js';

describe('DefaultRequestLogger', () => {
  it('aggregates byComponent and byCategory for request-scoped calls', () => {
    const logger = new DefaultRequestLogger();
    logger.startRequest();
    logger.logLlmCall({
      component: 'classifier',
      model: 'gpt-4o',
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      durationMs: 50,
    });
    logger.logLlmCall({
      component: 'tool-loop',
      model: 'gpt-4o',
      promptTokens: 500,
      completionTokens: 100,
      totalTokens: 600,
      durationMs: 200,
    });
    logger.endRequest();

    const summary = logger.getSummary();
    assert.equal(summary.byComponent.classifier?.promptTokens, 100);
    assert.equal(summary.byComponent['tool-loop']?.promptTokens, 500);
    assert.equal(summary.byCategory.auxiliary?.promptTokens, 100);
    assert.equal(summary.byCategory.request?.promptTokens, 500);
    assert.equal(summary.byModel['gpt-4o']?.requests, 2);
  });

  it('preserves initialization calls across startRequest resets', () => {
    const logger = new DefaultRequestLogger();

    // Simulate startup embedding
    logger.logLlmCall({
      component: 'embedding',
      model: 'text-embedding-3-small',
      promptTokens: 1000,
      completionTokens: 0,
      totalTokens: 1000,
      durationMs: 300,
      estimated: true,
      scope: 'initialization',
      detail: 'tools',
    });

    // First request — startRequest should NOT clear init calls
    logger.startRequest();
    logger.logLlmCall({
      component: 'tool-loop',
      model: 'gpt-4o',
      promptTokens: 500,
      completionTokens: 100,
      totalTokens: 600,
      durationMs: 200,
    });
    logger.endRequest();

    const summary1 = logger.getSummary();
    assert.equal(summary1.byCategory.initialization?.totalTokens, 1000);
    assert.equal(summary1.byCategory.request?.totalTokens, 600);
    assert.equal(summary1.byComponent.embedding?.requests, 1);
    assert.equal(summary1.byComponent['tool-loop']?.requests, 1);

    // Second request — init data still present, request data reset
    logger.startRequest();
    logger.logLlmCall({
      component: 'tool-loop',
      model: 'gpt-4o',
      promptTokens: 300,
      completionTokens: 50,
      totalTokens: 350,
      durationMs: 100,
    });
    logger.endRequest();

    const summary2 = logger.getSummary();
    assert.equal(summary2.byCategory.initialization?.totalTokens, 1000);
    assert.equal(summary2.byCategory.request?.totalTokens, 350);
    assert.equal(summary2.byComponent['tool-loop']?.requests, 1);
  });

  it('routes runtime embedding to request scope when scope is not initialization', () => {
    const logger = new DefaultRequestLogger();
    logger.startRequest();
    logger.logLlmCall({
      component: 'embedding',
      model: 'text-embedding-3-small',
      promptTokens: 50,
      completionTokens: 0,
      totalTokens: 50,
      durationMs: 10,
      scope: 'request',
    });
    logger.endRequest();

    const summary = logger.getSummary();
    assert.equal(summary.byComponent.embedding?.totalTokens, 50);

    // After reset, runtime embedding should be cleared
    logger.startRequest();
    logger.endRequest();
    const summary2 = logger.getSummary();
    assert.equal(summary2.byComponent.embedding, undefined);
  });

  it('returns empty byCategory when no calls logged', () => {
    const logger = new DefaultRequestLogger();
    logger.startRequest();
    logger.endRequest();
    const summary = logger.getSummary();
    assert.deepEqual(summary.byCategory, {});
    assert.deepEqual(summary.byComponent, {});
    assert.deepEqual(summary.byModel, {});
  });
});
