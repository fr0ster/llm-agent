class NoopSpan {
  name;
  constructor(name) {
    this.name = name;
  }
  setAttribute(_key, _value) {}
  addEvent(_name, _attributes) {}
  setStatus(_status, _message) {}
  end() {}
}
export class NoopTracer {
  startSpan(name, _options) {
    return new NoopSpan(name);
  }
}
//# sourceMappingURL=noop-tracer.js.map
