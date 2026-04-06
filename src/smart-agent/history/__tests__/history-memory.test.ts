import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HistoryMemory } from '../history-memory.js';

describe('HistoryMemory', () => {
  it('returns empty array for unknown session', () => {
    const mem = new HistoryMemory();
    assert.deepEqual(mem.getRecent('s1', 3), []);
  });

  it('stores and retrieves entries in order', () => {
    const mem = new HistoryMemory();
    mem.pushRecent('s1', 'Created class ZCL_A');
    mem.pushRecent('s1', 'Added method GET_DATA');
    assert.deepEqual(mem.getRecent('s1', 3), [
      'Created class ZCL_A',
      'Added method GET_DATA',
    ]);
  });

  it('evicts oldest when exceeding max size', () => {
    const mem = new HistoryMemory({ maxSize: 2 });
    mem.pushRecent('s1', 'turn1');
    mem.pushRecent('s1', 'turn2');
    mem.pushRecent('s1', 'turn3');
    assert.deepEqual(mem.getRecent('s1', 10), ['turn2', 'turn3']);
  });

  it('isolates sessions', () => {
    const mem = new HistoryMemory();
    mem.pushRecent('s1', 'session1-action');
    mem.pushRecent('s2', 'session2-action');
    assert.deepEqual(mem.getRecent('s1', 10), ['session1-action']);
    assert.deepEqual(mem.getRecent('s2', 10), ['session2-action']);
  });

  it('respects limit parameter', () => {
    const mem = new HistoryMemory();
    mem.pushRecent('s1', 'a');
    mem.pushRecent('s1', 'b');
    mem.pushRecent('s1', 'c');
    assert.deepEqual(mem.getRecent('s1', 2), ['b', 'c']);
  });

  it('clears session entries', () => {
    const mem = new HistoryMemory();
    mem.pushRecent('s1', 'action');
    mem.clear('s1');
    assert.deepEqual(mem.getRecent('s1', 10), []);
  });
});
