// src/smart-agent/interfaces/api-adapter.ts
import type { Message } from '../../types.js';
import type {
  AgentCallOptions,
  OrchestratorError,
  SmartAgentResponse,
} from './agent-contracts.js';
import type { LlmStreamChunk, Result } from './types.js';

export interface ApiSseEvent {
  /**
   * Optional SSE event name.
   * - Anthropic: "message_start", "content_block_delta", ...
   * - OpenAI: omitted (OpenAI SSE has no `event:` field)
   */
  event?: string;

  /**
   * Already-serialized SSE data payload.
   * Consumer writes verbatim after `data: `.
   */
  data: string;
}

export interface ApiRequestContext {
  readonly adapterName: string;
  readonly protocol: Record<string, unknown>;
}

export interface NormalizedRequest {
  messages: Message[];
  stream: boolean;
  options?: AgentCallOptions;
  context: ApiRequestContext;
}

export interface ILlmApiAdapter {
  readonly name: string;

  normalizeRequest(request: unknown): NormalizedRequest;

  transformStream(
    source: AsyncIterable<Result<LlmStreamChunk, OrchestratorError>>,
    context: ApiRequestContext,
  ): AsyncIterable<ApiSseEvent>;

  formatResult(
    response: SmartAgentResponse,
    context: ApiRequestContext,
  ): unknown;

  formatError?(error: OrchestratorError, context: ApiRequestContext): unknown;
}

export class AdapterValidationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'AdapterValidationError';
  }
}
