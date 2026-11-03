import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SmartAgent } from '../agent.js';
import type { IPipeline } from '../interfaces/pipeline.js';
import { resolveSessionRegistries } from '../pipeline/default-pipeline.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import { makeDefaultDeps } from '../testing/index.js';

for (const fail of [false, true]) {
  test(`configured pipeline isolates and cleans shared registries (failure: ${fail})`, async () => {
    const pendingToolResults = new PendingToolResultsRegistry();
    const toolAvailability = new ToolAvailabilityRegistry();
    const sessions: string[] = [];
    const pipeline: IPipeline = {
      initialize() {},
      async execute(_input, _history, options, yieldChunk) {
        assert.ok(options?.sessionId);
        const sessionId = options.sessionId;
        sessions.push(sessionId);
        assert.ok(
          options.pendingToolResults instanceof PendingToolResultsRegistry,
        );
        assert.ok(options.toolAvailability instanceof ToolAvailabilityRegistry);
        const registries = resolveSessionRegistries({
          pendingToolResults: options.pendingToolResults,
          toolAvailability: options.toolAvailability,
        });
        assert.equal(registries.pendingToolResults, pendingToolResults);
        assert.equal(registries.toolAvailability, toolAvailability);
        assert.equal(registries.pendingToolResults.has(sessionId), false);
        assert.equal(
          registries.toolAvailability.isBlocked(sessionId, 'read'),
          false,
        );
        registries.pendingToolResults.set(sessionId, {
          assistantMessage: { role: 'assistant', content: 'private result' },
          promise: Promise.resolve([]),
          createdAt: Date.now(),
        });
        registries.toolAvailability.block(sessionId, 'read', 'private block');
        if (fail) throw new Error('pipeline failed');
        yieldChunk({
          ok: true,
          value: { content: 'done', finishReason: 'stop' },
        });
        return { timing: [] };
      },
    };
    const { deps } = makeDefaultDeps();
    deps.pipeline = pipeline;
    const agent = new SmartAgent(deps, { maxIterations: 2 });
    for (let i = 0; i < 2; i++) {
      await agent.process('request', { pendingToolResults, toolAvailability });
      assert.equal(pendingToolResults.size, 0);
      for (const id of sessions)
        assert.equal(toolAvailability.isBlocked(id, 'read'), false);
    }
    assert.equal(sessions.length, 2);
    assert.notEqual(sessions[0], sessions[1]);
    assert.ok(!sessions.includes('default'));
  });
}
