import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm, Message } from '@mcp-abap-adt/llm-agent';
import {
  LlmError,
  type LlmResponse,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { LlmClassifier } from '../llm-classifier.js';

// ---------------------------------------------------------------------------
// Stub ILlm
// ---------------------------------------------------------------------------

function makeLlm(response: string | Error): ILlm & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async chat(_messages: Message[]): Promise<Result<LlmResponse, LlmError>> {
      callCount++;
      if (response instanceof Error) {
        return {
          ok: false,
          error: new LlmError(response.message),
        };
      }
      return {
        ok: true,
        value: { content: response, finishReason: 'stop' },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LlmClassifier — intent types', () => {
  it('action intent', async () => {
    const llm = makeLlm(
      '[{"type":"action","text":"What is the capital of France?"}]',
    );
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('What is the capital of France?');
    assert.ok(r.ok);
    assert.equal(r.value.length, 1);
    assert.equal(r.value[0].type, 'action');
    assert.equal(r.value[0].text, 'What is the capital of France?');
  });

  it('fact intent', async () => {
    const llm = makeLlm('[{"type":"fact","text":"The sky is blue."}]');
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('The sky is blue.');
    assert.ok(r.ok);
    assert.equal(r.value[0].type, 'fact');
    assert.equal(r.value[0].text, 'The sky is blue.');
  });

  it('feedback intent', async () => {
    const llm = makeLlm(
      '[{"type":"feedback","text":"Your last answer was wrong."}]',
    );
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('Your last answer was wrong.');
    assert.ok(r.ok);
    assert.equal(r.value[0].type, 'feedback');
  });

  it('state intent', async () => {
    const llm = makeLlm('[{"type":"state","text":"I prefer dark mode."}]');
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('I prefer dark mode.');
    assert.ok(r.ok);
    assert.equal(r.value[0].type, 'state');
  });

  it('multi-intent — 2 subprompts of different types', async () => {
    const llm = makeLlm(
      '[{"type":"fact","text":"Earth is round."},{"type":"action","text":"Tell me about gravity."}]',
    );
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify(
      'Earth is round. Tell me about gravity.',
    );
    assert.ok(r.ok);
    assert.equal(r.value.length, 2);
    assert.equal(r.value[0].type, 'fact');
    assert.equal(r.value[1].type, 'action');
  });

  it('empty array — ok with value=[]', async () => {
    const llm = makeLlm('[]');
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('');
    assert.ok(r.ok);
    assert.deepEqual(r.value, []);
  });
});

describe('LlmClassifier — code fence stripping', () => {
  it('JSON wrapped in ```json...``` is parsed correctly', async () => {
    const llm = makeLlm(
      '```json\n[{"type":"action","text":"Do something."}]\n```',
    );
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('Do something.');
    assert.ok(r.ok);
    assert.equal(r.value[0].type, 'action');
    assert.equal(r.value[0].text, 'Do something.');
  });

  it('JSON wrapped in ``` (no language tag) is parsed correctly', async () => {
    const llm = makeLlm('```\n[{"type":"fact","text":"Water is wet."}]\n```');
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('Water is wet.');
    assert.ok(r.ok);
    assert.equal(r.value[0].type, 'fact');
  });
});

describe('LlmClassifier — parse/schema errors', () => {
  it('non-JSON response → PARSE_ERROR', async () => {
    const llm = makeLlm('This is not JSON at all.');
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'PARSE_ERROR');
  });

  it('JSON object (not array) → SCHEMA_ERROR', async () => {
    const llm = makeLlm('{"type":"action","text":"Do something."}');
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SCHEMA_ERROR');
  });

  // NOTE: "invalid type in entry → SCHEMA_ERROR" test was removed.
  // SubpromptType is intentionally extensible (string & {}), so unknown type
  // values are valid by design and will not produce a SCHEMA_ERROR.

  it('missing text field → SCHEMA_ERROR', async () => {
    const llm = makeLlm('[{"type":"action"}]');
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SCHEMA_ERROR');
  });

  it('empty text field → SCHEMA_ERROR', async () => {
    const llm = makeLlm('[{"type":"action","text":""}]');
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'SCHEMA_ERROR');
  });
});

describe('LlmClassifier — LLM errors', () => {
  it('LLM error → ClassifierError with LLM_ERROR code', async () => {
    const llm = makeLlm(new Error('Provider unavailable'));
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
        return {
          ok: false,
          error: new LlmError('Aborted', 'ABORTED'),
        };
      },
    };
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
  });
});

describe('LlmClassifier — AbortSignal', () => {
  it('pre-aborted signal → ABORTED without calling LLM', async () => {
    const llm = makeLlm('[{"type":"action","text":"test"}]');
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
        // abort while the promise is pending
        ctrl.abort();
        // resolve after abort fires; withAbort should win the race
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return {
          ok: true,
          value: {
            content: '[{"type":"action","text":"hi"}]',
            finishReason: 'stop',
          },
        };
      },
    };
    const classifier = new LlmClassifier(llm);
    const r = await classifier.classify('anything', { signal: ctrl.signal });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
  });
});

describe('LlmClassifier — cache', () => {
  it('cache enabled (default) — same text called twice → LLM called once', async () => {
    const llm = makeLlm('[{"type":"action","text":"test"}]');
    const classifier = new LlmClassifier(llm);
    await classifier.classify('identical input');
    await classifier.classify('identical input');
    assert.equal(llm.callCount, 1);
  });

  it('cache enabled — different texts → LLM called for each', async () => {
    const llm = makeLlm('[{"type":"action","text":"test"}]');
    const classifier = new LlmClassifier(llm);
    await classifier.classify('first input');
    await classifier.classify('second input');
    assert.equal(llm.callCount, 2);
  });

  it('cache disabled — same text called twice → LLM called twice', async () => {
    const llm = makeLlm('[{"type":"action","text":"test"}]');
    const classifier = new LlmClassifier(llm, { enableCache: false });
    await classifier.classify('identical input');
    await classifier.classify('identical input');
    assert.equal(llm.callCount, 2);
  });
});
