import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ILlm, LlmError, TokenLedger } from '@mcp-abap-adt/llm-agent';
import { makeLlm } from '../../../testing/index.js';
import { CyclicReActExecutor } from '../cyclic-react-executor.js';
import { LlmEvaluator } from '../llm-evaluator.js';
import { LlmStepperPlanner } from '../llm-stepper-planner.js';
import { LlmTaskFormalizer } from '../llm-task-formalizer.js';
import { LlmNeedResolver } from '../need-resolver.js';
import { RootFinalizer } from '../root-finalizer.js';
import { StepperInterpreter } from '../stepper-interpreter.js';

const write = { name: 'Write', description: 'Write', inputSchema: {} };
const knowledgeRag = {
  query: async () => [],
  list: async () => [],
  write: async () => {},
  fingerprint: () => 'empty',
};
const base = {
  prompt: 'Write',
  identity: { traceId: 't', turnId: 'u', sessionId: 's', stepperId: 'root' },
  knowledgeRag,
  toolsRag: { query: async () => [write], lookup: () => write },
};

for (const mode of ['truncation', 'typed error', 'recoverable'] as const) {
  test(`stepper handles ${mode} after a cyclic executor write`, async () => {
    const llm = makeLlm([
      {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'w', name: 'Write', arguments: {} }],
      },
      { content: 'partial answer', finishReason: 'length' },
      { content: 'should never run after a terminal error' },
    ]);
    const error = new LlmError(
      'Provider failed',
      mode === 'recoverable' ? 'LLM_OFFLINE' : 'CREDENTIALS_REJECTED',
    );
    if (mode !== 'truncation') {
      const chat = llm.chat.bind(llm);
      llm.chat = async (...args) => {
        const response = await chat(...args);
        return llm.callCount === 2 ? { ok: false, error } : response;
      };
    }
    let writes = 0;
    const executor = new CyclicReActExecutor({
      llm,
      component: 'tool-loop',
      async callMcp() {
        writes++;
        return 'written';
      },
    });
    let next = 0;
    const run = new StepperInterpreter().interpret(
      {
        createdAt: 0,
        nodes: [
          { id: 'first', goal: 'Write' },
          { id: 'second', goal: 'Follow up', dependsOn: ['first'] },
        ],
      },
      {
        ...base,
        executor,
        childSteppers: new Map(),
        budget: { depthRemaining: 0, tokens: new TokenLedger(100000) },
        maxParallelSteps: 1,
        mintStepperId: () => `node-${++next}`,
      },
    );
    if (mode === 'recoverable') {
      const result = await run;
      assert.equal(result.status, 'incomplete');
      assert.deepEqual(result.missing, [error.message]);
      assert.equal(next, 2);
      assert.equal(llm.callCount, 3);
    } else {
      await assert.rejects(run, {
        code: mode === 'truncation' ? 'LLM_OUTPUT_TRUNCATED' : error.code,
      });
      assert.equal(next, 1);
      assert.equal(llm.callCount, 2);
    }
    assert.equal(writes, 1);
  });
}

for (const [role, run] of Object.entries({
  formalizer: (llm: ILlm) => new LlmTaskFormalizer(llm).formalize(base),
  evaluator: (llm: ILlm) => new LlmEvaluator(llm).evaluate(base),
  planner: (llm: ILlm) =>
    new LlmStepperPlanner(llm).plan({ ...base, parentPath: [] }),
  'need resolver': (llm: ILlm) =>
    new LlmNeedResolver(llm).resolve('partial answer'),
  finalizer: (llm: ILlm) =>
    new RootFinalizer(llm).finalize({ ...base, turnId: 'u' }),
})) {
  test(`${role} propagates provider failures and truncation as terminal`, async () => {
    const error = new LlmError('Credentials rejected', 'CREDENTIALS_REJECTED');
    const llm: ILlm = {
      async chat() {
        return { ok: false, error };
      },
      async *streamChat() {
        yield { ok: false, error };
      },
    };
    await assert.rejects(run(llm), (caught) => caught === error);
    await assert.rejects(
      run(makeLlm([{ content: '{}', finishReason: 'length' }])),
      { code: 'LLM_OUTPUT_TRUNCATED' },
    );
  });
}

for (const source of [
  'seed',
  'artifact lookup',
  'dependency',
  'evaluator tools',
  'planner tools',
  'planner artifacts',
] as const) {
  test(`stepper stops on a typed failure from ${source}`, async () => {
    const error = new LlmError('Credentials rejected', 'CREDENTIALS_REJECTED');
    const fail = async () => {
      throw error;
    };
    const toolsRag = { ...base.toolsRag, query: fail };
    const llm = makeLlm([
      {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'w', name: 'Write', arguments: {} }],
      },
    ]);
    const executor = new CyclicReActExecutor({
      llm,
      component: 'tool-loop',
      callMcp: () => assert.fail('terminal error must prevent tool execution'),
    });
    switch (source) {
      case 'seed':
      case 'artifact lookup':
        await assert.rejects(
          executor.execute({
            ...base,
            tools: [write],
            knowledgeRag:
              source === 'seed'
                ? { ...knowledgeRag, query: fail }
                : {
                    ...knowledgeRag,
                    hasArtifact: fail,
                    getArtifact: async () => undefined,
                  },
            budget: { depthRemaining: 0, tokens: new TokenLedger(100) },
          }),
          (caught) => caught === error,
        );
        break;
      case 'dependency': {
        let calls = 0;
        await assert.rejects(
          new StepperInterpreter().interpret(
            {
              createdAt: 0,
              nodes: [
                { id: 'a', goal: 'First' },
                { id: 'b', goal: 'Second', dependsOn: ['a'] },
              ],
            },
            {
              ...base,
              knowledgeRag: { ...knowledgeRag, list: fail },
              childSteppers: new Map(),
              budget: { depthRemaining: 0, tokens: new TokenLedger(100) },
              maxParallelSteps: 1,
              mintStepperId: () => 'node',
              executor: {
                name: 'test',
                async execute() {
                  calls++;
                  return {
                    status: 'ok',
                    usage: {
                      promptTokens: 0,
                      completionTokens: 0,
                      totalTokens: 0,
                    },
                  };
                },
              },
            },
          ),
          (caught) => caught === error,
        );
        assert.equal(calls, 1);
        break;
      }
      case 'evaluator tools':
        await assert.rejects(
          new LlmEvaluator(llm).evaluate({ ...base, toolsRag }),
          (caught) => caught === error,
        );
        break;
      case 'planner tools':
      case 'planner artifacts':
        await assert.rejects(
          new LlmStepperPlanner(llm).plan({
            ...base,
            parentPath: [],
            toolsRag: source === 'planner tools' ? toolsRag : base.toolsRag,
            knowledgeRag:
              source === 'planner artifacts'
                ? { ...knowledgeRag, listArtifacts: fail }
                : knowledgeRag,
          }),
          (caught) => caught === error,
        );
        break;
    }
    assert.equal(llm.callCount, source === 'artifact lookup' ? 1 : 0);
  });
}
