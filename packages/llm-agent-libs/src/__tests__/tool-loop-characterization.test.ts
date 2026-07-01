/**
 * Task 0 — PR-2b guard: Loop A characterization tests.
 *
 * These tests pin two behaviors of SmartAgent._runStreamingToolLoop
 * BEFORE any code is extracted to shared helpers, so a silent regression
 * would make them fail:
 *
 *   A1 — the dedicated `smart_agent.tool_loop` span is opened, parents
 *        all sub-spans (llm_call / tool_call), and is ended on exit.
 *   A2 — the reselect READ-ONLY branch: on a read-only tool retry, Loop A
 *        keeps the FULL refreshed tool set and logs `tools_reselect_skipped`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  LlmError,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import {
  makeAssembler,
  makeCapturingTracer,
  makeDefaultDeps,
  makeRag,
} from '../testing/index.js';

// A streaming LLM: iteration 1 → one tool call; iteration 2 → stop.
function makeToolThenStopLlm(
  toolName: string,
  onCall?: (i: number, tools: LlmTool[]) => void,
) {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async chat() {
      return {
        ok: true as const,
        value: { content: 'ok', finishReason: 'stop' as const },
      };
    },
    async *streamChat(
      _msgs: Message[],
      tools?: LlmTool[],
    ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      callCount++;
      onCall?.(callCount, tools ?? []);
      if (callCount === 1) {
        yield {
          ok: true,
          value: {
            content: '',
            toolCalls: [
              { index: 0, id: 'tc_1', name: toolName, arguments: '{}' },
            ],
            finishReason: 'tool_calls',
          },
        };
      } else {
        yield { ok: true, value: { content: 'done', finishReason: 'stop' } };
      }
    },
    async healthCheck() {
      return { ok: true as const, value: true };
    },
  };
}

describe('Loop A characterization — tool_loop span structure (#2)', () => {
  it('opens a smart_agent.tool_loop span that parents sub-spans and is ended', async () => {
    const tracer = makeCapturingTracer();
    const llm = makeToolThenStopLlm('CreateClass');
    const { deps } = makeDefaultDeps({
      tracer,
      assembler: makeAssembler([
        {
          role: 'system',
          content: '## Available Tools\n- CreateClass: create',
        },
        { role: 'user', content: 'create a class' },
      ]),
      mcpClients: [
        {
          async listTools() {
            return {
              ok: true as const,
              value: [
                {
                  name: 'CreateClass',
                  description: 'create',
                  inputSchema: { type: 'object' },
                },
              ],
            };
          },
          async callTool() {
            return { ok: true as const, value: { content: 'ok' } };
          },
        },
      ],
    });
    deps.mainLlm = llm;
    const agent = new SmartAgent(deps, { maxIterations: 5 });
    await agent.process('create a class', { sessionId: 'span-char' });

    const loopSpans = tracer.spans.filter(
      (s) => s.name === 'smart_agent.tool_loop',
    );
    assert.equal(loopSpans.length, 1, 'exactly one smart_agent.tool_loop span');
    assert.ok(loopSpans[0].ended, 'tool_loop span must be ended on exit');
    // Every loop sub-span is parented by tool_loop (nesting one level deeper than B).
    const subNames = ['smart_agent.llm_call', 'smart_agent.tool_call'];
    const subs = tracer.spans.filter((s) => subNames.includes(s.name));
    assert.ok(subs.length >= 2, 'expected llm_call + tool_call sub-spans');
    for (const s of subs) {
      assert.equal(
        s.parentName,
        'smart_agent.tool_loop',
        `${s.name} must be parented by smart_agent.tool_loop`,
      );
    }
  });
});

describe('Loop A characterization — reselect read-only keeps full set + skip log (#4)', () => {
  it('on a read-only retry keeps ALL refreshed tools and logs tools_reselect_skipped', async () => {
    const logSteps: Array<{ step: string; data: Record<string, unknown> }> = [];
    const offered: LlmTool[][] = [];
    const llm = makeToolThenStopLlm('SearchClass', (_i, tools) =>
      offered.push(tools),
    );
    const { deps } = makeDefaultDeps({
      assembler: makeAssembler([
        {
          role: 'system',
          content: '## Available Tools\n- SearchClass: search',
        },
        { role: 'user', content: 'search classes' },
      ]),
      ragStores: {
        tools: makeRag([
          {
            text: 'Tool: UpdateClass',
            score: 0.9,
            metadata: { id: 'tool:UpdateClass' },
          },
        ]),
      },
      mcpClients: [
        {
          async listTools() {
            return {
              ok: true as const,
              value: [
                {
                  name: 'SearchClass',
                  description: 'search',
                  inputSchema: { type: 'object' },
                },
                {
                  name: 'UpdateClass',
                  description: 'update',
                  inputSchema: { type: 'object' },
                },
              ],
            };
          },
          async callTool() {
            return { ok: true as const, value: { content: 'found 3 results' } };
          },
        },
      ],
    });
    deps.mainLlm = llm;
    const agent = new SmartAgent(deps, {
      maxIterations: 5,
      toolReselectPerIteration: true,
    });
    await agent.process('search classes', {
      sessionId: 'a-readonly',
      sessionLogger: {
        logStep(step: string, data: Record<string, unknown>) {
          logSteps.push({ step, data });
        },
      },
    });

    const skip = logSteps.find((l) => l.step === 'tools_reselect_skipped');
    assert.ok(skip, 'A must log tools_reselect_skipped on read-only retry');
    // Iteration 2 offered the FULL refreshed set (both MCP tools), not a narrowed subset.
    const iter2 = offered[1] ?? [];
    const names = new Set(iter2.map((t) => t.name));
    assert.ok(
      names.has('SearchClass') && names.has('UpdateClass'),
      'A keeps ALL refreshed MCP tools on the read-only retry',
    );
  });
});
