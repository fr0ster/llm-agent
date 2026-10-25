import type {
  AnySignal,
  DisjointCatalogs,
  ISignalEmitter,
} from '../signals.js';

interface First {
  first: { value: number };
}
interface Second {
  second: { text: string };
}
declare const emitter: ISignalEmitter<First & Second>;
emitter.emit('first', { value: 1 }, 's');
emitter.emit('second', { text: 'ok' }, 's');
// @ts-expect-error Payload must match the name.
emitter.emit('first', { text: 'wrong' }, 's');
// @ts-expect-error Unknown names cannot be emitted.
emitter.emit('unknown', {}, 's');
declare const signal: AnySignal<First & Second>;
if (signal.name === 'first') {
  const value: number = signal.payload.value;
  void value;
  // @ts-expect-error Narrowing excludes other payloads.
  signal.payload.text;
}
export const merged: DisjointCatalogs<First, Second> = {
  first: { value: 1 },
  second: { text: 'ok' },
};
// @ts-expect-error Shared names resolve to never.
export const collision: DisjointCatalogs<First, First> = {
  first: { value: 1 },
};
