import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  BaseAgentLlmBridge,
  LLMCallOptions,
  LLMProvider,
  LlmCallEntry,
  LlmUsage,
} from '@mcp-abap-adt/llm-agent';
import { LlmAdapter } from '../../adapters/llm-adapter.js';
import { LlmProviderBridge } from '../../adapters/llm-provider-bridge.js';
import { LoggingLlm } from '../../coordinator/stepper/logging-llm.js';
import { DefaultRequestLogger } from '../default-request-logger.js';
import {
  SessionRequestLogger,
  summaryToUsage,
} from '../session-request-logger.js';

const usage = {
  promptTokens: 100,
  completionTokens: 5,
  totalTokens: 105,
  cachedInputTokens: 60,
  cacheCreationInputTokens: 30,
};
for (const logger of [new DefaultRequestLogger(), new SessionRequestLogger()]) {
  test(`${logger.constructor.name}: cache totals by model, component, category and request`, () => {
    logger.startRequest('r');
    const entry: LlmCallEntry = {
      ...usage,
      component: 'tool-loop',
      model: 'test-model',
      durationMs: 1,
      requestId: 'r',
    };
    logger.logLlmCall(entry);
    logger.logLlmCall(entry);
    const summary = logger.getSummary('r');
    for (const bucket of [
      summary.totals,
      summary.byModel['test-model'],
      summary.byComponent['tool-loop'],
      summary.byCategory.request,
      summaryToUsage(summary),
    ]) {
      assert.equal(bucket.cachedInputTokens, 120);
      assert.equal(bucket.cacheCreationInputTokens, 60);
      assert.equal(bucket.totalTokens, 210);
    }
  });
}

for (const stream of [false, true]) {
  test(`provider bridge, adapter, and LoggingLlm preserve cache controls and usage stream=${stream}`, async () => {
    let seen: LLMCallOptions | undefined;
    const provider: LLMProvider = {
      async chat(_messages, _tools, options) {
        seen = options;
        return { content: 'ok', usage };
      },
      async *streamChat(_messages, _tools, options) {
        seen = options;
        yield { content: 'ok', usage };
      },
    };
    const adapter = new LlmAdapter(new LlmProviderBridge(provider), {
      model: 'test-model',
    });
    const logged: LlmUsage[] = [];
    const llm = new LoggingLlm(adapter, (value) => {
      logged.push(value);
    });
    const options = {
      promptCaching: 'off' as const,
      promptCacheKey: 'stable',
      promptCacheRetention: '24h' as const,
    };
    if (stream) {
      for await (const chunk of llm.streamChat([], [], options)) {
        assert.ok(chunk.ok);
        if (chunk.value.usage) assert.deepEqual(chunk.value.usage, usage);
      }
    } else {
      const result = await llm.chat([], [], options);
      assert.ok(result.ok);
      assert.deepEqual(result.value.usage, usage);
    }
    assert.equal(seen?.promptCaching, 'off');
    assert.equal(seen?.promptCacheKey, 'stable');
    assert.equal(seen?.promptCacheRetention, '24h');
    assert.deepEqual(logged, [usage]);
  });
}

for (const combined of [false, true]) {
  test(`legacy bridge preserves raw cache usage on chat and stream combined=${combined}`, async () => {
    const rawUsage = {
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 60, cache_creation_tokens: 30 },
    };
    const bridge: BaseAgentLlmBridge = {
      async callWithTools() {
        return { content: 'ok', raw: { usage: rawUsage } };
      },
      async *streamWithTools() {
        yield {
          content: '',
          raw: {
            usage: rawUsage,
            choices: combined
              ? [{ delta: { content: '' }, finish_reason: 'stop' }]
              : [],
          },
        };
      },
    };
    const adapter = new LlmAdapter(bridge);
    const result = await adapter.chat([]);
    assert.ok(result.ok);
    assert.deepEqual(result.value.usage, usage);
    for await (const chunk of adapter.streamChat([])) {
      assert.ok(chunk.ok);
      assert.deepEqual(chunk.value.usage, usage);
    }
  });
}
