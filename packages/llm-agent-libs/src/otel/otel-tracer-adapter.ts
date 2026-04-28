/**
 * OpenTelemetry adapter that bridges the SmartAgent ITracer/ISpan
 * abstraction to the @opentelemetry/api Tracer.
 *
 * Import from '@mcp-abap-adt/llm-agent/otel'.
 * Requires @opentelemetry/api ^1.0.0 as a peer dependency.
 */

import type {
  Context,
  Span as OtelSpan,
  SpanStatusCode,
  Tracer,
} from '@opentelemetry/api';
import { context, trace } from '@opentelemetry/api';
import type {
  ISpan,
  ITracer,
  SpanOptions,
  SpanStatus,
} from '../tracer/types.js';

const STATUS_MAP: Record<SpanStatus, SpanStatusCode> = {
  ok: 1 as SpanStatusCode, // SpanStatusCode.OK
  error: 2 as SpanStatusCode, // SpanStatusCode.ERROR
};

class OtelSpanAdapter implements ISpan {
  readonly name: string;

  constructor(
    name: string,
    private readonly otelSpan: OtelSpan,
  ) {
    this.name = name;
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.otelSpan.setAttribute(key, value);
  }

  addEvent(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    this.otelSpan.addEvent(name, attributes);
  }

  setStatus(status: SpanStatus, message?: string): void {
    this.otelSpan.setStatus({ code: STATUS_MAP[status], message });
  }

  end(): void {
    this.otelSpan.end();
  }
}

/** Map from ISpan to the underlying OTEL span for parent-child linking. */
const otelSpanMap = new WeakMap<ISpan, OtelSpan>();

export class OtelTracerAdapter implements ITracer {
  constructor(private readonly tracer: Tracer) {}

  startSpan(name: string, options?: SpanOptions): ISpan {
    let ctx: Context = context.active();

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
