import type { IKnowledgeRagHandle, IToolsRagHandle } from './knowledge-rag.js';
import type { StreamChunk } from './streaming.js';
import type { ITaskSpec } from './task-spec.js';
import type { LlmTool, LlmUsage } from './types.js';

/** Identity carried through every layer so executors can stamp
 *  KnowledgeEntryMetadata and the coordinator can attribute streaming
 *  + usage. Minted at the coordinator boundary; the interpreter rewrites
 *  stepperId/parentStepperId at each dispatch. */
export interface RunIdentity {
  traceId: string;
  turnId: string;
  sessionId: string;
  stepperId: string;
  parentStepperId?: string;
}

/** Shared, live token ledger (review R2-F1). ONE instance is created at the
 *  coordinator boundary and passed BY REFERENCE through the whole run. Every
 *  Stepper and executor reads `exhausted()` before each LLM call and calls
 *  `spend(usage)` after. This is a SOFT cap (review R3-F2/R5-F1): parallel
 *  siblings can each pass the pre-check before any records its spend, so the
 *  run can overshoot by at most (total in-flight calls across the tree ×
 *  tokens-per-call). maxParallelSteps bounds only each LOCAL scheduler; the
 *  global in-flight count is ≈ maxParallelSteps^depth worst case. The
 *  budget-extension ClarifySignal is the real net. Tokens bound WORK; depth
 *  (a per-branch value below) bounds RECURSION. A reserve-before-call hard
 *  cap is deferred. */
export interface ITokenLedger {
  readonly remaining: number;
  spend(usage: LlmUsage): void;
  exhausted(): boolean;
}

export interface Budget {
  /** Per-branch recursion bound — a plain value, decremented by 1 at each
   *  child dispatch (NOT shared). */
  depthRemaining: number;
  /** Shared run-wide token ledger — the SAME object reference for every
   *  Stepper/executor in the run. */
  tokens: ITokenLedger;
}

export interface IStepperInput {
  prompt: string;
  knowledgeRag: IKnowledgeRagHandle;
  toolsRag: IToolsRagHandle;
  budget: Budget;
  identity: RunIdentity;
  /** Formalized overall task (optional). Threaded down to every planner and
   *  executor as a compact anchor. Absent → behaves as before. */
  taskSpec?: ITaskSpec;
  /** Client-provided external tools (consumer-executed function tools from the
   *  request, e.g. create_file). Threaded down to every executor and merged
   *  with the seeded MCP tools (issue #167). Absent → only MCP tools. */
  externalTools?: readonly LlmTool[];
  signal?: AbortSignal;
  sessionLogger?: { logStep(name: string, data: unknown): void };
  onProgress?: (event: StreamChunk) => void;
}

export interface IStepperResult {
  status: 'ok' | 'incomplete' | 'budget-exhausted';
  missing?: string[];
  usage: LlmUsage;
}

export interface IStepper {
  readonly name: string;
  run(input: IStepperInput): Promise<IStepperResult>;
}

/** Default mutable ledger. Created once per run with the configured token
 *  budget; shared by reference. */
export class TokenLedger implements ITokenLedger {
  private _remaining: number;
  constructor(total: number) {
    this._remaining = total;
  }
  get remaining(): number {
    return this._remaining;
  }
  spend(usage: LlmUsage): void {
    this._remaining -= usage.totalTokens;
  }
  exhausted(): boolean {
    return this._remaining <= 0;
  }
}
