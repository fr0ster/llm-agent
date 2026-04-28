/**
 * Shared test-double factories for SmartAgent integration testing.
 *
 * Consumers can import from '@mcp-abap-adt/llm-agent/testing' to build
 * deterministic stubs for all SmartAgent interfaces without duplicating
 * factory code.
 *
 * @example
 * ```typescript
 * import { makeLlm, makeRag, makeDefaultDeps } from '@mcp-abap-adt/llm-agent/testing';
 * ```
 */
import { AssemblerError, CircuitBreaker, ClassifierError, LlmError, McpError, NoopQueryExpander, NoopToolCache, RagError, ToolCache, } from '@mcp-abap-adt/llm-agent';
import { InMemoryMetrics } from '../metrics/in-memory-metrics.js';
import { NoopReranker } from '../reranker/noop-reranker.js';
import { NoopSessionManager } from '../session/noop-session-manager.js';
import { SessionManager } from '../session/session-manager.js';
import { NoopValidator } from '../validator/noop-validator.js';
// ---------------------------------------------------------------------------
// LLM stub
// ---------------------------------------------------------------------------
export function makeLlm(responses) {
    let callCount = 0;
    const queue = [...responses];
    return {
        get callCount() {
            return callCount;
        },
        async chat() {
            callCount++;
            const next = queue.shift();
            if (!next) {
                return {
                    ok: true,
                    value: { content: 'default', finishReason: 'stop' },
                };
            }
            if (next instanceof Error) {
                return { ok: false, error: new LlmError(next.message) };
            }
            return {
                ok: true,
                value: {
                    content: next.content,
                    toolCalls: next.toolCalls,
                    finishReason: next.finishReason ?? 'stop',
                },
            };
        },
        async *streamChat() {
            callCount++;
            const next = queue.shift();
            if (!next) {
                yield {
                    ok: true,
                    value: { content: 'default', finishReason: 'stop' },
                };
                return;
            }
            if (next instanceof Error) {
                yield { ok: false, error: new LlmError(next.message) };
                return;
            }
            yield {
                ok: true,
                value: {
                    content: next.content,
                    toolCalls: next.toolCalls,
                    finishReason: next.finishReason ?? 'stop',
                },
            };
        },
        async healthCheck() {
            const next = queue[0];
            if (next instanceof Error) {
                return { ok: false, error: new LlmError(next.message) };
            }
            return { ok: true, value: true };
        },
    };
}
// ---------------------------------------------------------------------------
// RAG stubs
// ---------------------------------------------------------------------------
export function makeRag(queryResults = []) {
    const upsertCalls = [];
    const stub = {
        upsertCalls,
        async query(_embedding) {
            return { ok: true, value: queryResults };
        },
        async healthCheck() {
            return { ok: true, value: undefined };
        },
        async getById(_id) {
            return { ok: true, value: null };
        },
        writer() {
            return {
                upsertRaw: async (_id, text) => {
                    upsertCalls.push(text);
                    return { ok: true, value: undefined };
                },
                deleteByIdRaw: async (_id) => {
                    return { ok: true, value: false };
                },
            };
        },
    };
    return stub;
}
export function makeFailingRag() {
    const upsertCalls = [];
    const stub = {
        upsertCalls,
        async query(_embedding) {
            return { ok: false, error: new RagError('Query failed') };
        },
        async healthCheck() {
            return { ok: false, error: new RagError('Health check failed') };
        },
        async getById(_id) {
            return { ok: false, error: new RagError('getById failed') };
        },
    };
    return stub;
}
/** RAG stub that records metadata passed to writer().upsertRaw (for session-policy tests). */
export function makeMetadataRag(queryResults = []) {
    const upsertCalls = [];
    const upsertMetadata = [];
    const queryCalls = [];
    const stub = {
        upsertCalls,
        upsertMetadata,
        queryCalls,
        async query(embedding, k) {
            queryCalls.push({ text: embedding.text, k });
            return { ok: true, value: queryResults };
        },
        async healthCheck() {
            return { ok: true, value: undefined };
        },
        async getById(_id) {
            return { ok: true, value: null };
        },
        writer() {
            return {
                upsertRaw: async (id, text, metadata) => {
                    upsertCalls.push(text);
                    upsertMetadata.push({ ...metadata, id });
                    return { ok: true, value: undefined };
                },
                deleteByIdRaw: async (_id) => {
                    return { ok: true, value: false };
                },
            };
        },
    };
    return stub;
}
// ---------------------------------------------------------------------------
// MCP client stub
// ---------------------------------------------------------------------------
export function makeMcpClient(tools, callResults) {
    let callCount = 0;
    return {
        get callCount() {
            return callCount;
        },
        async listTools() {
            return { ok: true, value: tools };
        },
        async callTool(name) {
            callCount++;
            const result = callResults?.get(name);
            if (result instanceof Error) {
                return { ok: false, error: new McpError(result.message) };
            }
            if (result) {
                return { ok: true, value: result };
            }
            return { ok: true, value: { content: `result of ${name}` } };
        },
    };
}
// ---------------------------------------------------------------------------
// Classifier stub
// ---------------------------------------------------------------------------
export function makeClassifier(result, onCall) {
    return {
        async classify() {
            onCall?.();
            if (result instanceof Error) {
                const code = result.message === 'ABORTED' ? 'ABORTED' : 'CLASSIFIER_ERROR';
                return { ok: false, error: new ClassifierError(result.message, code) };
            }
            return { ok: true, value: result };
        },
    };
}
// ---------------------------------------------------------------------------
// Assembler stub
// ---------------------------------------------------------------------------
export function makeAssembler(result) {
    const defaultMessages = [{ role: 'user', content: 'action text' }];
    return {
        async assemble(_action, _retrieved, _history, _opts) {
            const r = result ?? defaultMessages;
            if (r instanceof Error) {
                const code = r.message === 'ABORTED' ? 'ABORTED' : 'ASSEMBLER_ERROR';
                return { ok: false, error: new AssemblerError(r.message, code) };
            }
            return { ok: true, value: r };
        },
    };
}
// ---------------------------------------------------------------------------
// Capturing logger
// ---------------------------------------------------------------------------
export function makeCapturingLogger() {
    const events = [];
    return {
        events,
        log(event) {
            events.push(event);
        },
    };
}
export function makeCapturingTracer() {
    const spans = [];
    return {
        spans,
        startSpan(name, options) {
            const captured = {
                name,
                parentName: options?.parent?.name,
                attributes: { ...options?.attributes },
                events: [],
                ended: false,
            };
            if (options?.traceId) {
                captured.attributes['smart_agent.trace_id'] = options.traceId;
            }
            spans.push(captured);
            return {
                get name() {
                    return captured.name;
                },
                setAttribute(key, value) {
                    captured.attributes[key] = value;
                },
                addEvent(eventName, attributes) {
                    captured.events.push({ name: eventName, attributes });
                },
                setStatus(status, message) {
                    captured.status = { status, message };
                },
                end() {
                    captured.ended = true;
                },
            };
        },
    };
}
// ---------------------------------------------------------------------------
// Capturing metrics
// ---------------------------------------------------------------------------
/** Returns an InMemoryMetrics instance for test assertions. */
export function makeCapturingMetrics() {
    return new InMemoryMetrics();
}
// ---------------------------------------------------------------------------
// Circuit breaker factory
// ---------------------------------------------------------------------------
/** Returns a CircuitBreaker for testing. */
export function makeCircuitBreaker(config) {
    return new CircuitBreaker(config);
}
// ---------------------------------------------------------------------------
// Reranker stub
// ---------------------------------------------------------------------------
/** Returns a NoopReranker (pass-through) or a custom IReranker for testing. */
export function makeReranker(custom) {
    return custom ?? new NoopReranker();
}
// ---------------------------------------------------------------------------
// Query expander stub
// ---------------------------------------------------------------------------
/** Returns a NoopQueryExpander (pass-through) or a custom IQueryExpander for testing. */
export function makeQueryExpander(custom) {
    return custom ?? new NoopQueryExpander();
}
// ---------------------------------------------------------------------------
// Tool cache stub
// ---------------------------------------------------------------------------
/** Returns a ToolCache or NoopToolCache for testing. */
export function makeToolCache(opts) {
    if (opts && 'get' in opts)
        return opts;
    return opts ? new ToolCache(opts) : new NoopToolCache();
}
// ---------------------------------------------------------------------------
// Output validator stub
// ---------------------------------------------------------------------------
/** Returns a NoopValidator (pass-through) or a custom IOutputValidator for testing. */
export function makeOutputValidator(custom) {
    return custom ?? new NoopValidator();
}
// ---------------------------------------------------------------------------
// Session manager stub
// ---------------------------------------------------------------------------
/** Returns a SessionManager or NoopSessionManager for testing. */
export function makeSessionManager(opts) {
    if (opts && 'addTokens' in opts)
        return opts;
    return opts?.tokenBudget
        ? new SessionManager({ tokenBudget: opts.tokenBudget })
        : new NoopSessionManager();
}
// ---------------------------------------------------------------------------
// Default deps factory
// ---------------------------------------------------------------------------
export function makeDefaultDeps(overrides) {
    const llm = makeLlm(overrides?.llmResponses ?? [{ content: 'hello', finishReason: 'stop' }]);
    return {
        llm,
        deps: {
            mainLlm: llm,
            mcpClients: overrides?.mcpClients ?? [],
            ragStores: overrides?.ragStores ?? {},
            ragRegistry: overrides?.ragRegistry,
            ragProviderRegistry: overrides?.ragProviderRegistry,
            classifier: overrides?.classifier ??
                makeClassifier([{ type: 'action', text: 'do something' }]),
            assembler: overrides?.assembler ?? makeAssembler(),
            reranker: overrides?.reranker,
            queryExpander: overrides?.queryExpander,
            logger: overrides?.logger,
            toolPolicy: overrides?.toolPolicy,
            injectionDetector: overrides?.injectionDetector,
            toolCache: overrides?.toolCache,
            outputValidator: overrides?.outputValidator,
            sessionManager: overrides?.sessionManager,
            tracer: overrides?.tracer,
            metrics: overrides?.metrics,
            connectionStrategy: overrides?.connectionStrategy,
        },
    };
}
//# sourceMappingURL=index.js.map