import type { CircuitBreaker } from '../resilience/circuit-breaker.js';
import type { Message } from '../types.js';
import type {
  AgentCallOptions,
  OrchestratorError,
  SmartAgentResponse,
} from './agent-contracts.js';
import type { ILlmApiAdapter } from './api-adapter.js';
import type { ILlm } from './llm.js';
import type { IModelProvider } from './model-provider.js';
import type { IRag } from './rag.js';
import type { IRequestLogger } from './request-logger.js';
import type { LlmStreamChunk, Result } from './types.js';

// ---------------------------------------------------------------------------
// Minimal SmartAgent interface
// ---------------------------------------------------------------------------

/**
 * Public API surface of SmartAgent for consumers.
 * The full SmartAgent class lives in @mcp-abap-adt/llm-agent-libs.
 * SmartAgentHandle in llm-agent-libs uses the concrete SmartAgent type
 * via the generic SmartAgentHandle<SmartAgent> specialization.
 */
export interface ISmartAgent {
  process(
    textOrMessages: string | Message[],
    options?: AgentCallOptions,
  ): Promise<Result<SmartAgentResponse, OrchestratorError>>;
  streamProcess(
    textOrMessages: string | Message[],
    options?: AgentCallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>>;
}

// ---------------------------------------------------------------------------
// SmartAgentRagStores
// ---------------------------------------------------------------------------

/** Type alias for the RAG store map passed to SmartAgent. */
export type SmartAgentRagStores<K extends string = string> = Record<K, IRag>;

// ---------------------------------------------------------------------------
// SmartAgentHandle
// ---------------------------------------------------------------------------

/**
 * Handle returned by SmartAgentBuilder.build().
 *
 * Generic over the agent type so that:
 * - Consumers coding against the public contract use `SmartAgentHandle` (default: `ISmartAgent`).
 * - llm-agent-libs re-exports `SmartAgentHandle<SmartAgent>` to preserve full concrete typing
 *   (including internal methods like `applyConfigUpdate`, `reconfigure`, `getActiveConfig`).
 */
export interface SmartAgentHandle<T extends ISmartAgent = ISmartAgent> {
  /** The built and wired agent, ready to call .process(). */
  agent: T;
  /**
   * Direct LLM chat — bypasses SmartAgent pipeline.
   * Used by SmartServer passthrough mode to forward the full message history.
   */
  chat: ILlm['chat'];
  /** Direct LLM streaming chat. */
  streamChat: ILlm['streamChat'];
  /** Request logger for per-model usage tracking. */
  requestLogger: IRequestLogger;
  /** Gracefully close MCP connections. Call on shutdown. */
  close(): Promise<void>;
  /** Circuit breakers (empty when not configured). */
  circuitBreakers: CircuitBreaker[];
  /** RAG stores (for config hot-reload weight updates). */
  ragStores: SmartAgentRagStores;
  /** Model provider for discovery. Undefined when not available. */
  modelProvider?: IModelProvider;
  /** Look up a registered API adapter by name. */
  getApiAdapter(name: string): ILlmApiAdapter | undefined;
  /** List all registered API adapter names. */
  listApiAdapters(): string[];
}
