/**
 * OpenTelemetry adapter that bridges the SmartAgent ITracer/ISpan
 * abstraction to the @opentelemetry/api Tracer.
 *
 * Import from '@mcp-abap-adt/llm-agent/otel'.
 * Requires @opentelemetry/api ^1.0.0 as a peer dependency.
 */
import { context, trace } from '@opentelemetry/api';
const STATUS_MAP = {
    ok: 1, // SpanStatusCode.OK
    error: 2, // SpanStatusCode.ERROR
};
class OtelSpanAdapter {
    otelSpan;
    name;
    constructor(name, otelSpan) {
        this.otelSpan = otelSpan;
        this.name = name;
    }
    setAttribute(key, value) {
        this.otelSpan.setAttribute(key, value);
    }
    addEvent(name, attributes) {
        this.otelSpan.addEvent(name, attributes);
    }
    setStatus(status, message) {
        this.otelSpan.setStatus({ code: STATUS_MAP[status], message });
    }
    end() {
        this.otelSpan.end();
    }
}
/** Map from ISpan to the underlying OTEL span for parent-child linking. */
const otelSpanMap = new WeakMap();
export class OtelTracerAdapter {
    tracer;
    constructor(tracer) {
        this.tracer = tracer;
    }
    startSpan(name, options) {
        let ctx = context.active();
        if (options?.parent) {
            const parentOtel = otelSpanMap.get(options.parent);
            if (parentOtel) {
                ctx = trace.setSpan(ctx, parentOtel);
            }
        }
        const otelSpan = this.tracer.startSpan(name, undefined, ctx);
        if (options?.traceId) {
            otelSpan.setAttribute('smart_agent.trace_id', options.traceId);
        }
        if (options?.attributes) {
            for (const [k, v] of Object.entries(options.attributes)) {
                otelSpan.setAttribute(k, v);
            }
        }
        const adapter = new OtelSpanAdapter(name, otelSpan);
        otelSpanMap.set(adapter, otelSpan);
        return adapter;
    }
}
//# sourceMappingURL=otel-tracer-adapter.js.map