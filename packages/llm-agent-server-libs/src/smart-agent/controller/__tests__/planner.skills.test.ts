import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AdaptivePlanner, IncrementalPlanner } from '../planner.js';
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
const STEP_REPLY = JSON.stringify({
  kind: 'next',
  step: { name: 's1', instructions: 'do' },
});

const SKILLS_BLOCK = 'Relevant skills:\n- X';
const skillsStub = async () => SKILLS_BLOCK;

describe('AdaptivePlanner skills recall injection', () => {
  it('injects the recall block into the create-plan user message', async () => {
    const { client, userMsg } = recordingClient(PLAN_REPLY);
    await new AdaptivePlanner(client, undefined, skillsStub).next({
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

    await new AdaptivePlanner(without.client).next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
    });
    // A hook that returns '' must ALSO yield the byte-identical agnostic prompt.
    await new AdaptivePlanner(emptyHook.client, undefined, async () => '').next(
      {
        bundle: bundle(),
        prompt: 'r',
        retrying: false,
      },
    );
    // And a present, non-empty hook must DIFFER (sanity that we are comparing
    // something meaningful).
    await new AdaptivePlanner(withHook.client, undefined, skillsStub).next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
    });

    assert.equal(emptyHook.userMsg(), without.userMsg());
    assert.notEqual(withHook.userMsg(), without.userMsg());
  });
});

describe('IncrementalPlanner skills recall injection', () => {
  it('injects the recall block into the planner user message', async () => {
    const { client, userMsg } = recordingClient(STEP_REPLY);
    await new IncrementalPlanner(client, undefined, skillsStub).next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
    });
    assert.match(userMsg(), /Relevant skills:\n- X/);
  });

  it('is byte-identical to the agnostic prompt when skillsRecall is absent', async () => {
    const without = recordingClient(STEP_REPLY);
    const emptyHook = recordingClient(STEP_REPLY);

    await new IncrementalPlanner(without.client).next({
      bundle: bundle(),
      prompt: 'r',
      retrying: false,
    });
    await new IncrementalPlanner(
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
