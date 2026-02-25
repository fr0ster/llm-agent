import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '../../../types.js';
import type { ILlm } from '../../interfaces/llm.js';
import {
  LlmError,
  type LlmResponse,
  type Result,
} from '../../interfaces/types.js';
import { LlmClassifier } from '../llm-classifier.js';

// ---------------------------------------------------------------------------
// Stub ILlm
//
// The new LlmClassifier makes TWO parallel calls per classify():
//   Call 1 (stores): expects {"stores":[...]}
//   Call 2 (actions): expects {"actions":[...]}
// We use a queue so each call gets its own canned response.
// ---------------------------------------------------------------------------

function makeLlm(
  responses: Array<string | Error>,
): ILlm & { callCount: number } {
  let callCount = 0;
  const queue = [...responses];
  return {
    get callCount() {
      return callCount;
    },
    async chat(_messages: Message[]): Promise<Result<LlmResponse, LlmError>> {
      callCount++;
      const next = queue.shift() ?? '{"stores":[],"actions":[]}';
      if (next instanceof Error) {
        return { ok: false, error: new LlmError(next.message) };
      }
      return { ok: true, value: { content: next, finishReason: 'stop' } };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — happy path
// ---------------------------------------------------------------------------

describe('LlmClassifier — action intent', () => {
  it('returns ClassifierResult with one action node', async () => {
    const llm = makeLlm([
      '{"stores":[]}',
      '{"actions":[{"id":0,"text":"What is the capital of France?","dependsOn":[]}]}',
    ]);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('What is the capital of France?');
    assert.ok(r.ok);
    assert.deepEqual(r.value.stores, []);
    assert.equal(r.value.actions.length, 1);
    assert.equal(r.value.actions[0].type, undefined); // ActionNode has no type field
    assert.equal(r.value.actions[0].text, 'What is the capital of France?');
    assert.deepEqual(r.value.actions[0].dependsOn, []);
  });
});

describe('LlmClassifier — fact intent', () => {
  it('returns ClassifierResult with one store entry', async () => {
    const llm = makeLlm([
      '{"stores":[{"type":"fact","text":"The sky is blue."}]}',
      '{"actions":[]}',
    ]);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('The sky is blue.');
    assert.ok(r.ok);
    assert.equal(r.value.stores.length, 1);
    assert.equal(r.value.stores[0].type, 'fact');
    assert.equal(r.value.stores[0].text, 'The sky is blue.');
    assert.deepEqual(r.value.actions, []);
  });
});

describe('LlmClassifier — feedback intent', () => {
  it('returns ClassifierResult with one feedback store entry', async () => {
    const llm = makeLlm([
      '{"stores":[{"type":"feedback","text":"Your last answer was wrong."}]}',
      '{"actions":[]}',
    ]);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('Your last answer was wrong.');
    assert.ok(r.ok);
    assert.equal(r.value.stores[0].type, 'feedback');
  });
});

describe('LlmClassifier — state intent', () => {
  it('returns ClassifierResult with one state store entry', async () => {
    const llm = makeLlm([
      '{"stores":[{"type":"state","text":"I prefer dark mode."}]}',
      '{"actions":[]}',
    ]);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('I prefer dark mode.');
    assert.ok(r.ok);
    assert.equal(r.value.stores[0].type, 'state');
  });
});

describe('LlmClassifier — mixed intent', () => {
  it('returns both store and action entries', async () => {
    const llm = makeLlm([
      '{"stores":[{"type":"fact","text":"Earth is round."}]}',
      '{"actions":[{"id":0,"text":"Tell me about gravity.","dependsOn":[]}]}',
    ]);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('Earth is round. Tell me about gravity.');
    assert.ok(r.ok);
    assert.equal(r.value.stores.length, 1);
    assert.equal(r.value.stores[0].type, 'fact');
    assert.equal(r.value.actions.length, 1);
    assert.equal(r.value.actions[0].text, 'Tell me about gravity.');
  });
});

describe('LlmClassifier — empty result', () => {
  it('ok with empty stores and actions', async () => {
    const llm = makeLlm(['{"stores":[]}', '{"actions":[]}']);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('');
    assert.ok(r.ok);
    assert.deepEqual(r.value.stores, []);
    assert.deepEqual(r.value.actions, []);
  });
});

describe('LlmClassifier — dependency graph', () => {
  it('two actions with dependency', async () => {
    const llm = makeLlm([
      '{"stores":[]}',
      '{"actions":[{"id":0,"text":"Add 9 to 5.","dependsOn":[]},{"id":1,"text":"Read T100.","dependsOn":[0]}]}',
    ]);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('Add 9 to 5. Then read T100.');
    assert.ok(r.ok);
    assert.equal(r.value.actions.length, 2);
    assert.deepEqual(r.value.actions[0].dependsOn, []);
    assert.deepEqual(r.value.actions[1].dependsOn, [0]);
  });
});

// ---------------------------------------------------------------------------
// Code fence stripping
// ---------------------------------------------------------------------------

describe('LlmClassifier — code fence stripping', () => {
  it('JSON wrapped in ```json...``` is parsed correctly', async () => {
    const llm = makeLlm([
      '```json\n{"stores":[]}\n```',
      '```json\n{"actions":[{"id":0,"text":"Do something.","dependsOn":[]}]}\n```',
    ]);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('Do something.');
    assert.ok(r.ok);
    assert.equal(r.value.actions[0].text, 'Do something.');
  });
});

// ---------------------------------------------------------------------------
// Parse / schema errors
// ---------------------------------------------------------------------------

describe('LlmClassifier — parse/schema errors', () => {
  it('non-JSON stores response → PARSE_ERROR', async () => {
    const llm = makeLlm([
      'This is not JSON at all.',
      '{"actions":[]}',
    ]);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'PARSE_ERROR');
  });

  it('stores missing "stores" key → SCHEMA_ERROR', async () => {
    const llm = makeLlm([
      '{"type":"fact","text":"x"}',
      '{"actions":[]}',
    ]);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SCHEMA_ERROR');
  });

  it('invalid store type → SCHEMA_ERROR', async () => {
    const llm = makeLlm([
      '{"stores":[{"type":"unknown","text":"x"}]}',
      '{"actions":[]}',
    ]);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SCHEMA_ERROR');
  });

  it('non-JSON actions response → PARSE_ERROR', async () => {
    const llm = makeLlm([
      '{"stores":[]}',
      'This is not JSON.',
    ]);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'PARSE_ERROR');
  });

  it('actions missing "actions" key → SCHEMA_ERROR', async () => {
    const llm = makeLlm([
      '{"stores":[]}',
      '[{"id":0,"text":"x","dependsOn":[]}]',
    ]);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SCHEMA_ERROR');
  });

  it('action missing id field → SCHEMA_ERROR', async () => {
    const llm = makeLlm([
      '{"stores":[]}',
      '{"actions":[{"text":"x","dependsOn":[]}]}',
    ]);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SCHEMA_ERROR');
  });
});

// ---------------------------------------------------------------------------
// LLM errors
// ---------------------------------------------------------------------------

describe('LlmClassifier — LLM errors', () => {
  it('stores LLM error → ClassifierError with LLM_ERROR code', async () => {
    const llm = makeLlm([
      new Error('Provider unavailable'),
      '{"actions":[]}',
    ]);
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'LLM_ERROR');
    assert.ok(r.error.message.includes('Provider unavailable'));
  });

  it('LLM returns aborted LlmError → ClassifierError ABORTED', async () => {
    const llm: ILlm & { callCount: number } = {
      callCount: 0,
      async chat(): Promise<Result<LlmResponse, LlmError>> {
        return { ok: false, error: new LlmError('Aborted', 'ABORTED') };
      },
    };
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
  });
});

