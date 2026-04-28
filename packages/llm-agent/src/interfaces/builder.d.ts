import type { AgentCallOptions, OrchestratorError, SmartAgentResponse } from './agent-contracts.js';
import type { IRag } from './rag.js';
import type { LlmStreamChunk, Result } from './types.js';
import type { Message } from '../types.js';
/**
 * Public API surface of SmartAgent for consumers.
 * The full SmartAgent class lives in @mcp-abap-adt/llm-agent-server.
 * SmartAgentHandle in llm-agent-server uses the concrete SmartAgent type.
 */
export interface ISmartAgent {
    process(textOrMessages: string | Message[], options?: AgentCallOptions): Promise<Result<SmartAgentResponse, OrchestratorError>>;
    streamProcess(textOrMessages: string | Message[], options?: AgentCallOptions): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>>;
}
/** Type alias for the RAG store map passed to SmartAgent. */
export type SmartAgentRagStores<K extends string = string> = Record<K, IRag>;
//# sourceMappingURL=builder.d.ts.map