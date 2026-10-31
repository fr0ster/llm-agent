import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AgentPrompts,
  DialoguePlan,
  IAgentProfileRunner,
  ISmartAgent,
  WorkerProfile,
} from '@mcp-abap-adt/llm-agent';
import { PLAN_CREATE_SYSTEM } from '../plan-author-prompt.js';
import { ProfilePlanAuthor } from '../profile-plan-author.js';
import { profileHost } from './profile-test-host.js';

function fixture(output: string, prompts: AgentPrompts = {}) {
  const host = profileHost(new Map());
  const profiles: WorkerProfile[] = ['executor', 'reviewer'].map((name) => ({
    name,
    description: name,
    result: name === 'reviewer' ? 'verdict' : 'report',
    systemPrompt: '',
    tools: 'all',
  }));
  host.profileSource.list = async () => ({ ok: true, value: profiles });
  host.profileSource.get = async (name) => {
    const profile = profiles.find((profile) => profile.name === name);
    return profile
      ? { ok: true, value: profile }
      : { ok: false, error: { code: 'missing', message: name } };
  };
  const calls: { systemPrompt: string; mode: 'create' | 'revise' }[] = [];
  const agent: ISmartAgent = {
    async process() {
      return {
        ok: true,
        value: {
          content: output,
          iterations: 1,
          toolCallCount: 0,
          stopReason: 'stop',
        },
      };
    },
    async *streamProcess() {},
  };
  host.profileSource.getPrompts = async () => ({ ok: true, value: prompts });
  host.profileRunner.preparePlanAuthor = async (input) => {
    calls.push(input);
    return { ok: true, value: agent };
  };
  return {
    author: new ProfilePlanAuthor({
      source: host.profileSource,
      runner: host.profileRunner,
    }),
    calls,
    source: host.profileSource,
  };
}
const output = '{"steps":[{"id":"s1","goal":"read","worker":"executor"}]}';
for (const mode of ['create', 'revise'] as const) {
  test(`${mode} is unavailable when the runner cannot prepare a plan author`, async () => {
    const host = profileHost(new Map());
    const runner: IAgentProfileRunner = {
      createWorker: host.profileRunner.createWorker,
      preparePlanner: host.profileRunner.preparePlanner,
    };
    const author = new ProfilePlanAuthor({
      source: host.profileSource,
      runner,
    });
    const result =
      mode === 'create'
        ? await author.create({ goal: 'read' })
        : await author.revise({
            plan: { version: 1, status: 'active', steps: [] },
            change: 'read',
          });
    assert.deepEqual(result, {
      ok: false,
      error: {
        code: 'unavailable',
        message: 'profile runner cannot prepare a plan author',
      },
    });
  });
}

for (const change of ['skip', 'remove', 'reduce items'] as const) {
  for (const consent of [true, undefined]) {
    test(`revise ${change} ${consent ? 'uses recorded consent' : 'requires consent'}`, async () => {
      const plan: DialoguePlan = {
        version: 1,
        status: 'active',
        scopeConsent: consent,
        steps: [
          {
            id: 's1',
            goal: 'read',
            worker: 'executor',
            state: 'pending',
            taskIds: [],
            items: ['one', 'two'],
          },
        ],
      };
      const snapshot = structuredClone(plan);
      const steps =
        change === 'remove'
          ? []
          : [
              {
                ...plan.steps[0],
                ...(change === 'skip'
                  ? { state: 'skipped', note: 'User approved skipping' }
                  : { items: ['one'] }),
              },
            ];
      const result = await fixture(JSON.stringify({ steps })).author.revise({
        plan,
        change,
      });
      if (consent) {
        assert.ok(result.ok);
        if (change === 'remove') assert.deepEqual(result.value.steps, []);
        else if (change === 'skip')
          assert.equal(result.value.steps[0].state, 'skipped');
        else assert.deepEqual(result.value.steps[0].items, ['one']);
      } else {
        assert.ok(!result.ok);
        assert.equal(result.error.code, 'invalid');
        assert.match(result.error.message, /requires user consent/);
      }
      assert.deepEqual(plan, snapshot);
    });
  }
}

