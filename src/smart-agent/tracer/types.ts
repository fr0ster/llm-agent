export type SpanStatus = 'ok' | 'error';

export interface SpanOptions {
  parent?: ISpan;
  attributes?: Record<string, string | number | boolean>;
  traceId?: string;
}

export interface ISpan {
  readonly name: string;
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): void;
  setStatus(status: SpanStatus, message?: string): void;
  end(): void;
}

export interface ITracer {
  startSpan(name: string, options?: SpanOptions): ISpan;
}
