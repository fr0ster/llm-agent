import type { IKnowledgeRagHandle, IToolsRagHandle } from './knowledge-rag.js';
import type { INeedResolver } from './need-resolver.js';
import type { Budget, RunIdentity, ToolSafetyPolicy } from './stepper.js';
import type { StreamChunk } from './streaming.js';
import type { LlmTool, LlmUsage } from './types.js';

export interface IExecutor {
  readonly name: string;
  execute(input: {
    prompt: string;
    tools: readonly LlmTool[];
    knowledgeRag: IKnowledgeRagHandle;
    toolsRag: IToolsRagHandle;
    needResolver?: INeedResolver;
    /** Executor is a LEAF; ignores depthRemaining, stops when budget.tokens.exhausted(). */
    budget: Budget;
    identity: RunIdentity;
    toolSafety: ToolSafetyPolicy;
    signal?: AbortSignal;
    sessionLogger?: { logStep(name: string, data: unknown): void };
    onProgress?: (event: StreamChunk) => void;
  }): Promise<{
    status: 'ok' | 'incomplete' | 'budget-exhausted';
    missing?: string[];
    usage: LlmUsage;
  }>;
}
