/**
 * Plugin-pipeline contracts. A pipeline plugin is the implementation of an agent
 * variant; it builds an IPipelineInstance (the runnable agent + a disposal hook).
 * Core-only types — the server hides its config behind the opaque resolveLlm(role)
 * so these contracts never import server/libs types.
 */
import type { ILogger } from '../logger/types.js';
import type { ISmartAgent } from './builder.js';
import type { IKnowledgeRagHandle, IToolsRagHandle } from './knowledge-rag.js';
import type { ILlm } from './llm.js';
import type { IMcpClient } from './mcp-client.js';
import type { IRagRegistry } from './rag.js';
import type { LlmCallEntry } from './request-logger.js';

/** A value that may already be resolved or arrive as a promise. */
export type MaybePromise<T> = T | Promise<T>;

/** A SmartAgent that supports runtime LLM hot-swap. Feature-detected by the host. */
export interface IReconfigurableSmartAgent extends ISmartAgent {
  reconfigure(update: { mainLlm?: ILlm; helperLlm?: ILlm; classifierLlm?: ILlm }): void;
}

/** What IPipelinePlugin.build() returns: the runnable agent + a disposal contract
 *  so the host can free MCP / RAG / session resources on recreate or shutdown. */
export interface IPipelineInstance {
  readonly agent: ISmartAgent;
  /** May be a no-op; required so recreate/shutdown never leaks resources. */
  close(): Promise<void>;
}

/** Infra handles the host provides to a pipeline. NOT the flow — the pipeline owns
 *  its flow. Core-only; the server closes over its own config behind resolveLlm. */
export interface IPipelineContext {
  /** Opaque per-role LLM. The server closes over SmartServerLlmConfig/llmMap. */
  resolveLlm(role: string): Promise<ILlm>;
  /** Session-scoped knowledge RAG handle. MaybePromise: may need async init. */
  knowledgeRagFor(sessionId: string): MaybePromise<IKnowledgeRagHandle>;
  /** Tools RAG handle. Always present: the host supplies an EMPTY handle when no
   *  tools RAG is configured, so the contract stays stable for no-RAG deployments. */
  toolsRag: IToolsRagHandle;
  ragRegistry?: IRagRegistry;
  callMcp(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  mcpClients?: IMcpClient[];
  subagents?: ReadonlyArray<{ name: string; description?: string }>;
  mintStepperId(): string;
  mintTurnId(): string;
  logger?: ILogger;
  logLlmCall?(entry: LlmCallEntry): void;
}
