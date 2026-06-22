import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CallOptions } from '@mcp-abap-adt/llm-agent';
import { SmartExecutorPlanner, WeakExecutorPlanner } from '../planner.js';
import type { ISubagentClient } from '../subagent-client.js';
import type { SessionBundle } from '../types.js';

const bundle = (): SessionBundle => ({
  goal: 'g',
  plannerPrivate: '',
  budgets: { stepsUsed: 0, rewindsUsed: 0 },
});

/** Captures the user-message content of the FIRST send() call. */
function recordingClient(reply: string): {
  client: ISubagentClient;
  userMsg: () => string;
} {
  let captured = '';
  return {
    client: {
      async send(messages) {
        captured =
          typeof messages[1]?.content === 'string' ? messages[1].content : '';
        return { kind: 'content', content: reply };
      },
    },
    userMsg: () => captured,
  };
}

const PLAN_REPLY = JSON.stringify({
  plan: [{ name: 's1', instructions: 'fetch A' }],
});

const SKILLS_BLOCK = 'Relevant skills:\n- X';
const skillsStub = async () => SKILLS_BLOCK;

describe('SmartExecutorPlanner skills recall injection', () => {
  it('injects the recall block into the create-plan user message', async () => {
    const { client, userMsg } = recordingClient(PLAN_REPLY);
    await new SmartExecutorPlanner(client, undefined, skillsStub).next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
    });
    assert.match(userMsg(), /Relevant skills:\n- X/);
  });

  it('is byte-identical to the agnostic prompt when skillsRecall is absent', async () => {
    const withHook = recordingClient(PLAN_REPLY);
    const without = recordingClient(PLAN_REPLY);
    const emptyHook = recordingClient(PLAN_REPLY);

    await new SmartExecutorPlanner(without.client).next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
    });
    // A hook that returns '' must ALSO yield the byte-identical agnostic prompt.
    await new SmartExecutorPlanner(
      emptyHook.client,
      undefined,
      async () => '',
    ).next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
    });
    // And a present, non-empty hook must DIFFER (sanity that we are comparing
    // something meaningful).
    await new SmartExecutorPlanner(withHook.client, undefined, skillsStub).next(
      {
        bundle: bundle(),
        prompt: 'r',
        retrying: false,
      },
    );

    assert.equal(emptyHook.userMsg(), without.userMsg());
    assert.notEqual(withHook.userMsg(), without.userMsg());
  });
});

describe('WeakExecutorPlanner skills recall injection', () => {
  it('injects the recall block into the planner user message', async () => {
    const { client, userMsg } = recordingClient(PLAN_REPLY);
    await new WeakExecutorPlanner(client, undefined, skillsStub).next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
    });
    assert.match(userMsg(), /Relevant skills:\n- X/);
  });

  it('is byte-identical to the agnostic prompt when skillsRecall is absent', async () => {
    const without = recordingClient(PLAN_REPLY);
    const emptyHook = recordingClient(PLAN_REPLY);

    await new WeakExecutorPlanner(without.client).next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
    });
    await new WeakExecutorPlanner(
      emptyHook.client,
      undefined,
      async () => '',
    ).next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
    });

    assert.equal(emptyHook.userMsg(), without.userMsg());
  });
});

describe('skills recall receives the request CallOptions', () => {
  // A unique sentinel so we can assert the EXACT options object (request logger /
  // trace / cancellation signal) flows through to the recall embedding.
  const SENTINEL = {
    trace: { traceId: 'sentinel-trace' },
  } as unknown as CallOptions;

  it('SmartExecutorPlanner threads input.options into skillsRecall (create-plan)', async () => {
    const { client } = recordingClient(PLAN_REPLY);
    let seen: CallOptions | undefined;
    const spy = async (_goal: string, options?: CallOptions) => {
      seen = options;
      return SKILLS_BLOCK;
    };
    await new SmartExecutorPlanner(client, undefined, spy).next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
      options: SENTINEL,
    });
    assert.equal(seen, SENTINEL);
  });

  it('WeakExecutorPlanner threads input.options into skillsRecall', async () => {
    const { client } = recordingClient(PLAN_REPLY);
    let seen: CallOptions | undefined;
    const spy = async (_goal: string, options?: CallOptions) => {
      seen = options;
      return SKILLS_BLOCK;
    };
    await new WeakExecutorPlanner(client, undefined, spy).next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
      options: SENTINEL,
    });
    assert.equal(seen, SENTINEL);
  });
});
