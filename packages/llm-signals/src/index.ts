import type {
  AnySignal,
  ISignalBus,
  ISignalEmitter,
  Signal,
  SignalName,
} from '@mcp-abap-adt/llm-agent';

function safely(action: () => void): void {
  try {
    action();
  } catch {
    /* Observers cannot affect producers. */
  }
}
function freeze(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value))
    freeze(Reflect.get(value, key), seen);
  Object.freeze(value);
}
export function noopEmitter<C extends object>(): ISignalEmitter<C> {
  return { emit() {}, retire() {} };
}
export function combineEmitters<C extends object>(
  ...emitters: ISignalEmitter<C>[]
): ISignalEmitter<C> {
  return {
    emit(name, payload, source, key) {
      for (const emitter of emitters)
        safely(() => emitter.emit(name, payload, source, key));
    },
    retire(source) {
      for (const emitter of emitters) safely(() => emitter.retire(source));
    },
  };
}
export function filterEmitter<C extends object>(
  emitter: ISignalEmitter<C>,
  predicate: (name: SignalName<C>, source: string) => boolean,
): ISignalEmitter<C> {
  return {
    emit(name, payload, source, key) {
      safely(() => {
        if (predicate(name, source)) emitter.emit(name, payload, source, key);
      });
    },
    retire(source) {
      safely(() => emitter.retire(source));
    },
  };
}
export function createSignalBus<C extends object>(
  opts: {
    onHandlerError?: (error: unknown, signal: AnySignal<C>) => void;
  } = {},
): ISignalBus<C> {
  type Handler = {
    name?: SignalName<C>;
    source?: string;
    run: (signal: AnySignal<C>) => void | Promise<void>;
  };
  const handlers = new Set<Handler>();
  const retained = new Map<string, Map<string, AnySignal<C>>>();
  const queue: ({ signal: AnySignal<C> } | { retire: string })[] = [];
  let draining = false;
  const report = (error: unknown, signal: AnySignal<C>) =>
    safely(() => opts.onHandlerError?.(error, signal));
  function drain(): void {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const entry = queue.shift();
        if (!entry) continue;
        if ('retire' in entry) {
          retained.delete(entry.retire);
          continue;
        }
        const signal = entry.signal;
        safely(() => freeze(signal));
        let source = retained.get(signal.source);
        if (!source) {
          source = new Map();
          retained.set(signal.source, source);
        }
        const key = JSON.stringify([signal.name, signal.key]);
        source.delete(key);
        source.set(key, signal);
        for (const handler of [...handlers]) {
          if (handler.name !== undefined && handler.name !== signal.name)
            continue;
          if (handler.source !== undefined && handler.source !== signal.source)
            continue;
          try {
            void Promise.resolve(handler.run(signal)).catch((error) =>
              report(error, signal),
            );
          } catch (error) {
            report(error, signal);
          }
        }
      }
    } finally {
      draining = false;
    }
  }
  return {
    emit(name, payload, source, key = '') {
      safely(() => {
        queue.push({
          signal: {
            name,
            payload,
            source,
            key,
            at: Date.now(),
          } as AnySignal<C>,
        });
        drain();
      });
    },
    retire(source) {
      safely(() => {
        queue.push({ retire: source });
        drain();
      });
    },
    on(name, handler, filter) {
      const entry: Handler = {
        name,
        source: filter?.source,
        run: handler as (signal: AnySignal<C>) => void | Promise<void>,
      };
      handlers.add(entry);
      return () => {
        handlers.delete(entry);
      };
    },
    onAny(handler, filter) {
      const entry: Handler = { source: filter?.source, run: handler };
      handlers.add(entry);
      return () => {
        handlers.delete(entry);
      };
    },
    last<K extends SignalName<C>>(name: K, source: string, key = '') {
      return retained.get(source)?.get(JSON.stringify([name, key])) as
        | Signal<C, K>
        | undefined;
    },
    lastAll(source) {
      return [...(retained.get(source)?.values() ?? [])];
    },
  };
}
