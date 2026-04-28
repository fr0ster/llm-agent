import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeDefaultDeps, makeRag } from '../../testing/index.js';
import { DefaultPipeline } from '../default-pipeline.js';

// ---------------------------------------------------------------------------
// Helper to build minimal PipelineDeps from makeDefaultDeps
// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------
// DefaultPipeline — custom RAG stores
// ---------------------------------------------------------------------------
describe('DefaultPipeline.rebuildStages()', () => {
  it('is callable after initialize and does not throw', () => {
    const pipeline = new DefaultPipeline();
    pipeline.initialize(buildDeps());
    assert.doesNotThrow(() => pipeline.rebuildStages?.());
  });
  it('rebuildStages() is a no-op when called multiple times', () => {
    const pipeline = new DefaultPipeline();
    pipeline.initialize(buildDeps());
    assert.doesNotThrow(() => {
      pipeline.rebuildStages?.();
      pipeline.rebuildStages?.();
    });
  });
});
describe('DefaultPipeline — custom ragStores', () => {
  it('initializes without throwing when ragStores contains a custom store', () => {
    const kbStore = makeRag([]);
    const pipeline = new DefaultPipeline();
    assert.doesNotThrow(() =>
      pipeline.initialize(buildDeps({ ragStores: { kb: kbStore } })),
    );
  });
  it('internal stages include rag-kb when ragStores has "kb"', () => {
    const kbStore = makeRag([]);
    const pipeline = new DefaultPipeline();
    pipeline.initialize(buildDeps({ ragStores: { kb: kbStore } }));
    const stages = getStages(pipeline);
    // Find the rag-retrieval parallel stage
    const ragRetrieval = stages.find((s) => s.id === 'rag-retrieval');
    assert.ok(ragRetrieval, 'rag-retrieval stage should be present');
    assert.ok(ragRetrieval.stages, 'rag-retrieval should have child stages');
    const childIds = ragRetrieval.stages?.map((s) => s.id) ?? [];
    assert.ok(
      childIds.includes('rag-kb'),
      `rag-kb expected in ${childIds.join(', ')}`,
    );
  });
  it('built-in tools/history are not duplicated when present in ragStores', () => {
    const toolsRag = makeRag([]);
    const historyRag = makeRag([]);
    const pipeline = new DefaultPipeline();
    pipeline.initialize(
      buildDeps({
        toolsRag,
        historyRag,
        // Passing tools and history again via ragStores should not create duplicates
        ragStores: { tools: toolsRag, history: historyRag },
      }),
    );
    const stages = getStages(pipeline);
    const ragRetrieval = stages.find((s) => s.id === 'rag-retrieval');
    assert.ok(ragRetrieval, 'rag-retrieval stage should be present');
    const childIds = ragRetrieval.stages?.map((s) => s.id) ?? [];
    // Should have exactly rag-tools and rag-history, not duplicated
    const toolsCount = childIds.filter((id) => id === 'rag-tools').length;
    const historyCount = childIds.filter((id) => id === 'rag-history').length;
    assert.equal(toolsCount, 1, 'rag-tools should appear exactly once');
    assert.equal(historyCount, 1, 'rag-history should appear exactly once');
  });
  it('no rag-retrieval stage when no stores are provided', () => {
    const pipeline = new DefaultPipeline();
    pipeline.initialize(buildDeps({ ragStores: {} }));
    const stages = getStages(pipeline);
    const ragRetrieval = stages.find((s) => s.id === 'rag-retrieval');
    assert.equal(
      ragRetrieval,
      undefined,
      'rag-retrieval should be absent with no stores',
    );
  });
  it('rebuildStages() reflects updated ragStores', () => {
    const pipeline = new DefaultPipeline();
    const deps = buildDeps({ ragStores: {} });
    pipeline.initialize(deps);
    // Initially no rag-retrieval
    const stagesBefore = getStages(pipeline);
    assert.equal(
      stagesBefore.find((s) => s.id === 'rag-retrieval'),
      undefined,
    );
    // Add a store to the deps object in-place (simulating addRagStore)
    deps.ragStores.kb = makeRag([]);
    pipeline.rebuildStages?.();
    const stagesAfter = getStages(pipeline);
    const ragRetrieval = stagesAfter.find((s) => s.id === 'rag-retrieval');
    assert.ok(ragRetrieval, 'rag-retrieval should now be present');
    const childIds = ragRetrieval.stages?.map((s) => s.id) ?? [];
    assert.ok(childIds.includes('rag-kb'));
  });
});
//# sourceMappingURL=default-pipeline-custom-rag.test.js.map
