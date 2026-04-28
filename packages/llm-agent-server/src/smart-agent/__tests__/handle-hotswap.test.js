import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SmartAgent } from '../agent.js';
import { makeDefaultDeps, makeLlm } from '../testing/index.js';
describe('SmartAgentHandle hot-swap delegation', () => {
    it('handle.chat uses reconfigured LLM, not the original', async () => {
        const { deps } = makeDefaultDeps({
            llmResponses: [{ content: 'original' }],
        });
        const agent = new SmartAgent(deps, { maxIterations: 5 });
        // Simulate what builder.ts does — create handle that delegates through agent
        const handle = {
            chat: (messages, tools, options) => agent.currentMainLlm.chat(messages, tools, options),
            streamChat: (messages, tools, options) => agent.currentMainLlm.streamChat(messages, tools, options),
        };
        // Reconfigure to a new LLM
        const newLlm = makeLlm([{ content: 'hot-swapped' }]);
        agent.reconfigure({ mainLlm: newLlm });
        // handle.chat should use the new LLM
        const result = await handle.chat([{ role: 'user', content: 'test' }]);
        assert.ok(result.ok);
        assert.equal(result.value.content, 'hot-swapped');
    });
    it('handle.streamChat uses reconfigured LLM', async () => {
        const { deps } = makeDefaultDeps({
            llmResponses: [{ content: 'original' }],
        });
        const agent = new SmartAgent(deps, { maxIterations: 5 });
        const handle = {
            streamChat: (messages, tools, options) => agent.currentMainLlm.streamChat(messages, tools, options),
        };
        const newLlm = makeLlm([{ content: 'streamed-swap' }]);
        agent.reconfigure({ mainLlm: newLlm });
        const chunks = [];
        for await (const chunk of handle.streamChat([
            { role: 'user', content: 'test' },
        ])) {
            if (chunk.ok)
                chunks.push(chunk.value.content);
        }
        assert.ok(chunks.includes('streamed-swap'));
    });
});
//# sourceMappingURL=handle-hotswap.test.js.map