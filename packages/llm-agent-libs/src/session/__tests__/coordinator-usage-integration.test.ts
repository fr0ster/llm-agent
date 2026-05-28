/**
 * Integration test for Task C4 (session-scoped infrastructure plan).
 *
 * Runs a coordinator (DAG) path with a worker that logs `tool-loop` tokens
 * under the traceId it RECEIVES from the interpreter, then asserts the
 * top-level `getSummary(traceId)` carries those worker tokens.
 *
 * This proves the chain end-to-end:
 *   coordinator traceId
 *     -> InterpretContext.trace
 *       -> ISubAgentInput.trace
 *         -> requestLogger.logLlmCall({ ..., requestId: traceId })
 *           -> getSummary(traceId).byComponent['tool-loop'].totalTokens
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  DagPlan,
  ISubAgent,
  ISubAgentInput,
  ISubAgentResult,
} from '@mcp-abap-adt/llm-agent';
import { AbortErrorStrategy } from '../../coordinator/dag/abort-error-strategy.js';
import { DagPlanInterpreter } from '../../coordinator/dag/dag-plan-interpreter.js';
import { SessionRequestLogger } from '../../logger/session-request-logger.js';

/** A worker that logs tokens under the traceId it RECEIVES (proving the
 *  chain coordinator traceId -> InterpretContext.trace ->
 *  ISubAgentInput.trace -> log entry's requestId). */
class LoggingWorker implements ISubAgent {
  readonly name = 'w';
  readonly capabilities = { contextPolicy: 'optional' as const };
  constructor(private readonly logger: SessionRequestLogger) {}
  async run(input: ISubAgentInput): Promise<ISubAgentResult> {
    const traceId = input.trace?.traceId;
    this.logger.startRequest(traceId); // nested under coordinator's traceId
    this.logger.logLlmCall({
      component: 'tool-loop',
      model: 'm',
      promptTokens: 50,
      completionTokens: 10,
      totalTokens: 60,
      durationMs: 1,
      requestId: traceId,
    });
    this.logger.endRequest(traceId);
    return { output: 'done' };
  }
}

test('interpreter forwards trace so worker tokens land in getSummary(traceId)', async () => {
  const logger = new SessionRequestLogger();
  const traceId = 'trace-int';
  logger.startRequest(traceId); // coordinator owns the delta

  const plan: DagPlan = {
    objective: 'do it',
    nodes: [{ id: 'n1', goal: 'go', agent: 'w' }],
    createdAt: 0,
  };
  const interpreter = new DagPlanInterpreter();
  const workers = new Map<string, ISubAgent>([
    ['w', new LoggingWorker(logger)],
  ]);
  const result = await interpreter.interpret(plan, {
    inputText: 'do it',
    workers,
    sessionId: 's1',
    trace: { traceId }, // coordinator passes its traceId
    errorStrategy: new AbortErrorStrategy(),
  });
  assert.equal(result.ok, true, 'plan executed');

  const summary = logger.getSummary(traceId);
  assert.ok(Object.keys(summary.byComponent).length > 0, 'delta non-empty');
  assert.equal(
    summary.byComponent['tool-loop'].totalTokens,
    60,
    'worker tokens reached the coordinator delta',
  );
});
