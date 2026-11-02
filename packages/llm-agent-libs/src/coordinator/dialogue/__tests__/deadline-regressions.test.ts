import assert from 'node:assert/strict';
import { test } from 'node:test';
import { optionalDeadlineMs } from '../../optional-deadline.js';
import { DIALOGUE_COORDINATOR_SYSTEM } from '../coordinator-prompt.js';
import {
  composePlannerPrompt,
  DIALOGUE_PLANNER_SYSTEM,
} from '../planner-prompt.js';
import { withDeadline } from '../planner-retrieval.js';
import { ProfileResolver } from '../profile-resolver.js';
import { profileHost } from './profile-test-host.js';

for (const value of [NaN, -1, 0, 1.5, Infinity, 2_147_483_648]) {
  test(`invalid deadline ${value} never aborts pending work`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal(optionalDeadlineMs(value), undefined);
    let release = () => {};
    const pending = withDeadline(async (signal) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      assert.equal(signal.aborted, false);
      return 'done';
    }, value);
    await Promise.resolve();
    context.mock.timers.tick(3_000_000_000);
    release();
    assert.equal(await pending, 'done');
  });
}

for (const value of [1.5, 2_147_483_648]) {
  test(`profile deadline ${value} is absent`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const resolver = new ProfileResolver(
      profileHost(new Map()).profileSource,
      value,
    );
    let release = () => {};
    const pending = resolver.call(async ({ signal }) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      assert.equal(signal?.aborted, false);
      return { ok: true, value: 'done' };
    });
    await Promise.resolve();
    context.mock.timers.tick(3_000_000_000);
    release();
    assert.equal(await pending, 'done');
  });
}

for (const value of [NaN, -1, 0, Infinity]) {
  test(`profile deadline ${value} preserves documented validation error`, () => {
    assert.throws(
      () => new ProfileResolver(profileHost(new Map()).profileSource, value),
      /must be positive/,
    );
  });
}

test('valid deadlines still expire', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(optionalDeadlineMs(2_147_483_647), 2_147_483_647);
  const operation = withDeadline(() => new Promise<never>(() => {}), 5);
  const resolver = new ProfileResolver(profileHost(new Map()).profileSource, 5);
  const profile = resolver.call(() => new Promise<never>(() => {}));
  const checks = [
    assert.rejects(operation, /timed out/),
    assert.rejects(profile, /deadline/),
  ];
  context.mock.timers.tick(5);
  await Promise.all(checks);
});

for (const prompt of [
  DIALOGUE_PLANNER_SYSTEM,
  DIALOGUE_COORDINATOR_SYSTEM,
  'Host supplied prompt',
]) {
  test(`shared supervision guidance for ${prompt.slice(0, 30)}`, () => {
    const composed = composePlannerPrompt(prompt);
    assert.equal(
      composed.split('When a task event reports no activity').length,
      2,
    );
    assert.match(
      composed,
      /known long operation or stop_task and delegate_task again/,
    );
    assert.match(composed, /another worker\/model/);
    assert.match(composed, /Tell the user briefly/);
    assert.equal(composePlannerPrompt(composed), composed);
  });
}
