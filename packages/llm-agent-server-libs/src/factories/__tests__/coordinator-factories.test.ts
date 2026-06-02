import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DagFactory } from '../dag-factory.js';
import { LinearFactory } from '../linear-factory.js';

test('DagFactory: kind=dag', () => assert.equal(new DagFactory().kind, 'dag'));
test('LinearFactory: kind=linear', () =>
  assert.equal(new LinearFactory().kind, 'linear'));
