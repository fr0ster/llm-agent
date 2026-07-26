import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attachSseKeepAlive, createIdleHeartbeat } from './sse-heartbeat.js';

/** A manual scheduler: records the pending callback so the test fires it. */
function manualClock() {
  let pending: { cb: () => void; ms: number } | undefined;
  return {
    schedule: (cb: () => void, ms: number) => {
      pending = { cb, ms };
      return pending;
    },
    cancel: (_h: unknown) => {
      pending = undefined;
    },
    /** Fire the currently-armed timer, if any. */
    tick() {
      const p = pending;
      pending = undefined;
      p?.cb();
    },
    get armed() {
      return pending !== undefined;
    },
  };
}

describe('createIdleHeartbeat', () => {
  it('beats after one idle interval, and repeats', () => {
    const clock = manualClock();
    let beats = 0;
    createIdleHeartbeat({
      intervalMs: 100,
      onBeat: () => beats++,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    clock.tick();
    assert.equal(beats, 1);
    clock.tick(); // re-armed
    assert.equal(beats, 2);
  });

  it('reset() before the interval cancels the pending beat and re-arms', () => {
    const clock = manualClock();
    let beats = 0;
    const hb = createIdleHeartbeat({
      intervalMs: 100,
      onBeat: () => beats++,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    hb.reset();
    clock.tick();
    assert.equal(beats, 1, 'still armed after reset');
  });

  it('stop() prevents further beats and is idempotent', () => {
    const clock = manualClock();
    let beats = 0;
    const hb = createIdleHeartbeat({
      intervalMs: 100,
      onBeat: () => beats++,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    hb.stop();
    hb.stop();
    assert.equal(clock.armed, false);
    hb.reset(); // no-op after stop
    assert.equal(clock.armed, false);
    clock.tick();
    assert.equal(beats, 0);
  });

  it('stop() called synchronously DURING onBeat does not re-arm', () => {
    const clock = manualClock();
    let beats = 0;
    let hb: import('./sse-heartbeat.js').IdleHeartbeat;
    hb = createIdleHeartbeat({
      intervalMs: 100,
      onBeat: () => {
        beats++;
        hb.stop(); // e.g. res 'close' fires while we write the beat
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    clock.tick(); // fires onBeat → beats=1 → stop()
    assert.equal(beats, 1);
    assert.equal(clock.armed, false, 'must NOT re-arm after stop during beat');
    clock.tick(); // nothing armed → no further beat
    assert.equal(beats, 1);
  });

  it('disabled intervals never arm a timer: 0, negative, NaN, ±Infinity, and via undefined→default it DOES arm', () => {
    for (const bad of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const clock = manualClock();
      let beats = 0;
      const hb = createIdleHeartbeat({
        intervalMs: bad,
        onBeat: () => beats++,
        schedule: clock.schedule,
        cancel: clock.cancel,
      });
      assert.equal(clock.armed, false, `interval ${bad} must not arm`);
      hb.reset();
      clock.tick();
      assert.equal(beats, 0, `interval ${bad} must never beat`);
    }
    // undefined → normalized to 5000 → armed
    const clock = manualClock();
    createIdleHeartbeat({
      intervalMs: undefined,
      onBeat: () => {},
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    assert.equal(clock.armed, true, 'undefined → default → armed');
  });
});

describe('attachSseKeepAlive', () => {
  function fakeRes() {
    const writes: string[] = [];
    const listeners: Record<string, () => void> = {};
    const res = {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
      on: (ev: string, cb: () => void) => {
        listeners[ev] = cb;
      },
    } as unknown as import('node:http').ServerResponse;
    return { res, writes, listeners };
  }

  it('registers a res "close" handler', () => {
    const { res, listeners } = fakeRes();
    const hb = attachSseKeepAlive(res, 100);
    try {
      assert.equal(typeof listeners.close, 'function');
    } finally {
      hb.stop(); // stop even if the assertion throws — the heartbeat re-arms setTimeout
    }
  });

  it('after res close during idle, NO further keep-alive is written (real timer)', async () => {
    // Behavioral proof of the attach → close → stop composition: with a 20ms
    // interval, fire "close" before the first beat, then wait > 3 intervals and
    // assert zero keep-alive writes. A broken close→stop wiring would let the
    // watchdog keep firing.
    const { res, writes, listeners } = fakeRes();
    attachSseKeepAlive(res, 20);
    listeners.close(); // client disconnects before any beat
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      writes.filter((w) => w.startsWith(': keep-alive')).length,
      0,
      'no keep-alive after close',
    );
  });

  it('writes ": keep-alive" while idle when NOT closed (real timer, control)', async () => {
    const { res, writes } = fakeRes();
    const hb = attachSseKeepAlive(res, 20);
    await new Promise((r) => setTimeout(r, 50));
    hb.stop();
    assert.ok(
      writes.filter((w) => w.startsWith(': keep-alive')).length >= 1,
      'the control case DOES beat, proving the close test above is meaningful',
    );
  });
});
