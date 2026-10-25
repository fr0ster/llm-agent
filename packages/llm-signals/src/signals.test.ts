import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  combineEmitters,
  createSignalBus,
  filterEmitter,
  noopEmitter,
} from './index.js';

interface Catalog {
  state: { n: number; nested?: { value: number } };
  closed: Record<string, never>;
}
test('nested dispatch updates retention at dispatch, preserves order and retires at queue position', () => {
  const bus = createSignalBus<Catalog>();
  const order: string[] = [];
  bus.on('state', (signal) => {
    order.push(`first:${signal.payload.n}`);
    assert.equal(bus.last('state', 's', signal.key), signal);
    if (signal.payload.n === 1) {
      bus.emit('state', { n: 2 }, 's', 'b');
      assert.equal(bus.last('state', 's', 'b'), undefined);
      bus.emit('closed', {}, 's');
      bus.retire('s');
      bus.emit('state', { n: 3 }, 's', 'c');
      assert.equal(bus.last('state', 's', 'c'), undefined);
      order.push('nested returned');
    }
  });
  bus.onAny((signal) => {
    order.push(signal.name);
  });
  bus.on('closed', () =>
    assert.deepEqual(
      bus.lastAll('s').map((s) => s.key),
      ['a', 'b', ''],
    ),
  );
  bus.emit('state', { n: 1 }, 's', 'a');
  assert.deepEqual(order, [
    'first:1',
    'nested returned',
    'state',
    'first:2',
    'state',
    'closed',
    'first:3',
    'state',
  ]);
  assert.deepEqual(
    bus.lastAll('s').map((s) => s.key),
    ['c'],
  );
  bus.retire('s');
  assert.deepEqual(bus.lastAll('s'), []);
  bus.emit('state', { n: 4 }, 's');
  assert.equal(bus.last('state', 's')?.payload.n, 4);
});
test('keyed retention uses latest emission order and isolates sources', () => {
  const bus = createSignalBus<Catalog>();
  bus.emit('state', { n: 1 }, 's', 'a');
  bus.emit('state', { n: 2 }, 's', 'b');
  bus.emit('state', { n: 3 }, 's', 'a');
  bus.emit('state', { n: 4 }, 'other', 'a');
  assert.deepEqual(
    bus.lastAll('s').map((s) => s.payload),
    [{ n: 2 }, { n: 3 }],
  );
  assert.equal(bus.last('state', 's', 'b')?.payload.n, 2);
  const list = bus.lastAll('s');
  list.pop();
  assert.equal(bus.lastAll('s').length, 2);
});
test('freeze, source filters, unsubscribe and synchronous/asynchronous handler errors', async () => {
  const errors: unknown[] = [];
  const bus = createSignalBus<Catalog>({
    onHandlerError(error) {
      errors.push(error);
      throw Error('sink');
    },
  });
  let delivered = 0;
  const off = bus.onAny(
    () => {
      delivered++;
    },
    { source: 's' },
  );
  bus.on('state', () => {
    throw Error('sync');
  });
  bus.on('state', async () => {
    throw Error('async');
  });
  bus.on(
    'state',
    (s) => {
      assert.ok(Object.isFrozen(s.payload));
      assert.ok(Object.isFrozen(s.payload.nested));
      assert.equal(s.payload, bus.last('state', s.source)?.payload);
    },
    { source: 's' },
  );
  bus.emit('state', { n: 1, nested: { value: 2 } }, 's');
  off();
  bus.emit('state', { n: 2 }, 'other');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered, 1);
  assert.equal(errors.length, 4);
});
test('helpers isolate emitters and predicate failures; retirement always fans out', () => {
  const bus = createSignalBus<Catalog>();
  const combined = combineEmitters<Catalog>(
    {
      emit() {
        throw Error();
      },
      retire() {
        throw Error();
      },
    },
    bus,
    noopEmitter(),
  );
  const filtered = filterEmitter(
    combined,
    (name, source) => name === 'state' && source === 's',
  );
  filtered.emit('closed', {}, 's');
  filtered.emit('state', { n: 1 }, 'other');
  filtered.emit('state', { n: 2 }, 's');
  assert.equal(bus.lastAll('s').length, 1);
  assert.equal(bus.lastAll('other').length, 0);
  filtered.retire('s');
  assert.equal(bus.lastAll('s').length, 0);
  assert.doesNotThrow(() =>
    filterEmitter(combined, () => {
      throw Error();
    }).emit('closed', {}, 's'),
  );
});