test('create returns a plan parsed from the author JSON', async () => {
  const result = await fixture(output).author.create({ goal: 'read' });
  assert.ok(result.ok);
  assert.equal(result.value.steps[0].state, 'pending');
});
test('create uses the plannerCreate prompt when the source has one', async () => {
  const { author, calls } = fixture(output, { plannerCreate: '<custom>' });
  await author.create({ goal: 'read' });
  assert.deepEqual(calls, [{ mode: 'create', systemPrompt: '<custom>' }]);
});
test('create falls back to PLAN_CREATE_SYSTEM', async () => {
  const { author, calls } = fixture(output);
  await author.create({ goal: 'read' });
  assert.equal(calls[0].systemPrompt, PLAN_CREATE_SYSTEM);
});
test('invalid JSON is an invalid error', async () => {
  const result = await fixture('not json').author.create({ goal: 'read' });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'invalid');
});
test('revise keeps done steps', async () => {
  const { author } = fixture(
    '{"steps":[{"id":"s1","goal":"read","state":"pending"},{"id":"s2","goal":"write"}]}',
  );
  const result = await author.revise({
    plan: {
      version: 1,
      status: 'active',
      steps: [
        {
          id: 's1',
          goal: 'read',
          state: 'done',
          taskIds: ['t1'],
          successfulWorkTaskId: 't1',
        },
      ],
    },
    change: 'add write',
  });
  assert.ok(result.ok);
  assert.equal(result.value.steps[0].state, 'done');
  assert.deepEqual(result.value.steps[0].taskIds, ['t1']);
  assert.equal(result.value.steps[0].successfulWorkTaskId, 't1');
  assert.equal(result.value.steps[1].state, 'pending');
});
test('aborted signal yields aborted', async () => {
  const result = await fixture(output).author.create(
    { goal: 'read' },
    { signal: AbortSignal.abort() },
  );
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'aborted');
});

for (const invalid of [
  '{"steps":[{"id":"s1"}]}',
  '{"steps":[],"status":"waiting_user"}',
  '{"steps":[],"status":"bogus"}',
]) {
  test(`schema-invalid author output is invalid: ${invalid}`, async () => {
    const result = await fixture(invalid).author.create({ goal: 'read' });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'invalid');
  });
}
test('revise preserves omitted done steps', async () => {
  const plan: DialoguePlan = {
    version: 1 as const,
    status: 'active' as const,
    steps: [
      {
        id: 's1',
        goal: 'read',
        state: 'done' as const,
        taskIds: ['t1'],
        successfulWorkTaskId: 't1',
      },
      {
        id: 's2',
        goal: 'write',
        state: 'pending',
        dependsOn: ['s1'],
        taskIds: [],
      },
    ],
  };
  const snapshot = structuredClone(plan);
  const result = await fixture(
    '{"steps":[{"id":"s2","goal":"write","dependsOn":["s1"]}]}',
  ).author.revise({ plan, change: 'add write' });
  assert.ok(result.ok);
  assert.deepEqual(
    result.value.steps.find((step) => step.id === 's1')?.taskIds,
    ['t1'],
  );
  assert.deepEqual(
    result.value.steps.map((step) => step.id),
    ['s1', 's2'],
  );
  assert.deepEqual(plan, snapshot);
});
test('profile runner failure is unavailable', async () => {
  const host = profileHost(new Map());
  const author = new ProfilePlanAuthor({
    source: host.profileSource,
    runner: host.profileRunner,
  });
  const result = await author.create({ goal: 'read' });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'unavailable');
});

test('revise uses plannerRevise independently of plannerCreate', async () => {
  const { author, calls } = fixture(output, {
    plannerCreate: 'create only',
    plannerRevise: 'revise only',
  });
  const result = await author.revise({
    plan: { version: 1, status: 'active', steps: [] },
    change: 'read',
  });
  assert.ok(result.ok);
  assert.deepEqual(calls, [{ mode: 'revise', systemPrompt: 'revise only' }]);
});

