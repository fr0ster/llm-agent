/**
 * Task 9 — SmartAgent._runStreamingToolLoop forms per-round context via
 * IToolLoopContextStrategy (mirrors Task 8 for the pipeline ToolLoopHandler).
 *
 * Test 1 (flatness): With WindowContextStrategy(keepLastRounds=1), K tool
 * rounds then a final content — per-round messages length must not grow with K
 * once the window is full.
 *
 * Test 2 (reprompt survival): After runOutputValidationReprompt appends a
 * correction to controlTail, the correction must still appear in the messages
 * seen by the NEXT LLM call (i.e. it survives form()).
 *
 * Test 3 (reprompt pruned after next tool round): After a reprompt populates
 * controlTail, a subsequent recorded tool round must prune controlTail so the
 * correction is ABSENT from the following form().
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ILlm,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  McpTool,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { NoopToolCache } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { WindowContextStrategy } from '../pipeline/context/tool-loop-context/index.js';
import { makeAssembler, makeDefaultDeps } from '../testing/index.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TOOL_NAME = 'GetTable';

const MCP_TOOL: McpTool = {
  name: TOOL_NAME,
  description: 'read table',
  inputSchema: { type: 'object' },
};

function makeMcpClient() {
  return {
    async listTools() {
      return { ok: true as const, value: [MCP_TOOL] };
    },
    async callTool() {
      return { ok: true as const, value: { content: 'row data' } };
    },
  };
}

// ---------------------------------------------------------------------------
// Test 1: Flatness — WindowContextStrategy bounds context growth
// ---------------------------------------------------------------------------

function makeKToolsThenStopLlm(k: number, capturedMessages: Message[][]): ILlm {
  let call = 0;
  const streamChat = async function* (
    msgs: Message[],
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    capturedMessages.push([...msgs]);
    call++;
    if (call <= k) {
      yield {
        ok: true,
        value: {
          content: '',
          toolCalls: [
            { index: 0, id: `c${call}`, name: TOOL_NAME, arguments: '{}' },
          ],
          finishReason: 'tool_calls',
        },
      } as Result<LlmStreamChunk, LlmError>;
      return;
    }
    yield {
      ok: true,
      value: { content: 'done', finishReason: 'stop' },
    } as Result<LlmStreamChunk, LlmError>;
  };
  return {
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return { ok: true, value: { content: '', finishReason: 'stop' } };
    },
    streamChat,
  } as unknown as ILlm;
}

test('direct loop: context length does not grow with K when WindowContextStrategy is injected', async () => {
  const K = 4;
  const capturedMessages: Message[][] = [];

  const llm = makeKToolsThenStopLlm(K, capturedMessages);
  const mcpClient = makeMcpClient();

  const { deps } = makeDefaultDeps({
    assembler: makeAssembler([{ role: 'user', content: 'read table' }]),
    mcpClients: [mcpClient],
  });
  deps.mainLlm = llm;
  // Inject WindowContextStrategy with keepLastRounds=1
  deps.toolLoopContextStrategyFactory = () =>
    new WindowContextStrategy({ keepLastRounds: 1 });
  deps.toolCache = new NoopToolCache();

  const agent = new SmartAgent(deps, {
    maxIterations: K + 2,
    refreshToolsPerIteration: false,
  });

  await agent.process('read table', { sessionId: 'direct-flatness' });

  assert.equal(
    capturedMessages.length,
    K + 1,
    `expected ${K + 1} LLM calls (${K} tool rounds + 1 final)`,
  );

  const lengths = capturedMessages.map((msgs) => msgs.length);
  // After window fills (keepLastRounds=1), lengths stabilise.
  // iter 1: prefix(1) + 0 rounds   = 1
  // iter 2: prefix(1) + round1(2)  = 3
  // iter 3: prefix(1) + marker(1) + round2(2) = 4
  // iter 4: prefix(1) + marker(2) + round3(2) = 4   ← same
  // iter 5 (final): = 4                              ← same
  assert.ok(
    lengths[2] === lengths[3] && lengths[3] === lengths[4],
    `context lengths should stabilise after window fills; got ${lengths.join(',')}`,
  );
  assert.ok(
    lengths[K] < lengths[0] + K * 2,
    `context must not grow linearly with K; lengths: ${lengths.join(',')}`,
  );
});

// ---------------------------------------------------------------------------
// Test 2: Reprompt correction survives into the next LLM call via controlTail
// ---------------------------------------------------------------------------

function makeRepromptThenStopLlm(capturedMessages: Message[][]): ILlm {
  let call = 0;
  const streamChat = async function* (
    msgs: Message[],
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    capturedMessages.push([...msgs]);
    call++;
    const content = call === 1 ? 'bad output' : 'good output';
    yield {
      ok: true,
      value: { content, finishReason: 'stop' },
    } as Result<LlmStreamChunk, LlmError>;
  };
  return {
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return { ok: true, value: { content: '', finishReason: 'stop' } };
    },
    streamChat,
  } as unknown as ILlm;
}

test('direct loop: reprompt correction survives into next LLM call after form()', async () => {
  const capturedMessages: Message[][] = [];
  const llm = makeRepromptThenStopLlm(capturedMessages);

  let validateCall = 0;
  const outputValidator = {
    async validate(_content: string) {
      validateCall++;
      if (validateCall === 1) {
        return {
          ok: true as const,
          value: { valid: false, reason: 'output was bad' },
        };
      }
      return { ok: true as const, value: { valid: true } };
    },
  };

  const { deps } = makeDefaultDeps({
    assembler: makeAssembler([{ role: 'user', content: 'do something' }]),
    mcpClients: [],
    outputValidator: outputValidator as unknown as Parameters<
      typeof makeDefaultDeps
    >[0]['outputValidator'],
  });
  deps.mainLlm = llm;

  const agent = new SmartAgent(deps, { maxIterations: 5 });

  await agent.process('do something', { sessionId: 'direct-reprompt' });

  assert.equal(capturedMessages.length, 2, 'expected exactly 2 LLM calls');

  const secondCallMessages = capturedMessages[1];
  const correctionMsg = secondCallMessages.find(
    (m) =>
      m.role === 'user' &&
      typeof m.content === 'string' &&
      m.content.includes('rejected by validation'),
  );
  assert.ok(
    correctionMsg !== undefined,
    `reprompt correction must be present in second LLM call; got: ${JSON.stringify(
      secondCallMessages.map((m) => ({
        role: m.role,
        content: String(m.content).slice(0, 80),
      })),
    )}`,
  );
});

// ---------------------------------------------------------------------------
// Test 3: Reprompt pruned after next tool round (controlTail.length = 0)
// ---------------------------------------------------------------------------

/**
 * Sequence:
 *   call 1 → 'bad output' (no tool calls) → validator rejects → correction in controlTail
 *   call 2 → tool_call GetTable           → tool executed → round recorded → controlTail cleared
 *   call 3 → 'done'                       → validator accepts → check: no correction here
 */
