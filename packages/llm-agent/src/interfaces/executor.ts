import type { IKnowledgeRagHandle, IToolsRagHandle } from './knowledge-rag.js';
import type { INeedResolver } from './need-resolver.js';
import type { Budget, RunIdentity } from './stepper.js';
import type { StreamChunk } from './streaming.js';
import type { ITaskSpec } from './task-spec.js';
import type { LlmTool, LlmUsage } from './types.js';

export interface IExecutor {
  readonly name: string;
  execute(input: {
    prompt: string;
    tools: readonly LlmTool[];
    /**
     * Client-provided external tools (OpenAI-style function tools sent in the
     * request, e.g. create_file / rag_add) that the CONSUMER executes. They are
     * MERGED with the seeded MCP tools and offered to the model so a step can
     * emit a tool call the client fulfils (issue #167). Absent → only MCP tools.
     */
    externalTools?: readonly LlmTool[];
    knowledgeRag: IKnowledgeRagHandle;
    toolsRag: IToolsRagHandle;
    needResolver?: INeedResolver;
    /**
     * Formalized overall task (optional). When present it is kept as a
     * persistent anchor in EVERY iteration and prefixes the tool-search query
     * so the executor never loses sight of the overall task. Absent → behaves
     * as before.
     */
    taskSpec?: ITaskSpec;
    /** Executor is a LEAF; ignores depthRemaining, stops when budget.tokens.exhausted(). */
    budget: Budget;
    identity: RunIdentity;
    signal?: AbortSignal;
    sessionLogger?: { logStep(name: string, data: unknown): void };
    onProgress?: (event: StreamChunk) => void;
  }): Promise<{
    status: 'ok' | 'incomplete' | 'budget-exhausted';
    missing?: string[];
    usage: LlmUsage;
  }>;
}
