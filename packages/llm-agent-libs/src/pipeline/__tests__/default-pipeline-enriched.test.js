import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeDefaultDeps, makeRag } from '../../testing/index.js';
import { DefaultPipeline } from '../default-pipeline.js';
function buildDeps(overrides) {
    const { deps: base } = makeDefaultDeps();
    return {
        mainLlm: base.mainLlm,
        mcpClients: base.mcpClients ?? [],
        ...overrides,
    };
}
function getStages(pipeline) {
    return pipeline.stages;
}
describe('DefaultPipeline enrichedToolSearch', () => {
    it('default (flag off) keeps rag-tools inside parallel rag-retrieval', () => {
        const toolsRag = makeRag([]);
        const pipeline = new DefaultPipeline();
        pipeline.initialize(buildDeps({ toolsRag }));
        const stages = getStages(pipeline);
        const retrieval = stages.find((s) => s.id === 'rag-retrieval');
        assert.ok(retrieval, 'rag-retrieval expected');
        const childIds = retrieval.stages?.map((s) => s.id) ?? [];
        assert.ok(childIds.includes('rag-tools'));
        // No separate top-level rag-tools, no build-tool-query
        const topLevelIds = stages.map((s) => s.id);
        assert.equal(topLevelIds.includes('build-tool-query'), false);
        assert.equal(topLevelIds.filter((id) => id === 'rag-tools').length, 0);
    });
    it('flag on moves rag-tools after build-tool-query with enriched queryText', () => {
        const toolsRag = makeRag([]);
        const pipeline = new DefaultPipeline();
        pipeline.initialize(buildDeps({
            toolsRag,
            agentConfig: { maxIterations: 10, enrichedToolSearch: true },
        }));
        const stages = getStages(pipeline);
        const ids = stages.map((s) => s.id);
        const buildIdx = ids.indexOf('build-tool-query');
        const ragToolsIdx = ids.indexOf('rag-tools');
        const toolSelectIdx = ids.indexOf('tool-select');
        assert.ok(buildIdx >= 0, 'build-tool-query must be present');
        assert.ok(ragToolsIdx >= 0, 'rag-tools must be present at top level');
        assert.ok(toolSelectIdx >= 0, 'tool-select must be present');
        assert.ok(buildIdx < ragToolsIdx, 'build-tool-query must precede rag-tools');
        assert.ok(ragToolsIdx < toolSelectIdx, 'rag-tools must precede tool-select');
        const ragTools = stages[ragToolsIdx];
        assert.equal(ragTools.config?.store, 'tools');
        assert.equal(ragTools.config?.queryText, 'toolQueryText');
        // In enriched mode the parallel rag-retrieval must not contain rag-tools
        const retrieval = stages.find((s) => s.id === 'rag-retrieval');
        if (retrieval) {
            const childIds = retrieval.stages?.map((s) => s.id) ?? [];
            assert.equal(childIds.includes('rag-tools'), false);
        }
    });
    it('flag on with only toolsRag omits the parallel retrieval block', () => {
        const toolsRag = makeRag([]);
        const pipeline = new DefaultPipeline();
        pipeline.initialize(buildDeps({
            toolsRag,
            agentConfig: { maxIterations: 10, enrichedToolSearch: true },
        }));
        const stages = getStages(pipeline);
        assert.equal(stages.find((s) => s.id === 'rag-retrieval'), undefined, 'no parallel retrieval when only tools RAG exists in enriched mode');
    });
});
//# sourceMappingURL=default-pipeline-enriched.test.js.map