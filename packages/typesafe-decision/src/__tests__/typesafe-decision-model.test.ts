import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import { TypeSafeDecisionModel } from '../typesafe-decision-model.js';
import { fakeFetch, okBody } from './fake-fetch.js';

describe('TypeSafeDecisionModel — request mapping', () => {
  it('posts state, questions and the model to /v1/systemone', async () => {
    const f = fakeFetch(() =>
      okBody({
        a: { type: 'noul', noul: 0.8 },
        b: {
          type: 'choice',
          choice: 'x',
          confidence: 0.9,
          probabilities: { x: 0.9, y: 0.1 },
        },
        c: {
          type: 'score',
          score: 1.5,
          confidence: 0.7,
          legend: { 0: 'lo', 1: 'mid', 2: 'hi' },
          probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 },
        },
      }),
    );
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    const r = await m.decide({
      state: { text: 'hello' },
      questions: {
        a: { type: 'noul', instructions: 'yes?' },
        b: { type: 'choice', criteria: { x: 'X', y: null } },
        c: { type: 'score', criteria: ['lo', 'mid', 'hi'] },
      },
    });
    assert.ok(r.ok, r.ok ? '' : r.error.message);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.deepEqual(f.calls[0].body.state, { text: 'hello' });
    assert.equal(f.calls[0].body.model, 'jev-latest');
    assert.deepEqual(f.calls[0].body.questions, {
      a: { type: 'noul', instructions: 'yes?' },
      b: { type: 'choice', criteria: { x: 'X', y: null } },
      c: { type: 'score', criteria: ['lo', 'mid', 'hi'] },
    });
  });

  it('uses the configured model and base URL', async () => {
    const f = fakeFetch(() => okBody({ a: { type: 'noul', noul: 0.1 } }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      model: 'jev-1.13.0',
      baseUrl: 'https://proxy.example/typesafe/',
      fetch: f.fetch,
    });
    await m.decide({ state: 's', questions: { a: { type: 'noul' } } });
    assert.equal(f.calls[0].url, 'https://proxy.example/typesafe/v1/systemone');
    assert.equal(f.calls[0].body.model, 'jev-1.13.0');
    assert.equal(m.model, 'jev-1.13.0');
  });
});

describe('TypeSafeDecisionModel — response mapping', () => {
  it('renames noul to probability, drops legend, numeric score keys, camelCase usage', async () => {
    const f = fakeFetch(() =>
      okBody({
        a: { type: 'noul', noul: 0.8 },
        c: {
          type: 'score',
          score: 1.5,
          confidence: 0.7,
          legend: { 0: 'lo', 1: 'mid', 2: 'hi' },
          probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 },
        },
      }),
    );
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    const r = await m.decide({
      state: 's',
      questions: {
        a: { type: 'noul' },
        c: { type: 'score', criteria: ['lo', 'mid', 'hi'] },
      },
    });
    assert.ok(r.ok);
    assert.deepEqual(r.value.answers.a, { type: 'noul', probability: 0.8 });
    assert.deepEqual(r.value.answers.c, {
      type: 'score',
      score: 1.5,
      confidence: 0.7,
      probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 },
    });
    assert.deepEqual(Object.keys(r.value.answers.c), [
      'type',
      'score',
      'confidence',
      'probabilities',
    ]);
    assert.equal(r.value.model, 'jev-1.13.0');
    assert.deepEqual(r.value.usage, { inputTokens: 12, outputTokens: 3 });
  });

  it('a missing answer is DECISION_ERROR, never a partial result', async () => {
    const f = fakeFetch(() => okBody({ a: { type: 'noul', noul: 0.8 } }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    const r = await m.decide({
      state: 's',
      questions: { a: { type: 'noul' }, b: { type: 'noul' } },
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_ERROR');
    assert.match(r.error.message, /'b'/);
  });

  it('an answer of the wrong type is DECISION_ERROR', async () => {
    const f = fakeFetch(() =>
      okBody({
        a: {
          type: 'choice',
          choice: 'x',
          confidence: 1,
          probabilities: { x: 1 },
        },
      }),
    );
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    const r = await m.decide({
      state: 's',
      questions: { a: { type: 'noul' } },
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'DECISION_ERROR');
  });
});

describe('TypeSafeDecisionModel — unset is not sent', () => {
  it('does not pass timeout or retry when they are unset', async () => {
    // With the SDK default (2 retries), a 500 is attempted 3 times.
    const f = fakeFetch(() => ({ status: 500, body: { error: 'x' } }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    await m.decide({ state: 's', questions: { a: { type: 'noul' } } });
    assert.equal(f.calls.length, 3);
  });

  it('maxRetries: 0 is a value, not "unset"', async () => {
    const f = fakeFetch(() => ({ status: 500, body: { error: 'x' } }));
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      maxRetries: 0,
      fetch: f.fetch,
    });
    await m.decide({ state: 's', questions: { a: { type: 'noul' } } });
    assert.equal(f.calls.length, 1);
  });
});

describe('TypeSafeDecisionModel — question keys are data, not prototype slots', () => {
  it('a question named __proto__ reaches the request and its answer is mapped', async () => {
    const f = fakeFetch(() =>
      okBody(
        JSON.parse(
          '{"__proto__":{"type":"noul","noul":0.4},"normal":{"type":"noul","noul":0.6}}',
        ),
      ),
    );
    const m = new TypeSafeDecisionModel({
      credential: staticApiKey('k'),
      fetch: f.fetch,
    });
    const questions = Object.fromEntries([
      ['__proto__', { type: 'noul' as const }],
      ['normal', { type: 'noul' as const }],
    ]);
    const r = await m.decide({ state: 's', questions });
    assert.deepEqual(Object.keys(f.calls[0].body.questions as object).sort(), [
      '__proto__',
      'normal',
    ]);
    assert.ok(r.ok, r.ok ? '' : r.error.message);
    assert.deepEqual(Object.keys(r.value.answers).sort(), [
      '__proto__',
      'normal',
    ]);
    assert.equal(
      Object.getOwnPropertyDescriptor(r.value.answers, '__proto__')?.value
        .probability,
      0.4,
    );
  });
});