// ---------------------------------------------------------------------------
// AbortSignal
// ---------------------------------------------------------------------------

describe('LlmClassifier — AbortSignal', () => {
  it('pre-aborted signal → ABORTED without calling LLM', async () => {
    const llm = makeLlm(['{"stores":[]}', '{"actions":[]}']);
    const classifier = new LlmClassifier(llm);
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await classifier.classify('anything', { signal: ctrl.signal });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
    assert.equal(llm.callCount, 0);
  });

  it('mid-flight abort — signal fires during LLM call → ABORTED', async () => {
    const ctrl = new AbortController();
    const llm: ILlm & { callCount: number } = {
      callCount: 0,
      async chat(): Promise<Result<LlmResponse, LlmError>> {
        this.callCount++;
        ctrl.abort();
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return { ok: true, value: { content: '{"stores":[]}', finishReason: 'stop' } };
      },
    };
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything', { signal: ctrl.signal });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe('LlmClassifier — cache', () => {
  it('cache enabled (default) — same text called twice → LLM called twice total (2 per call, cached on 2nd)', async () => {
    // Each classify() makes 2 parallel LLM calls; 2nd call is served from cache
    const llm = makeLlm([
      '{"stores":[]}',
      '{"actions":[{"id":0,"text":"test","dependsOn":[]}]}',
    ]);
    const classifier = new LlmClassifier(llm);
    await classifier.classify('identical input');
    await classifier.classify('identical input'); // served from cache
    assert.equal(llm.callCount, 2); // only 2 calls from the first classify()
  });

  it('cache enabled — different texts → LLM called for each (2 per unique text)', async () => {
    const llm = makeLlm([
      '{"stores":[]}',
      '{"actions":[{"id":0,"text":"a","dependsOn":[]}]}',
      '{"stores":[]}',
      '{"actions":[{"id":0,"text":"b","dependsOn":[]}]}',
    ]);
    const classifier = new LlmClassifier(llm);
    await classifier.classify('first input');
    await classifier.classify('second input');
    assert.equal(llm.callCount, 4); // 2 per unique text × 2 texts
  });

  it('cache disabled — same text called twice → LLM called 4 times (2 per call)', async () => {
    const llm = makeLlm([
      '{"stores":[]}',
      '{"actions":[{"id":0,"text":"test","dependsOn":[]}]}',
      '{"stores":[]}',
      '{"actions":[{"id":0,"text":"test","dependsOn":[]}]}',
    ]);
    const classifier = new LlmClassifier(llm, { enableCache: false });
    await classifier.classify('identical input');
    await classifier.classify('identical input');
    assert.equal(llm.callCount, 4);
  });
});
