import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SmartAgent } from '../../agent.js';
import { makeCapturingTracer, makeClassifier, makeDefaultDeps, makeMcpClient, makeRag, } from '../../testing/index.js';
import { NoopTracer } from '../noop-tracer.js';
const DEFAULT_CONFIG = { maxIterations: 5 };
// ---------------------------------------------------------------------------
// NoopTracer
// ---------------------------------------------------------------------------
describe('NoopTracer', () => {
    it('startSpan returns a span with the given name', () => {
        const tracer = new NoopTracer();
        const span = tracer.startSpan('test');
        assert.equal(span.name, 'test');
    });
    it('all span methods succeed silently', () => {
        const tracer = new NoopTracer();
        const span = tracer.startSpan('test');
        span.setAttribute('key', 'value');
        span.addEvent('event', { detail: 42 });
        span.setStatus('ok');
        span.setStatus('error', 'msg');
        span.end();
    });
    it('child spans work via parent option', () => {
        const tracer = new NoopTracer();
        const parent = tracer.startSpan('parent');
        const child = tracer.startSpan('child', { parent });
        assert.equal(child.name, 'child');
        child.end();
        parent.end();
    });
});
// ---------------------------------------------------------------------------
// Pipeline spans — capturing tracer
// ---------------------------------------------------------------------------
describe('Pipeline spans — basic flow', () => {
    it('creates root, classify, assemble, and tool_loop spans', async () => {
        const tracer = makeCapturingTracer();
        const { deps } = makeDefaultDeps({
            llmResponses: [{ content: 'hello', finishReason: 'stop' }],
            tracer,
        });
        const agent = new SmartAgent(deps, DEFAULT_CONFIG);
        const r = await agent.process('test');
        assert.ok(r.ok);
        const names = tracer.spans.map((s) => s.name);
        assert.ok(names.includes('smart_agent.process'), 'root span exists');
        assert.ok(names.includes('smart_agent.classify'), 'classify span exists');
        assert.ok(names.includes('smart_agent.assemble'), 'assemble span exists');
        assert.ok(names.includes('smart_agent.tool_loop'), 'tool_loop span exists');
        assert.ok(names.includes('smart_agent.llm_call'), 'llm_call span exists');
        // All spans are ended
        for (const s of tracer.spans) {
            assert.ok(s.ended, `span "${s.name}" should be ended`);
        }
    });
    it('classify span has parent = root', async () => {
        const tracer = makeCapturingTracer();
        const { deps } = makeDefaultDeps({ tracer });
        const agent = new SmartAgent(deps, DEFAULT_CONFIG);
        await agent.process('test');
        const classify = tracer.spans.find((s) => s.name === 'smart_agent.classify');
        assert.ok(classify);
        assert.equal(classify.parentName, 'smart_agent.process');
    });
    it('assemble span has parent = root', async () => {
        const tracer = makeCapturingTracer();
        const { deps } = makeDefaultDeps({ tracer });
        const agent = new SmartAgent(deps, DEFAULT_CONFIG);
        await agent.process('test');
        const assemble = tracer.spans.find((s) => s.name === 'smart_agent.assemble');
        assert.ok(assemble);
        assert.equal(assemble.parentName, 'smart_agent.process');
    });
    it('tool_loop and llm_call have correct parent chain', async () => {
        const tracer = makeCapturingTracer();
        const { deps } = makeDefaultDeps({ tracer });
        const agent = new SmartAgent(deps, DEFAULT_CONFIG);
        await agent.process('test');
        const toolLoop = tracer.spans.find((s) => s.name === 'smart_agent.tool_loop');
        assert.ok(toolLoop);
        assert.equal(toolLoop.parentName, 'smart_agent.process');
        const llmCall = tracer.spans.find((s) => s.name === 'smart_agent.llm_call');
        assert.ok(llmCall);
        assert.equal(llmCall.parentName, 'smart_agent.tool_loop');
    });
});
// ---------------------------------------------------------------------------
// Tool execution spans
// ---------------------------------------------------------------------------
describe('Pipeline spans — tool execution', () => {
    it('creates tool_call spans with parent tool_loop', async () => {
        const tracer = makeCapturingTracer();
        const client = makeMcpClient([{ name: 'ping', description: 'Ping', inputSchema: {} }], new Map([['ping', { content: 'pong' }]]));
        const { deps } = makeDefaultDeps({
            mcpClients: [client],
            llmResponses: [
                {
                    content: 'calling',
                    finishReason: 'tool_calls',
                    toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }],
                },
                { content: 'done', finishReason: 'stop' },
            ],
            tracer,
        });
        const agent = new SmartAgent(deps, { ...DEFAULT_CONFIG, mode: 'hard' });
        const r = await agent.process('test');
        assert.ok(r.ok);
        const toolCallSpan = tracer.spans.find((s) => s.name === 'smart_agent.tool_call');
        assert.ok(toolCallSpan, 'tool_call span exists');
        assert.equal(toolCallSpan.parentName, 'smart_agent.tool_loop');
        assert.equal(toolCallSpan.attributes['tool.name'], 'ping');
        assert.ok(toolCallSpan.ended);
        assert.deepEqual(toolCallSpan.status, { status: 'ok', message: undefined });
        // Two llm_call spans (one before tool, one after)
        const llmCalls = tracer.spans.filter((s) => s.name === 'smart_agent.llm_call');
        assert.equal(llmCalls.length, 2, 'two LLM iterations');
        for (const lc of llmCalls) {
            assert.equal(lc.parentName, 'smart_agent.tool_loop');
        }
    });
});
// ---------------------------------------------------------------------------
// RAG query spans
// ---------------------------------------------------------------------------
describe('Pipeline spans — RAG query', () => {
    it('creates rag_query span when SAP context present', async () => {
        const tracer = makeCapturingTracer();
        const { deps } = makeDefaultDeps({
            classifier: makeClassifier([
                { type: 'action', text: 'Show SAP data', context: 'sap-abap' },
            ]),
            ragStores: { facts: makeRag() },
            llmResponses: [{ content: 'done', finishReason: 'stop' }],
            tracer,
        });
        const agent = new SmartAgent(deps, DEFAULT_CONFIG);
        await agent.process('test');
        const ragQuery = tracer.spans.find((s) => s.name === 'smart_agent.rag_query');
        assert.ok(ragQuery, 'rag_query span exists');
        assert.equal(ragQuery.parentName, 'smart_agent.process');
        assert.ok(ragQuery.ended);
    });
});
// ---------------------------------------------------------------------------
// RAG upsert spans
// ---------------------------------------------------------------------------
// RAG upsert span test removed in 6.0.0 (RagUpsertHandler removed)
// ---------------------------------------------------------------------------
// Error status propagation
// ---------------------------------------------------------------------------
describe('Pipeline spans — error status', () => {
    it('classifier error sets error status on classify and root spans', async () => {
        const tracer = makeCapturingTracer();
        const { deps } = makeDefaultDeps({
            classifier: makeClassifier(new Error('classify failed')),
            tracer,
        });
        const agent = new SmartAgent(deps, DEFAULT_CONFIG);
        const r = await agent.process('test');
        assert.ok(!r.ok);
        const root = tracer.spans.find((s) => s.name === 'smart_agent.process');
        assert.ok(root);
        assert.equal(root.status?.status, 'error');
        assert.ok(root.ended);
        const classify = tracer.spans.find((s) => s.name === 'smart_agent.classify');
        assert.ok(classify);
        assert.equal(classify.status?.status, 'error');
        assert.ok(classify.ended);
    });
});
// ---------------------------------------------------------------------------
// No tracer (NoopTracer default)
// ---------------------------------------------------------------------------
describe('No tracer — default NoopTracer', () => {
    it('process succeeds without providing a tracer', async () => {
        const { deps } = makeDefaultDeps({
            llmResponses: [{ content: 'hello', finishReason: 'stop' }],
        });
        const agent = new SmartAgent(deps, DEFAULT_CONFIG);
        const r = await agent.process('test');
        assert.ok(r.ok);
        assert.equal(r.value.content, 'hello');
    });
});
// ---------------------------------------------------------------------------
// Root span attributes
// ---------------------------------------------------------------------------
describe('Pipeline spans — root span attributes', () => {
    it('root span carries trace_id and mode attribute', async () => {
        const tracer = makeCapturingTracer();
        const { deps } = makeDefaultDeps({ tracer });
        const agent = new SmartAgent(deps, { ...DEFAULT_CONFIG, mode: 'hard' });
        await agent.process('test');
        const root = tracer.spans.find((s) => s.name === 'smart_agent.process');
        assert.ok(root);
        assert.equal(root.attributes['smart_agent.mode'], 'hard');
        assert.ok(root.attributes['smart_agent.trace_id'], 'trace_id present');
    });
});
//# sourceMappingURL=tracer.test.js.map