test('unsubscribing a later handler skips it in the current dispatch', () => {
  const bus = createSignalBus<Catalog>();
  let calls = 0;
  let off = () => {};
  bus.onAny(() => off());
  off = bus.on('state', () => {
    calls++;
  });
  bus.emit('state', { n: 1 }, 's');
  assert.equal(calls, 0);
});

test('invalid payloads are reported without retention or dispatch', () => {
  for (const value of [new Map(), new Uint8Array([1]), new Date()]) {
    const errors: unknown[] = [];
    const bus = createSignalBus<{ data: unknown }>({
      onHandlerError(error, signal) {
        errors.push(error);
        assert.equal(signal.name, 'data');
        throw Error('sink');
      },
    });
    let calls = 0;
    bus.onAny(() => {
      calls++;
    });
    const valid = { nested: [{ value: 1, optional: undefined }, null, true] };
    bus.emit('data', valid, 's');
    assert.ok(Object.isFrozen(valid));
    assert.ok(Object.isFrozen(valid.nested));
    assert.ok(Object.isFrozen(valid.nested[0]));
    const retained = bus.last('data', 's');
    assert.doesNotThrow(() => bus.emit('data', { nested: [value] }, 's'));
    assert.equal(calls, 1);
    assert.equal(bus.last('data', 's'), retained);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof TypeError);
    assert.match(errors[0].message, /data.*payload\["nested"\]\["0"\]/);
  }
});

test('plain data from another realm is accepted, class instances from it are not', async () => {
  const { runInNewContext } = await import('node:vm');
  const errors: unknown[] = [];
  const bus = createSignalBus<Catalog>({
    onHandlerError: (error) => errors.push(error),
  });
  const seen: number[] = [];
  bus.on('state', (s) => {
    seen.push(s.payload.n);
  });
  const foreign = runInNewContext(
    '({ n: 7, nested: { value: 1 } })',
  ) as Catalog['state'];
  bus.emit('state', foreign, 'src');
  assert.deepEqual(seen, [7]);
  assert.equal(bus.last('state', 'src')?.payload.nested?.value, 1);
  const instance = runInNewContext(
    'new (class Foo { constructor() { this.n = 1; } })()',
  ) as Catalog['state'];
  bus.emit('state', instance, 'src');
  assert.deepEqual(seen, [7]);
  assert.equal(errors.length, 1);
});

test('null-base class instances and tag getters are rejected without running accessors', () => {
  const errors: unknown[] = [];
  const bus = createSignalBus<Catalog>({
    onHandlerError: (e) => errors.push(e),
  });
  const seen: number[] = [];
  bus.on('state', (s) => {
    seen.push(s.payload.n);
  });
  // The shape `class X extends null` produces: a prototype with a null
  // prototype whose constructor is not Object.
  function NullBase() {}
  NullBase.prototype = Object.create(null, {
    constructor: { value: NullBase },
  });
  const nullBase = Object.create(NullBase.prototype) as Catalog['state'];
  Object.defineProperty(nullBase, 'n', { value: 1, enumerable: true });
  bus.emit('state', nullBase, 'src');
  let getterRan = false;
  const tagged = { n: 2 };
  Object.defineProperty(tagged, Symbol.toStringTag, {
    get() {
      getterRan = true;
      return 'Object';
    },
  });
  bus.emit('state', tagged as Catalog['state'], 'src');
  assert.deepEqual(seen, []);
  assert.equal(getterRan, false);
  assert.equal(errors.length, 2);
});

test('a null-base class named Object is rejected', async () => {
  const { runInNewContext } = await import('node:vm');
  const errors: unknown[] = [];
  const bus = createSignalBus<Catalog>({
    onHandlerError: (e) => errors.push(e),
  });
  const seen: number[] = [];
  bus.on('state', (s) => {
    seen.push(s.payload.n);
  });
  const forged = runInNewContext(
    'const Object = function Object() {}; Object.prototype = globalThis.Object.create(null, { constructor: { value: Object } }); const v = globalThis.Object.create(Object.prototype); v.n = 3; v',
  ) as Catalog['state'];
  bus.emit('state', forged, 'src');
  assert.deepEqual(seen, []);
  assert.equal(errors.length, 1);
});
