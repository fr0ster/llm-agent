import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDialogueTaskContext,
  type DialogueSignals,
  finishDialogueTask,
} from '@mcp-abap-adt/llm-agent';
import { createSignalBus } from '../../../../llm-signals/src/index.js';
import { SmartAgent } from '../../agent.js';
import { DefaultPipeline } from '../../pipeline/default-pipeline.js';
import { makeAssembler, makeDefaultDeps } from '../../testing/index.js';
import { SmartAgentSubAgent } from '../smart-agent-subagent.js';

for (const pipeline of [false, true]) {
  for (const streamMode of ['full', 'final'] as const) {
    for (const scenario of [
      'worker',
      'single',
      'finish',
      'empty-finish',
      'chat',
      'external',
      'budget',
    ] as const) {
      test(`assistant output: ${scenario}, pipeline=${pipeline}, stream=${streamMode}`, async () => {
        const task = createDialogueTaskContext(
          createSignalBus<DialogueSignals>(),
          's',
          't',
        );
        const report = 'Full worker report';
        const finalText = 'Final side remark';
        const { deps } = makeDefaultDeps({
          assembler: makeAssembler([{ role: 'user', content: 'work' }]),
          mcpClients: [
            {
              async listTools() {
                return {
                  ok: true,
                  value: [
                    {
                      name: 'Work',
                      description: 'Work',
                      inputSchema: { type: 'object' },
                    },
                  ],
                };
              },
              async callTool() {
                if (scenario === 'finish' || scenario === 'empty-finish') {
                  finishDialogueTask(
                    task,
                    scenario === 'finish' ? 'Explicit verdict' : '',
                  );
                }
                return { ok: true, value: { content: 'Tool result excluded' } };
              },
            },
          ],
          llmResponses:
            scenario === 'single'
              ? [{ content: finalText, finishReason: 'stop' }]
              : [
                  {
                    content: report,
                    toolCalls: [
                      {
                        id: 'call',
                        name: scenario === 'external' ? 'External' : 'Work',
                        arguments: { query: 'Arguments excluded' },
                      },
                    ],
                    finishReason: 'tool_calls',
                  },
                  { content: finalText, finishReason: 'stop' },
                ],
        });
        const config = {
          streamMode,
          maxIterations: 3,
          ...(scenario === 'budget' ? { maxToolCalls: 1 } : {}),
          heartbeatIntervalMs: 0,
          refreshToolsPerIteration: false,
        };
        if (pipeline) {
          const flow = new DefaultPipeline();
          flow.initialize({ ...deps, agentConfig: config });
          deps.pipeline = flow;
        }
        const agent = new SmartAgent(deps, config);
        if (scenario === 'chat') {
          const result = await agent.process('work');
          assert.ok(result.ok);
          assert.equal(result.value.content, finalText);
          return;
        }
        const result = await new SmartAgentSubAgent('worker', agent).run({
          task: 'work',
          dialogueTask: task,
          ...(scenario === 'external'
            ? {
                externalTools: [
                  {
                    name: 'External',
                    description: 'External',
                    inputSchema: { type: 'object' },
                  },
                ],
              }
            : {}),
        });
        assert.equal(
          result.output,
          scenario === 'finish'
            ? 'Explicit verdict'
            : scenario === 'empty-finish'
              ? ''
              : scenario === 'single'
                ? finalText
                : scenario === 'external'
                  ? report
                  : `${report}\n\n${finalText}`,
        );
        assert.equal(
          result.status,
          scenario === 'external' ? 'awaiting-external' : 'complete',
        );
        if (scenario === 'budget') assert.equal(result.budgetExhausted, true);
      });
    }
  }
}
