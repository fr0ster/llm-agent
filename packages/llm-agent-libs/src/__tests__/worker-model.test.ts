import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IAgentProfileRunner, ISubAgent } from '@mcp-abap-adt/llm-agent';
import { profileHost } from '../coordinator/dialogue/__tests__/profile-test-host.js';
import { runInPlannerScope } from '../coordinator/dialogue/planner-scope.js';
import { PlannerToolsClient } from '../coordinator/dialogue/planner-tools-client.js';
import { TaskBoard } from '../coordinator/dialogue/task-board.js';
import { scanDirsForSkills } from '../skills/skill-utils.js';

for (const model of ['m2', undefined, 'blocked']) {
  test(`delegate_task model: ${model}`, async () => {
    const worker: ISubAgent = {
      name: 'worker',
      capabilities: { contextPolicy: 'optional' },
      async run() {
        return { output: 'done' };
      },
    };
    const host = profileHost(new Map([['worker', worker]]));
    const inputs: Parameters<IAgentProfileRunner['createWorker']>[0][] = [];
    const validated: string[] = [];
    const board: TaskBoard = new TaskBoard({
      ...host,
      profileRunner: {
        ...host.profileRunner,
        validateModel(value) {
          validated.push(value);
          assert.equal(board.list().length, 0);
          return value === 'blocked'
            ? {
                ok: false,
                error: { code: 'MODEL_NOT_ALLOWED', message: value },
              }
            : { ok: true, value: undefined };
        },
        async createWorker(input) {
          inputs.push(input);
          return { ok: true, value: worker };
        },
      },
      onEvent() {},
    });
    try {
      await runInPlannerScope(
        { board, getPlan: () => undefined, setPlan() {} },
        async () => {
          const tools = new PlannerToolsClient();
          const definitions = await tools.listTools();
          assert.ok(definitions.ok);
          assert.match(
            JSON.stringify(
              definitions.value.find((t) => t.name === 'delegate_task')
                ?.inputSchema,
            ),
            /"model"/,
          );
          const result = await tools.callTool('delegate_task', {
            worker: 'worker',
            goal: 'go',
            ...(model === undefined ? {} : { model }),
          });
          assert.ok(result.ok);
          if (model === 'blocked') {
            assert.equal(result.value.isError, true);
            assert.match(
              JSON.stringify(result.value.content),
              /MODEL_NOT_ALLOWED/,
            );
            assert.deepEqual(board.list(), []);
            assert.deepEqual(inputs, []);
          } else {
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(board.list()[0]?.model, model);
            assert.equal(inputs.length, 1);
            assert.equal(inputs[0]?.model, model);
            if (model === undefined)
              assert.equal(Object.hasOwn(inputs[0] ?? {}, 'model'), false);
          }
          assert.deepEqual(validated, model === undefined ? [] : [model]);
        },
      );
    } finally {
      await board.stopAll();
    }
  });
}

for (const explicitIds of [false, true]) {
  for (const differentKinds of [false, true]) {
    test(`skill identity survives shared display names: ids=${explicitIds}, kinds=${differentKinds}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'worker-skills-'));
      try {
        for (const [index, dir] of ['first', 'second'].entries()) {
          await mkdir(join(root, dir));
          await writeFile(
            join(root, dir, 'SKILL.md'),
            [
              '---',
              'name: Shared',
              'description: Test',
              ...(explicitIds ? [`id: id-${dir}`] : []),
              `kind: ${differentKinds && index === 1 ? 'profile' : 'skill'}`,
              '---',
              dir,
            ].join('\n'),
          );
        }
        assert.equal((await scanDirsForSkills([root])).length, 2);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test('duplicate skill identity keeps the first and warns', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'worker-skills-'));
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  try {
    const dirs = [join(root, 'a'), join(root, 'b')];
    for (const [index, dir] of dirs.entries()) {
      await mkdir(join(dir, 'same'), { recursive: true });
      await writeFile(
        join(dir, 'same', 'SKILL.md'),
        `---\nname: Name-${index}\nid: same\n---\nBody\n`,
      );
    }
    const skills = await scanDirsForSkills(dirs);
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ['Name-0'],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /same/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
