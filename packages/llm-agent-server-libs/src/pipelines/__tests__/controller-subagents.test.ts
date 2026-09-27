import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { makeControllerRoleLlm } from '../../factories/controller-factory.js';
import { parseControllerSubagents } from '../controller-subagents.js';

const KEYS: ReadonlySet<string> = new Set(['main', 'cheap']);

describe('controller subagents name llm: keys (§4.6.7)', () => {
  it('accepts {} and { llm, hint } for each role', () => {
    const s = parseControllerSubagents(
      {
        evaluator: { llm: 'cheap' },
        planner: { llm: 'cheap', hint: 'plan in small steps' },
        executor: {},
      },
      KEYS,
    );
    assert.deepEqual(s, {
      evaluator: { llm: 'cheap' },
      planner: { llm: 'cheap', hint: 'plan in small steps' },
      executor: {},
    });
  });

  it('leaves reviewer and finalizer absent when their blocks are absent', () => {
    const s = parseControllerSubagents(
      { evaluator: {}, planner: {}, executor: {} },
      KEYS,
    );
    assert.equal('reviewer' in s, false);
    assert.equal('finalizer' in s, false);
  });

  it('still requires evaluator, planner and executor', () => {
    assert.throws(
      () => parseControllerSubagents({ evaluator: {}, planner: {} }, KEYS),
      /subagents\.executor/,
    );
    assert.throws(() => parseControllerSubagents(undefined, KEYS), /subagents/);
  });

  it('refuses an inline LLM configuration and names the llm: map', () => {
    assert.throws(
      () =>
        parseControllerSubagents(
          {
            evaluator: {},
            planner: { provider: 'openai', model: 'gpt-4o-mini', hint: 'h' },
            executor: {},
          },
          KEYS,
        ),
      (err: Error) =>
        /subagents\.planner/.test(err.message) &&
        /inline LLM configuration \(provider, model\)/.test(err.message) &&
        /top-level llm: map/.test(err.message),
    );
  });

  it('refuses a named key with no llm: entry, naming the key and the entries', () => {
    assert.throws(
      () =>
        parseControllerSubagents(
          { evaluator: {}, planner: { llm: 'cheep' }, executor: {} },
          KEYS,
        ),
      /subagents\.planner\.llm names 'cheep'.*no entry.*main, cheap/,
    );
  });

  it('refuses a non-string llm, an unknown field and an unknown role', () => {
    assert.throws(
      () =>
        parseControllerSubagents(
          { evaluator: { llm: 3 }, planner: {}, executor: {} },
          KEYS,
        ),
      /subagents\.evaluator\.llm must be a non-empty string/,
    );
    assert.throws(
      () =>
        parseControllerSubagents(
          { evaluator: { tone: 'x' }, planner: {}, executor: {} },
          KEYS,
        ),
      /subagents\.evaluator: unknown field 'tone'/,
    );
    assert.throws(
      () =>
        parseControllerSubagents(
          { evaluator: {}, planner: {}, executor: {}, judge: {} },
          KEYS,
        ),
      /unknown subagent role 'judge'/,
    );
  });
});

describe('makeControllerRoleLlm (§4.6.7)', () => {
  const llm = (model: string) => ({ model }) as unknown as ILlm;
  const recorder = () => {
    const calls: string[] = [];
    return {
      calls,
      ctx: {
        resolveLlm: async (role: string) => {
          calls.push(`role:${role}`);
          return llm(`default-${role}`);
        },
        resolveNamedLlm: async (key: string) => {
          calls.push(`key:${key}`);
          return llm(key);
        },
      },
    };
  };

  it('resolves a named key strictly and an omitted one by the role name', async () => {
    const { calls, ctx } = recorder();
    const make = makeControllerRoleLlm(
      { evaluator: { llm: 'cheap' }, planner: { llm: 'cheap' }, executor: {} },
      ctx,
    );
    await make('evaluator');
    await make('planner');
    await make('executor');
    assert.deepEqual(calls, ['key:cheap', 'key:cheap', 'role:executor']);
  });

  it('a reviewer block without llm resolves the reviewer role, not main', async () => {
    const { calls, ctx } = recorder();
    const make = makeControllerRoleLlm(
      {
        evaluator: {},
        planner: {},
        executor: {},
        reviewer: { hint: 'strict' },
      },
      ctx,
    );
    await make('reviewer');
    assert.deepEqual(calls, ['role:reviewer']);
  });

  it('refuses a role the controller does not have', async () => {
    const { ctx } = recorder();
    const make = makeControllerRoleLlm(
      { evaluator: {}, planner: {}, executor: {} },
      ctx,
    );
    await assert.rejects(() => make('judge'), /unknown subagent role 'judge'/);
  });
});
