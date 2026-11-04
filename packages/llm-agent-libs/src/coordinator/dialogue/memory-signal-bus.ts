import type {
  AnySignal,
  DialogueSignals,
  ISignalBus,
  Signal,
  SignalName,
} from '@mcp-abap-adt/llm-agent';

/** Session-local retention; retiring a session releases all of its payloads. */
export function createMemorySignalBus(): ISignalBus<DialogueSignals> {
  type RetainedSignal = AnySignal<DialogueSignals>;
  type Handler = (signal: RetainedSignal) => void | Promise<void>;
  const retained = new Map<string, Map<string, RetainedSignal>>();
  // Each DialogueSession gets a fresh bus, so reopening the same id starts unretired.
  const retired = new Set<string>();
  const handlers = new Set<Handler>();
  const queue: (RetainedSignal | { retire: string })[] = [];
  let draining = false;

  function drain(): void {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const signal = queue.shift();
        if (!signal) continue;
        if ('retire' in signal) {
          retired.add(signal.retire);
          retained.delete(signal.retire);
          continue;
        }
        if (!retired.has(signal.source)) {
          let source = retained.get(signal.source);
          if (!source) {
            source = new Map();
            retained.set(signal.source, source);
          }
          const key = JSON.stringify([signal.name, signal.key]);
          source.delete(key);
          source.set(key, signal);
        }
        for (const handler of [...handlers]) {
          if (!handlers.has(handler)) continue;
          try {
            void Promise.resolve(handler(structuredClone(signal))).catch(
              () => {},
            );
          } catch {
            // Observers cannot interrupt producers.
          }
        }
      }
    } finally {
      draining = false;
    }
  }

  const bus: ISignalBus<DialogueSignals> = {
    emit(name, payload, source, key = '') {
      queue.push(
        structuredClone({
          name,
          payload,
          source,
          key,
          at: Date.now(),
        }) as RetainedSignal,
      );
      drain();
    },
    retire(source) {
      queue.push({ retire: source });
      drain();
    },
    on(name, handler, filter) {
      return bus.onAny((signal) => {
        if (signal.name === name)
          return handler(signal as Signal<DialogueSignals, typeof name>);
      }, filter);
    },
    onAny(handler, filter) {
      const run: Handler = (signal) => {
        if (filter?.source === undefined || filter.source === signal.source)
          return handler(signal);
      };
      handlers.add(run);
      return () => {
        handlers.delete(run);
      };
    },
    last<K extends SignalName<DialogueSignals>>(
      name: K,
      source: string,
      key = '',
    ) {
      const signal = retained.get(source)?.get(JSON.stringify([name, key]));
      return signal === undefined
        ? undefined
        : (structuredClone(signal) as Signal<DialogueSignals, K>);
    },
    lastAll(source) {
      return structuredClone([...(retained.get(source)?.values() ?? [])]);
    },
  };
  return bus;
}
