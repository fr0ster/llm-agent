/**
 * Minimal test-double factories for core package tests.
 *
 * Only exports stubs that depend solely on core interfaces.
 * Full test helpers (SmartAgent stubs, etc.) live in @mcp-abap-adt/llm-agent-server.
 */
import type { ILlm, IRag } from '../interfaces/index.js';
import {
  type LlmFinishReason,
  type LlmToolCall,
  type RagResult,
} from '../interfaces/types.js';
export declare function makeLlm(
  responses: Array<
    | {
        content: string;
        toolCalls?: LlmToolCall[];
        finishReason?: LlmFinishReason;
      }
    | Error
  >,
): ILlm & {
  callCount: number;
};
export declare function makeRag(queryResults?: RagResult[]): IRag & {
  upsertCalls: string[];
};
//# sourceMappingURL=index.d.ts.map
