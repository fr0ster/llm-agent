/**
 * OpenTelemetry adapter that bridges the SmartAgent ITracer/ISpan
 * abstraction to the @opentelemetry/api Tracer.
 *
 * Import from '@mcp-abap-adt/llm-agent/otel'.
 * Requires @opentelemetry/api ^1.0.0 as a peer dependency.
 */
import type { Tracer } from '@opentelemetry/api';
import type { ISpan, ITracer, SpanOptions } from '../tracer/types.js';
export declare class OtelTracerAdapter implements ITracer {
    private readonly tracer;
    constructor(tracer: Tracer);
    startSpan(name: string, options?: SpanOptions): ISpan;
}
//# sourceMappingURL=otel-tracer-adapter.d.ts.map