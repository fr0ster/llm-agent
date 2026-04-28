import type { ISpan, ITracer, SpanOptions } from './types.js';
export declare class NoopTracer implements ITracer {
  startSpan(name: string, _options?: SpanOptions): ISpan;
}
//# sourceMappingURL=noop-tracer.d.ts.map
