import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type IUsageRecorder,
  RagError,
  type UsageInput,
} from '@mcp-abap-adt/llm-agent';
import { OllamaEmbedder } from './ollama.js';

for (const batch of [false, true]) {
  const mode = batch ? 'batch' : 'single';
  for (const status of [429, 500]) {
    for (const bodyOutcome of ['reject', 'resolve']) {
      for (const reason of [new Error('caller stopped'), 'caller stopped']) {
        test(`${mode} preserves caller cancellation while HTTP ${status} body ${bodyOutcome}s (${typeof reason})`, async (t) => {
          const controller = new AbortController();
          let startReading = () => {};
          const bodyStarted = new Promise<void>((resolve) => {
            startReading = resolve;
          });
          let finishReading = (_text: string) => {};
          let failReading = (_error: Error) => {};
          const body = new Promise<string>((resolve, reject) => {
            finishReading = resolve;
            failReading = reject;
          });
          const response = new Response(null, { status });
          t.mock.method(response, 'text', () => {
            startReading();
            return body;
          });
          let calls = 0;
          t.mock.method(globalThis, 'fetch', async () => {
            calls++;
            return response;
          });
          const records: Extract<UsageInput, { kind: 'embedding.call' }>[] = [];
          const usage: IUsageRecorder = {
            record: (record) => {
              if (record.kind === 'embedding.call') records.push(record);
            },
            with: () => usage,
          };
          const provider = new OllamaEmbedder({ model: 'test', usage });
          const pending = batch
            ? provider.embedBatch(['q'], { signal: controller.signal })
            : provider.embed('q', { signal: controller.signal });
          await bodyStarted;
          assert.equal(
            records.length,
            0,
            'usage must wait for the final outcome',
          );
          controller.abort(reason);
          if (bodyOutcome === 'reject') {
            failReading(new DOMException('body read aborted', 'AbortError'));
          } else {
            finishReading('failure');
          }
          await assert.rejects(pending, (error) => error === reason);
          assert.equal(calls, 1);
          assert.equal(records.length, 1);
          assert.equal(records[0].outcome, 'aborted');
          assert.notEqual(records[0].errorCode, String(status));
        });
      }
    }
  }

  test(`${mode} preserves an AbortError from the HTTP error body without a caller signal`, async (t) => {
    const reason = new DOMException('body read aborted', 'AbortError');
    const response = new Response(null, { status: 500 });
    t.mock.method(response, 'text', async () => {
      throw reason;
    });
    t.mock.method(globalThis, 'fetch', async () => response);
    const records: Extract<UsageInput, { kind: 'embedding.call' }>[] = [];
    const usage: IUsageRecorder = {
      record: (record) => {
        if (record.kind === 'embedding.call') records.push(record);
      },
      with: () => usage,
    };
    const provider = new OllamaEmbedder({ model: 'test', usage });
    await assert.rejects(
      batch ? provider.embedBatch(['q']) : provider.embed('q'),
      (error) => error === reason,
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'aborted');
  });

  test(`${mode} retains HTTP metadata when an error body fails without cancellation`, async (t) => {
    const response = new Response(null, {
      status: 429,
      headers: { 'Retry-After': '1.25' },
    });
    t.mock.method(response, 'text', async () => {
      throw new TypeError('body unavailable');
    });
    t.mock.method(globalThis, 'fetch', async () => response);
    const records: Extract<UsageInput, { kind: 'embedding.call' }>[] = [];
    const usage: IUsageRecorder = {
      record: (record) => {
        if (record.kind === 'embedding.call') records.push(record);
      },
      with: () => usage,
    };
    const provider = new OllamaEmbedder({ model: 'test', usage });
    await assert.rejects(
      batch ? provider.embedBatch(['q']) : provider.embed('q'),
      (error) => {
        assert.ok(error instanceof RagError);
        assert.ok('status' in error && error.status === 429);
        assert.ok('headers' in error && error.headers === response.headers);
        assert.ok(
          'retryAfterSeconds' in error && error.retryAfterSeconds === 1.25,
        );
        return true;
      },
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].outcome, 'error');
    assert.equal(records[0].errorCode, '429');
  });
}
