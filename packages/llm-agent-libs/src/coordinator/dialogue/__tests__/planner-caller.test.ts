import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallOptions,
  ISmartAgent,
  RagCaller,
} from '@mcp-abap-adt/llm-agent';
import { DialogueSession } from '../dialogue-session.js';
import { PlannerToolsClient } from '../planner-tools-client.js';
import { ProfilePlanAuthor } from '../profile-plan-author.js';
import { profileHost } from './profile-test-host.js';

const caller: RagCaller = {
  sessionId: 'planner-caller',
  userId: 'user',
  isAdmin: false,
};

for (const dispatch of ['external', 'turn'] as const) {
  test(`${dispatch}: plan_create and plan_revise preserve the trusted caller through the author agent`, async () => {
    const seen: (CallOptions | undefined)[] = [];
    const host = profileHost(new Map());
    const agent: ISmartAgent = {
      async process(_messages, options) {
        seen.push(options);
        return {
          ok: true,
          value: {
            content:
              '{"steps":[{"id":"work","goal":"Read","result":"report"}]}',
            iterations: 1,
            toolCallCount: 0,
            stopReason: 'stop',
          },
        };
      },
      async *streamProcess() {},
    };
    host.profileRunner.preparePlanAuthor = async () => ({
      ok: true,
      value: agent,
    });
    const tools = new PlannerToolsClient();
    host.profileRunner.preparePlanner = async () => ({
      ok: true,
      value: {
        async process() {
          await invoke((name, args) => tools.callTool(name, args));
          return {
            ok: true,
            value: {
              content: 'Ready',
              iterations: 1,
              toolCallCount: 2,
              stopReason: 'stop',
            },
          };
        },
        async *streamProcess() {},
      },
    });
    const session = await DialogueSession.open({
      id: caller.sessionId,
      caller,
      board: {},
      ...host,
      maxCorrections: 0,
      planAuthor: new ProfilePlanAuthor({
        source: host.profileSource,
        runner: host.profileRunner,
      }),
    });
    async function invoke(call: PlannerToolsClient['callTool']) {
      for (const [name, args] of [
        ['plan_create', { goal: 'Read' }],
        ['plan_revise', { change: 'Keep the plan' }],
      ] satisfies [string, Record<string, string>][]) {
        const result = await call(name, args);
        assert.ok(result.ok);
        assert.ok(!result.value.isError, JSON.stringify(result.value));
      }
    }
    try {
      if (dispatch === 'external')
        await invoke((name, args) => session.callTool(name, args));
      else await session.send('Read', { caller });
      assert.equal(seen.length, 2);
      for (const options of seen) {
        assert.strictEqual(options?.caller, caller);
        assert.equal(options?.sessionId, caller.sessionId);
      }
    } finally {
      await session.close();
    }
  });
}

for (const replacement of [{ ...caller }, { ...caller, sessionId: 'other' }]) {
  test(`send refuses a different caller object with session ${replacement.sessionId}`, async () => {
    let calls = 0;
    const session = await DialogueSession.open({
      id: caller.sessionId,
      caller,
      board: {},
      planner: {
        async process() {
          calls++;
          return { ok: true, value: { content: 'Ready' } };
        },
      },
    });
    try {
      const refused = await session.callTool(
        'plan_create',
        { goal: 'Read' },
        { caller: replacement },
      );
      assert.ok(refused.ok);
      assert.equal(refused.value.isError, true);
      assert.match(
        JSON.stringify(refused.value),
        /Caller does not match dialogue session/,
      );
      await assert.rejects(
        session.send('Read', { caller: replacement }),
        /Caller does not match dialogue session/,
      );
      assert.equal(calls, 0);
      await session.send('Read', { caller });
      assert.equal(calls, 1);
    } finally {
      await session.close();
    }
  });
}

test('open refuses a trusted caller belonging to a different session', async () => {
  await assert.rejects(
    DialogueSession.open({ id: 'other', caller, board: {} }),
    /Caller does not match dialogue session/,
  );
});
