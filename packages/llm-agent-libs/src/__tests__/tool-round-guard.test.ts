import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallOptions,
  ILlm,
  IMcpClient,
  Message,
} from '@mcp-abap-adt/llm-agent';
import { NoopToolCache } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { SmartAgentBuilder } from '../builder.js';
import { NoopMetrics } from '../metrics/noop-metrics.js';
import { DefaultPipeline } from '../pipeline/default-pipeline.js';
import { fireInternalToolsAsync } from '../policy/mixed-tool-call-handler.js';
import { PendingToolResultsRegistry } from '../policy/pending-tool-results-registry.js';
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
