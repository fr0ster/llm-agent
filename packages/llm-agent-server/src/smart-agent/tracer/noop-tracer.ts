import type { ISpan, ITracer, SpanOptions, SpanStatus } from './types.js';

class NoopSpan implements ISpan {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  setAttribute(_key: string, _value: string | number | boolean): void {}

  addEvent(
    _name: string,
    _attributes?: Record<string, string | number | boolean>,
  ): void {}

  setStatus(_status: SpanStatus, _message?: string): void {}

  end(): void {}
}

export class NoopTracer implements ITracer {
  startSpan(name: string, _options?: SpanOptions): ISpan {
    return new NoopSpan(name);
  }
}
