import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CallOptions,
  type LlmTool,
  McpError,
  type Message,
  NoopQueryExpander,
  NoopToolCache,
  StreamingLlmCallStrategy,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { ContextAssembler } from '../context/context-assembler.js';
import { NoopRequestLogger } from '../logger/noop-request-logger.js';
import { NoopMetrics } from '../metrics/noop-metrics.js';
import type { PipelineContext } from '../pipeline/context.js';
import { ToolLoopHandler } from '../pipeline/handlers/tool-loop.js';
import { resolveCallerIdentity } from '../policy/caller-identity.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import { NoopReranker } from '../reranker/noop-reranker.js';
import { NoopSessionManager } from '../session/noop-session-manager.js';
import { makeDefaultDeps } from '../testing/index.js';
import { NoopTracer } from '../tracer/noop-tracer.js';
import { NoopValidator } from '../validator/noop-validator.js';

for (const pipeline of [false, true]) {
  for (const identity of ['caller', 'anonymous', 'denied'] as const) {
    test(
      (pipeline ? 'pipeline' : 'direct') +
        ': forbidden tools run once per request for ' +
        identity,
      async () => {
        const sessionId = 'shared-session';
        const caller = { userId: 'alice', sessionId, isAdmin: false };
        const options: CallOptions =
          identity === 'caller'
            ? { caller }
            : identity === 'denied'
              ? { caller, userId: 'conflicting-user' }
              : { sessionId };
        let reads = 0;
        let writes = 0;
        const registry = new ToolAvailabilityRegistry(0);
        const filter = registry.filterTools.bind(registry);
        registry.filterTools = (...args) => {
          reads++;
          return filter(...args);
        };
        const getBlocked = registry.getBlockedToolNames.bind(registry);
        registry.getBlockedToolNames = (...args) => {
          reads++;
          return getBlocked(...args);
        };
        const block = registry.block.bind(registry);
        registry.block = (...args) => {
          writes++;
          return block(...args);
        };
        let executions = 0;
        let rounds = 0;
        const inputs: Message[][] = [];
        const offered: LlmTool[][] = [];
        const { deps } = makeDefaultDeps({
          assembler: new ContextAssembler(),
          mcpClients: [
            {
              cacheable: false,
              async listTools() {
                return {
                  ok: true,
                  value: [
                    { name: 'Work', description: 'work', inputSchema: {} },
                  ],
                };
              },
              async callTool() {
                executions++;
                return {
                  ok: false,
                  error: new McpError('tool forbidden', 'MCP_ERROR'),
                };
              },
            },
          ],
        });
        deps.toolAvailabilityRegistry = registry;
        deps.mainLlm = {
          async chat() {
            assert.fail('stream expected');
          },
          async *streamChat(messages, tools) {
            inputs.push(structuredClone(messages));
            offered.push(tools ?? []);
            rounds++;
            yield {
              ok: true,
              value:
                rounds % 3 === 0
                  ? { content: 'DONE', finishReason: 'stop' }
                  : {
                      content: '',
                      finishReason: 'tool_calls',
                      toolCalls: [
                        {
                          index: 0,
                          id: `call-${rounds}`,
                          name: 'Work',
                          arguments: '{}',
                        },
                      ],
                    },
            };
          },
        };
        const config = {
          mode: 'hard' as const,
          maxIterations: 4,
          refreshToolsPerIteration: true,
        };
        const agent = new SmartAgent(deps, config);
        for (let run = 1; run <= 2; run++) {
          if (pipeline) {
            const tool = { name: 'Work', description: 'work', inputSchema: {} };
            const tracer = new NoopTracer();
            const ctx: PipelineContext = {
              ...deps,
              config,
              sessionId,
              options,
              callerResolution: resolveCallerIdentity(options, sessionId),
              textOrMessages: 'work',
              inputText: 'work',
              history: [],
              classifierLlm: deps.mainLlm,
              helperLlm: undefined,
              ragRegistry: undefined,
              ragProviderRegistry: undefined,
              toolPolicy: undefined,
              injectionDetector: undefined,
              historyMemory: undefined,
              historySummarizer: undefined,
              skillManager: undefined,
              embedder: undefined,
              toolSelectionStrategy: undefined,
              logger: undefined,
              tracer,
              metrics: new NoopMetrics(),
              reranker: new NoopReranker(),
              queryExpander: new NoopQueryExpander(),
              toolCache: new NoopToolCache(),
              outputValidator: new NoopValidator(),
              sessionManager: new NoopSessionManager(),
              requestLogger: new NoopRequestLogger(),
              llmCallStrategy: new StreamingLlmCallStrategy(),
              pendingToolResults: new PendingToolResultsRegistry(),
              toolAvailabilityRegistry: registry,
              subprompts: [],
              ragText: 'work',
              queryEmbedding: undefined,
              ragResults: {},
              mcpTools: [tool],
              selectedTools: [tool],
              activeTools: [tool],
              externalTools: [],
              toolClientMap: new Map([['Work', deps.mcpClients[0]]]),
              assembledMessages: [{ role: 'user', content: 'work' }],
              selectedSkills: [],
              skillContent: '',
              skillArgs: '',
              shouldRetrieve: false,
              isAscii: true,
              isSapRequired: false,
              timing: [],
              yield(chunk) {
                assert.ok(chunk.ok);
              },
            };
            assert.equal(
              await new ToolLoopHandler().execute(
                ctx,
                {},
                tracer.startSpan('test'),
              ),
              true,
            );
            assert.equal(ctx.assistantText, 'DONE');
          } else {
            const result = await agent.process('work', {
              ...options,
              toolAvailability: registry,
            });
            assert.ok(result.ok);
            assert.equal(result.value.content, 'DONE');
          }
          assert.equal(executions, run);
          assert.ok(
            offered[(run - 1) * 3].some((tool) => tool.name === 'Work'),
          );
          assert.ok(
            offered[(run - 1) * 3 + 1].every((tool) => tool.name !== 'Work'),
          );
          assert.match(
            JSON.stringify(inputs.at(-1)),
            /temporarily unavailable/,
          );
        }
        if (identity === 'caller') {
          assert.ok(reads > 0);
          assert.equal(writes, 2);
        } else {
          assert.equal(reads, 0);
          assert.equal(writes, 0);
        }
      },
    );
  }
}
