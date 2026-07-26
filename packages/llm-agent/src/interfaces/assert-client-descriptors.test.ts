import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClientDescriptors } from './assert-client-descriptors.js';
import type { IMcpClient } from './mcp-client.js';

const c = () => ({}) as IMcpClient;
describe('assertClientDescriptors', () => {
  it('no-op when descriptors absent', () => {
    assert.doesNotThrow(() => assertClientDescriptors([c(), c()], undefined));
  });
  it('ok for aligned, unique, in-bounds descriptors', () => {
    assert.doesNotThrow(() =>
      assertClientDescriptors(
        [c(), c()],
        [{ slotIndex: 0 }, { slotIndex: 2 }],
        3,
      ),
    );
  });
  it('throws on length mismatch', () => {
    assert.throws(
      () =>
        assertClientDescriptors([c()], [{ slotIndex: 0 }, { slotIndex: 1 }]),
      /length/,
    );
  });
  it('throws on duplicate slotIndex', () => {
    assert.throws(
      () =>
        assertClientDescriptors(
          [c(), c()],
          [{ slotIndex: 1 }, { slotIndex: 1 }],
        ),
      /duplicate/,
    );
  });
  it('throws when configuredSlotCount <= max slotIndex', () => {
    assert.throws(
      () => assertClientDescriptors([c()], [{ slotIndex: 2 }], 2),
      /configuredSlotCount/,
    );
  });
  it('rejects negative, fractional, or NaN slotIndex / configuredSlotCount', () => {
    assert.throws(
      () => assertClientDescriptors([c()], [{ slotIndex: -1 }]),
      /non-negative integer/,
    );
    assert.throws(
      () => assertClientDescriptors([c()], [{ slotIndex: 1.5 }]),
      /non-negative integer/,
    );
    assert.throws(
      () => assertClientDescriptors([c()], [{ slotIndex: Number.NaN }]),
      /non-negative integer/,
    );
    assert.throws(
      () => assertClientDescriptors([c()], [{ slotIndex: 0 }], -1),
      /non-negative integer/,
    );
    assert.throws(
      () => assertClientDescriptors([c()], [{ slotIndex: 0 }], Number.NaN),
      /non-negative integer/,
    );
  });
});
