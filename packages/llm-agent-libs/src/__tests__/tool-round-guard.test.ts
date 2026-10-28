import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallOptions,
  ILlm,
  IMcpClient,
  Message,
} from '@mcp-abap-adt/llm-agent';
import { McpError, NoopToolCache } from '@mcp-abap-adt/llm-agent';
import { type AgentCallOptions, SmartAgent } from '../agent.js';
import { SmartAgentBuilder } from '../builder.js';
import { NoopMetrics } from '../metrics/noop-metrics.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import { fireInternalToolsAsync } from '../policy/mixed-tool-call-handler.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
import type { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import { makeDefaultDeps } from '../testing/index.js';

for (const path of ['streaming', 'pipeline', 'mixed'] as const) {
  for (const mode of ['reject-one', 'throw', 'absent'] as const) {
    test(`${path}: round guard ${mode} runs before dispatch and preserves allowed calls`, async () => {
      const calls = [
        { id: 'a', name: 'first', arguments: { value: 1 } },
        { id: 'b', name: 'second', arguments: {} },
      ];
      const executed: string[] = [];
      let guarded = 0;
      const options: CallOptions =
        mode === 'absent'
          ? {}
          : {
              toolRoundGuard(round) {
                guarded++;
                assert.deepEqual(
                  round.map(({ name, arguments: args }) => ({
                    name,
                    arguments: args,
                  })),
                  calls.map(({ name, arguments: args }) => ({
                    name,
                    arguments: args,
                  })),
                );
                assert.deepEqual(executed, []);
                if (mode === 'throw') throw new Error('round rejected');
                return new Map([[0, 'first rejected']]);
              },
            };
      const client: IMcpClient = {
        async listTools() {
          return {
            ok: true,
            value: calls.map(({ name }) => ({
              name,
              description: name,
              inputSchema: { type: 'object' },
            })),
          };
        },
        async callTool(name) {
          assert.equal(guarded, mode === 'absent' ? 0 : 1);
          executed.push(name);
          return { ok: true, value: { content: `${name} executed` } };
        },
      };
      let results: string[];
      if (path === 'mixed') {
        const registry = new PendingToolResultsRegistry();
        fireInternalToolsAsync('', calls, registry, 'guard', {
          toolClientMap: new Map(calls.map(({ name }) => [name, client])),
          toolCache: new NoopToolCache(),
          metrics: new NoopMetrics(),
          options,
        });
        const pending = await registry.consume('guard');
        assert.ok(pending);
        results = pending.results.map(({ text }) => text);
      } else {
        let rounds = 0;
        let messages: Message[] = [];
        const llm: ILlm = {
          async chat() {
            return { ok: true, value: { content: 'ok', finishReason: 'stop' } };
          },
          async *streamChat(input) {
            messages = input;
            yield {
              ok: true,
              value:
                rounds++ === 0
                  ? {
                      content: '',
                      toolCalls: calls,
                      finishReason: 'tool_calls',
                    }
                  : { content: 'done', finishReason: 'stop' },
            };
          },
        };
        if (path === 'streaming') {
          const { deps } = makeDefaultDeps({ mcpClients: [client] });
          deps.mainLlm = llm;
          const result = await new SmartAgent(deps, {
            maxIterations: 3,
          }).process('go', options);
          assert.ok(result.ok);
        } else {
          const handle = await new SmartAgentBuilder({
            skipModelValidation: true,
          })
            .withMainLlm(llm)
            .withMcpClients([client])
            .setPipeline(new DefaultPipeline())
            .build();
          try {
            const result = await handle.agent.process('go', options);
            assert.ok(result.ok);
          } finally {
            await handle.close();
          }
        }
        results = messages
          .filter(({ role }) => role === 'tool')
          .map(({ content }) => String(content));
      }
      assert.equal(guarded, mode === 'absent' ? 0 : 1);
      assert.deepEqual(
        executed,
        mode === 'throw'
          ? []
          : mode === 'reject-one'
            ? ['second']
            : ['first', 'second'],
      );
      assert.equal(results.length, 2);
      if (mode !== 'absent')
        assert.match(
          results[0],
          mode === 'throw' ? /round rejected/ : /first rejected/,
        );
      if (mode === 'throw') assert.match(results[1], /round rejected/);
    });
  }
}

for (const path of ['streaming', 'pipeline'] as const) {
  for (const mode of [
    'external-only',
    'new-request-mixed',
    'allowed-mixed',
    'blocked-round',
  ] as const) {
    test(`${path}: guard covers ${mode} before external delivery or blocked continuation`, async () => {
      let guarded = 0;
      let round = 0;
      const executed: string[] = [];
      let messages: Message[] = [];
      const llm: ILlm = {
        async chat() {
          return {
            ok: true,
            value: { content: 'unused', finishReason: 'stop' },
          };
        },
        async *streamChat(input) {
          messages = input;
          const name =
            mode === 'blocked-round'
              ? round < 1
                ? 'blocked'
                : 'new_request'
              : 'new_request';
          const calls =
            mode === 'external-only'
              ? [{ id: 'ext', name: 'external_action', arguments: {} }]
              : [
                  { id: `int-${round}`, name, arguments: {} },
                  ...(mode === 'blocked-round'
                    ? []
                    : [{ id: 'ext', name: 'external_action', arguments: {} }]),
                ];
          if (round++ < (mode === 'blocked-round' ? 2 : 1)) {
            // Split arguments to verify that no partial external delta escapes.
            for (const [index, call] of calls.entries()) {
              yield {
                ok: true,
                value: {
                  content: '',
                  toolCalls: [
                    { index, id: call.id, name: call.name, arguments: '{' },
                  ],
                },
              };
              yield {
                ok: true,
                value: { content: '', toolCalls: [{ index, arguments: '}' }] },
              };
            }
            yield {
              ok: true,
              value: { content: '', finishReason: 'tool_calls' },
            };
          } else
            yield {
              ok: true,
              value: { content: 'done', finishReason: 'stop' },
            };
        },
      };
      const client: IMcpClient = {
        async listTools() {
          return {
            ok: true,
            value: ['new_request', 'blocked'].map((name) => ({
              name,
              description: name,
              inputSchema: {},
            })),
          };
        },
        async callTool(name) {
          executed.push(name);
          return name === 'blocked'
            ? { ok: false, error: new McpError('tool forbidden', 'MCP_ERROR') }
            : { ok: true, value: { content: 'ok' } };
        },
      };
      const options: AgentCallOptions = {
        sessionId: 'round-guard-regression',
        externalTools: [
          { name: 'external_action', description: 'external', inputSchema: {} },
        ],
        toolRoundGuard(calls) {
          guarded++;
          if (mode === 'blocked-round') {
            return new Map(
              calls.flatMap((call, index) =>
                call.name === 'new_request' && guarded > 1
                  ? [[index, 'requires the first tool'] as const]
                  : [],
              ),
            );
          }
          assert.deepEqual(executed, []);
          assert.equal(calls.length, mode === 'external-only' ? 1 : 2);
          return mode === 'allowed-mixed'
            ? new Map()
            : new Map([[calls.length - 1, 'external rejected']]);
        },
      };
      const { deps } = makeDefaultDeps({ mcpClients: [client] });
      deps.mainLlm = llm;
      const handle =
        path === 'pipeline'
          ? await new SmartAgentBuilder({ skipModelValidation: true })
              .withMainLlm(llm)
              .withMcpClients([client])
              .setPipeline(new DefaultPipeline())
              .build()
          : undefined;
      const agent = handle?.agent ?? new SmartAgent(deps, { maxIterations: 5 });
      if (mode === 'blocked-round') {
        const registry = (
          agent as unknown as {
            toolAvailabilityRegistry: ToolAvailabilityRegistry;
          }
        ).toolAvailabilityRegistry;
        registry.block('round-guard-regression', 'blocked', 'tool forbidden');
        options.toolAvailability = registry;
      }
      const surfaced: string[] = [];
      try {
        for await (const chunk of agent.streamProcess('go', options)) {
          assert.ok(chunk.ok);
          if (chunk.ok)
            for (const call of chunk.value.toolCalls ?? []) {
              assert.ok(guarded > 0, 'external call surfaced before guard');
              if (call.name) surfaced.push(call.name);
            }
        }
        assert.equal(guarded, mode === 'blocked-round' ? 2 : 1);
        assert.deepEqual(
          surfaced,
          mode === 'allowed-mixed' ? ['external_action'] : [],
        );
        assert.deepEqual(
          executed,
          mode === 'blocked-round'
            ? []
            : mode === 'external-only'
              ? []
              : ['new_request'],
        );
        if (mode !== 'allowed-mixed')
          assert.ok(
            messages.some(
              (message) =>
                message.role === 'tool' &&
                String(message.content).includes(
                  mode === 'blocked-round'
                    ? 'requires the first tool'
                    : 'external rejected',
                ),
            ),
          );
      } finally {
        await handle?.close();
      }
    });
  }
}
