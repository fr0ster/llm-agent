import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeLlm } from '../../testing/index.js';
import { LlmQueryExpander, NoopQueryExpander } from '../query-expander.js';
describe('NoopQueryExpander', () => {
    it('returns query unchanged', async () => {
        const expander = new NoopQueryExpander();
        const result = await expander.expand('ABAP internal tables');
        assert.ok(result.ok);
        assert.equal(result.value, 'ABAP internal tables');
    });
});
describe('LlmQueryExpander', () => {
    it('concatenates original query with LLM expansion', async () => {
        const llm = makeLlm([
            { content: 'ABAP ITAB internal table LOOP AT READ TABLE' },
        ]);
        const expander = new LlmQueryExpander(llm);
        const result = await expander.expand('ABAP internal tables');
        assert.ok(result.ok);
        assert.equal(result.value, 'ABAP internal tables ABAP ITAB internal table LOOP AT READ TABLE');
    });
    it('returns original query when LLM returns empty', async () => {
        const llm = makeLlm([{ content: '' }]);
        const expander = new LlmQueryExpander(llm);
        const result = await expander.expand('test query');
        assert.ok(result.ok);
        assert.equal(result.value, 'test query');
    });
    it('returns error when LLM call fails', async () => {
        const llm = makeLlm([new Error('LLM unavailable')]);
        const expander = new LlmQueryExpander(llm);
        const result = await expander.expand('test');
        assert.ok(!result.ok);
        assert.equal(result.error.code, 'QUERY_EXPAND_ERROR');
    });
});
//# sourceMappingURL=query-expander.test.js.map