function makeRepromptThenToolThenStopLlm(capturedMessages: Message[][]): ILlm {
  let call = 0;
  const streamChat = async function* (
    msgs: Message[],
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    capturedMessages.push([...msgs]);
    call++;
    if (call === 1) {
      // First call: content only — triggers validation rejection
      yield {
        ok: true,
        value: { content: 'bad output', finishReason: 'stop' },
      } as Result<LlmStreamChunk, LlmError>;
    } else if (call === 2) {
      // Second call: tool call — round will be recorded, controlTail pruned
      yield {
        ok: true,
        value: {
          content: '',
          toolCalls: [
            { index: 0, id: 'tc1', name: TOOL_NAME, arguments: '{}' },
          ],
          finishReason: 'tool_calls',
        },
      } as Result<LlmStreamChunk, LlmError>;
    } else {
      // Third call: final content — should NOT see correction
      yield {
        ok: true,
        value: { content: 'done', finishReason: 'stop' },
      } as Result<LlmStreamChunk, LlmError>;
    }
  };
  return {
    async chat(): Promise<Result<LlmResponse, LlmError>> {
      return { ok: true, value: { content: '', finishReason: 'stop' } };
    },
    streamChat,
  } as unknown as ILlm;
}

test('direct loop: reprompt correction is pruned from controlTail after next recorded tool round', async () => {
  const capturedMessages: Message[][] = [];
  const llm = makeRepromptThenToolThenStopLlm(capturedMessages);
  const mcpClient = makeMcpClient();

  let validateCall = 0;
  const outputValidator = {
    async validate(content: string) {
      validateCall++;
      // Only reject the very first validation (bad output)
      if (validateCall === 1 && content === 'bad output') {
        return {
          ok: true as const,
          value: { valid: false, reason: 'output was bad' },
        };
      }
      return { ok: true as const, value: { valid: true } };
    },
  };

  const { deps } = makeDefaultDeps({
    assembler: makeAssembler([{ role: 'user', content: 'do something' }]),
    mcpClients: [mcpClient],
    outputValidator: outputValidator as unknown as Parameters<
      typeof makeDefaultDeps
    >[0]['outputValidator'],
  });
  deps.mainLlm = llm;
  deps.toolCache = new NoopToolCache();

  const agent = new SmartAgent(deps, {
    maxIterations: 10,
    refreshToolsPerIteration: false,
  });

  await agent.process('do something', { sessionId: 'direct-prune' });

  // 3 LLM calls: bad output, tool call, final content
  assert.equal(capturedMessages.length, 3, 'expected exactly 3 LLM calls');

  // Second call (index 1) should see the correction (controlTail populated)
  const secondCallMessages = capturedMessages[1];
  const correctionInSecond = secondCallMessages.find(
    (m) =>
      m.role === 'user' &&
      typeof m.content === 'string' &&
      m.content.includes('rejected by validation'),
  );
  assert.ok(
    correctionInSecond !== undefined,
    'second LLM call must see the reprompt correction (controlTail visible)',
  );

  // Third call (index 2) must NOT see the correction (controlTail was pruned after round)
  const thirdCallMessages = capturedMessages[2];
  const correctionInThird = thirdCallMessages.find(
    (m) =>
      m.role === 'user' &&
      typeof m.content === 'string' &&
      m.content.includes('rejected by validation'),
  );
  assert.equal(
    correctionInThird,
    undefined,
    `reprompt correction must be absent from third LLM call (controlTail pruned); got: ${JSON.stringify(
      thirdCallMessages.map((m) => ({
        role: m.role,
        content: String(m.content).slice(0, 80),
      })),
    )}`,
  );
});