for (const wrapped of [
  `\`\`\`json\n${output}\n\`\`\``,
  `\`\`\`\n${output}\n\`\`\``,
  `Here is the plan: ${output}`,
  `${output} This is the plan.`,
  `Plan: ${output} Ready.`,
  '{"steps":[{"id":"s1","goal":"read {nested} and \\"quoted\\" text"}]}',
]) {
  test(`accepts one wrapped JSON object: ${wrapped}`, async () => {
    const result = await fixture(wrapped).author.create({ goal: 'read' });
    assert.ok(result.ok);
  });
}

for (const invalid of [
  '{"steps": [}',
  '{"steps":[]',
  '{"steps":[],}',
  `${output} ${output}`,
  `[${output}]`,
]) {
  test(`rejects malformed or ambiguous JSON: ${invalid}`, async () => {
    const result = await fixture(invalid).author.create({ goal: 'read' });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'invalid');
  });
}

test('unchanged revision preserves a done custom verdict step', async () => {
  const plan: DialoguePlan = {
    version: 1,
    status: 'active',
    steps: [
      {
        id: 'review',
        goal: 'Review',
        worker: 'reviewer',
        result: 'verdict',
        state: 'done',
        taskIds: ['review-task'],
      },
    ],
  };
  const result = await fixture(
    JSON.stringify({ steps: plan.steps }),
  ).author.revise({
    plan,
    change: 'Keep the plan unchanged',
  });
  assert.ok(result.ok);
  assert.equal(result.value.steps[0].result, 'verdict');
  assert.equal(result.value.steps[0].state, 'done');
});

for (const mode of ['create', 'revise'] as const) {
  test(`${mode} resolves a new custom verdict step from the profile source`, async () => {
    const { author } = fixture(
      JSON.stringify({
        steps: [{ id: 'review', goal: 'Review', worker: 'reviewer' }],
      }),
    );
    const result =
      mode === 'create'
        ? await author.create({ goal: 'Review' })
        : await author.revise({
            plan: { version: 1, status: 'active', steps: [] },
            change: 'Add review',
          });
    assert.ok(result.ok);
    assert.equal(result.value.steps[0].result, 'verdict');
  });

  test(`${mode} rejects an unknown worker through profile selection`, async () => {
    const { author } = fixture(
      JSON.stringify({
        steps: [{ id: 'unknown', goal: 'Review', worker: 'unknown' }],
      }),
    );
    const result =
      mode === 'create'
        ? await author.create({ goal: 'Review' })
        : await author.revise({
            plan: { version: 1, status: 'active', steps: [] },
            change: 'Add review',
          });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'invalid');
    assert.equal(result.error.message, 'profile source missing: unknown');
  });
}

test('done step result wins while a new step uses the current profile result', async () => {
  const plan: DialoguePlan = {
    version: 1,
    status: 'active',
    steps: [
      {
        id: 'old',
        goal: 'Old review',
        worker: 'reviewer',
        result: 'report',
        state: 'done',
        taskIds: ['old-task'],
      },
    ],
  };
  const result = await fixture(
    JSON.stringify({
      steps: [{ id: 'new', goal: 'New review', worker: 'reviewer' }],
    }),
  ).author.revise({ plan, change: 'Add review' });
  assert.ok(result.ok);
  assert.equal(
    result.value.steps.find((step) => step.id === 'old')?.result,
    'report',
  );
  assert.equal(
    result.value.steps.find((step) => step.id === 'old')?.state,
    'done',
  );
  assert.equal(
    result.value.steps.find((step) => step.id === 'new')?.result,
    'verdict',
  );
});

test('profile lookup outage after valid author JSON is unavailable', async () => {
  const { author, source } = fixture(
    '{"steps":[{"id":"s1","goal":"review","worker":"reviewer"}]}',
  );
  source.list = async () => ({
    ok: false,
    error: { code: 'unavailable', message: 'store down' },
  });
  const result = await author.create({ goal: 'review' });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'unavailable');
});

test('unknown worker after valid author JSON stays invalid', async () => {
  const { author } = fixture(
    '{"steps":[{"id":"s1","goal":"x","worker":"ghost"}]}',
  );
  const result = await author.create({ goal: 'x' });
  assert.ok(!result.ok);
  assert.equal(result.error.code, 'invalid');
});
