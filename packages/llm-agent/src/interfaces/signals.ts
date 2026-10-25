/** A catalog is any object type mapping signal names to payload types; interfaces work, no index signature needed. */
export type SignalName<C extends object> = Extract<keyof C, string>;

export interface Signal<C extends object, K extends SignalName<C>> {
  name: K;
  payload: Readonly<C[K]>;
  /** Producer instance, e.g. the dialogue session id. */
  source: string;
  /** Entity within the source for retention, e.g. a task id; '' when the signal is about the source itself. */
  key: string;
  /** Emission time, ms since epoch. */
  at: number;
}
/** Any signal of the catalog, as a discriminated union on `name` (narrowing `name` narrows `payload`). */
export type AnySignal<C extends object> = {
  [K in SignalName<C>]: Signal<C, K>;
}[SignalName<C>];

export type Unsubscribe = () => void;

/** Producer side: the only thing a producer depends on. */
export interface ISignalEmitter<C extends object> {
  /** Payloads are plain data: plain objects, arrays, string/number/boolean/null/undefined. */
  emit<K extends SignalName<C>>(
    name: K,
    payload: C[K],
    source: string,
    key?: string,
  ): void;
  /** The producer instance has ended. */
  retire(source: string): void;
}

/** Consumer side. */
export interface ISignalSubscriber<C extends object> {
  on<K extends SignalName<C>>(
    name: K,
    handler: (s: Signal<C, K>) => void | Promise<void>,
    filter?: { source?: string },
  ): Unsubscribe;
  /** Wildcard handlers must ignore names they do not know: new names are added within a major. */
  onAny(
    handler: (s: AnySignal<C>) => void | Promise<void>,
    filter?: { source?: string },
  ): Unsubscribe;
  /** The latest retained signal for (name, source, key). */
  last<K extends SignalName<C>>(
    name: K,
    source: string,
    key?: string,
  ): Signal<C, K> | undefined;
  /** Every retained signal of the source, one per (name, key), in emission order. */
  lastAll(source: string): AnySignal<C>[];
}

export interface ISignalBus<C extends object>
  extends ISignalEmitter<C>,
    ISignalSubscriber<C> {}

/** Compile-time guard: resolves to `never` when two catalogs share a name. */
export type DisjointCatalogs<A extends object, B extends object> =
  Extract<keyof A, keyof B> extends never ? A & B : never;
