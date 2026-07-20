/**
 * Plugin-pipeline contracts. A pipeline plugin is the implementation of an agent
 * variant; it builds an IPipelineInstance (the runnable agent + a disposal hook).
 * Core-only types — the server hides its config behind the opaque resolveLlm(role)
 * so these contracts never import server/libs types.
 */
import type { ILogger } from '../logger/types.js';
import type { IAuxiliaryMcpTools } from './auxiliary-mcp-tools.js';
import type { ISmartAgent } from './builder.js';
import type { IKnowledgeRagHandle, IToolsRagHandle } from './knowledge-rag.js';
import type { ILlm } from './llm.js';
import type { IMcpClient } from './mcp-client.js';
import type { IMcpFailureClassifier } from './mcp-failure-classifier.js';
import type { IRagRegistry } from './rag.js';
import type { LlmCallEntry } from './request-logger.js';
import type {
  IRunExecutionControl,
  IStepExecutionControl,
} from './step-execution-control.js';
import type { ToolLoopContextStrategyFactory } from './tool-loop-context-strategy.js';
import type { IWaitStrategy } from './wait-strategy.js';

/** A value that may already be resolved or arrive as a promise. */
export type MaybePromise<T> = T | Promise<T>;

/** A SmartAgent that supports runtime LLM hot-swap. Feature-detected by the host. */
export interface IReconfigurableSmartAgent extends ISmartAgent {
  reconfigure(update: {
    mainLlm?: ILlm;
    helperLlm?: ILlm;
    classifierLlm?: ILlm;
  }): void;
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
  mcpFailureClassifier?: IMcpFailureClassifier;
  toolLoopContextStrategyFactory?: ToolLoopContextStrategyFactory;
  /** Consumer-swappable per-step execution control (timeout / tool-call budget).
   *  Injected via `BuildAgentDeps`; falls back to `DefaultStepExecutionControl` in
   *  the controller pipeline when absent. No-op semantics when undefined. */
  stepExecutionControl?: IStepExecutionControl;
  /** Consumer-swappable per-run execution control (max steps / run timeout).
   *  Injected via `BuildAgentDeps`; falls back to `NoopRunExecutionControl` in the
   *  controller pipeline when absent. No-op semantics when undefined. */
  runExecutionControl?: IRunExecutionControl;
  /** Consumer-swappable auxiliary/service MCP tools contributed at pipeline
   *  creation (e.g. `wait`). Undefined → the pipeline supplies its own default. */
  auxiliaryMcpTools?: IAuxiliaryMcpTools;
  /** Consumer-swappable wait mechanism for controller `wait` steps. Injected via
   *  `BuildAgentDeps`; falls back to `DefaultWaitStrategy` in the controller
   *  pipeline when absent. */
  waitStrategy?: IWaitStrategy;
}

/** A pipeline plugin = the implementation of an agent variant. It names itself,
 *  validates its own config dialect, and builds the agent. */
export interface IPipelinePlugin<Config = unknown> {
  readonly name: string;
  parseConfig(raw: unknown): Config;
  build(config: Config, ctx: IPipelineContext): Promise<IPipelineInstance>;
}
