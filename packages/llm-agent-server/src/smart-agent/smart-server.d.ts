/**
 * SmartServer — embeddable OpenAI-compatible HTTP server backed by SmartAgent.
 */
import type { EmbedderFactory, IClientAdapter, IEmbedder, ILlmApiAdapter, IMcpClient, IRequestLogger, ISkillManager } from '@mcp-abap-adt/llm-agent';
import type { IModelResolver } from './interfaces/model-resolver.js';
import type { PipelineConfig } from './pipeline.js';
import type { IPluginLoader } from './plugins/types.js';
export interface SmartServerLlmConfig {
    apiKey: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    classifierTemperature?: number;
}
export interface SmartServerRagConfig {
    type?: 'ollama' | 'openai' | 'in-memory' | 'qdrant' | 'hana-vector' | 'pg-vector';
    /**
     * Embedder name — resolved from the embedder factory registry.
     * Built-in: 'ollama', 'openai'. Consumers can register custom factories.
     * When omitted, defaults to 'ollama'.
     */
    embedder?: string;
    url?: string;
    model?: string;
    collectionName?: string;
    dedupThreshold?: number;
    vectorWeight?: number;
    keywordWeight?: number;
    connectionString?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    schema?: string;
    dimension?: number;
    autoCreateSchema?: boolean;
    poolMax?: number;
    connectTimeout?: number;
    /** SAP AI Core resource group (used when embedder is 'sap-ai-core' / 'sap-aicore'). */
    resourceGroup?: string;
    /**
     * SAP AI Core scenario for the embedding model deployment.
     * `'orchestration'` (default) uses the SAP SDK; `'foundation-models'` calls the REST inference API.
     */
    scenario?: 'orchestration' | 'foundation-models';
}
export interface SmartServerMcpConfig {
    type: 'http' | 'stdio';
    url?: string;
    command?: string;
    args?: string[];
    headers?: Record<string, string>;
}
export interface SmartServerAgentConfig {
    externalToolsValidationMode?: 'permissive' | 'strict';
    maxIterations?: number;
    maxToolCalls?: number;
    toolUnavailableTtlMs?: number;
    ragQueryK?: number;
    contextBudgetTokens?: number;
    semanticHistoryEnabled?: boolean;
    historyRecencyWindow?: number;
    historyTurnSummaryPrompt?: string;
    showReasoning?: boolean;
    historyAutoSummarizeLimit?: number;
    queryExpansionEnabled?: boolean;
    toolResultCacheTtlMs?: number;
    sessionTokenBudget?: number;
    /** Whether classification stage runs. Default: true. */
    classificationEnabled?: boolean;
    /** LLM call strategy for tool-loop. 'streaming' (default) | 'non-streaming' | 'fallback'. */
    llmCallStrategy?: 'streaming' | 'non-streaming' | 'fallback';
}
export interface SmartServerPromptsConfig {
    system?: string;
    classifier?: string;
    reasoning?: string;
    ragTranslate?: string;
    historySummary?: string;
}
export interface SmartServerSkillsConfig {
    /** Manager type: 'claude' | 'codex' | 'filesystem'. Default: 'claude'. */
    type?: 'claude' | 'codex' | 'filesystem';
    /** Custom directories (filesystem type only). */
    dirs?: string[];
    /** Project root for relative skill dirs (claude/codex types). Defaults to cwd. */
    projectRoot?: string;
}
export type SmartServerMode = 'hard' | 'pass' | 'smart';
export interface SmartServerCircuitBreakerConfig {
    /** Number of consecutive failures before opening. Default: 5 */
    failureThreshold?: number;
    /** Time (ms) to wait before probing again. Default: 30 000 */
    recoveryWindowMs?: number;
}
export interface SmartServerConfig {
    port?: number;
    host?: string;
    llm: SmartServerLlmConfig;
    rag?: SmartServerRagConfig;
    mcp?: SmartServerMcpConfig;
    agent?: SmartServerAgentConfig;
    prompts?: SmartServerPromptsConfig;
    mode?: SmartServerMode;
    pipeline?: PipelineConfig;
    log?: (event: Record<string, unknown>) => void;
    logDir?: string;
    circuitBreaker?: SmartServerCircuitBreakerConfig;
    version?: string;
    /** Path to YAML config file for hot-reload. */
    configFile?: string;
    /** Additional plugin directory (merged with defaults). Used by the default FileSystemPluginLoader. */
    pluginDir?: string;
    /** Custom plugin loader. When set, replaces the default FileSystemPluginLoader. */
    pluginLoader?: IPluginLoader;
    /** Pre-built embedder injected via DI. Takes precedence over config-driven selection. */
    embedder?: IEmbedder;
    /** Named embedder factories for YAML-driven selection (merged with built-ins). */
    embedderFactories?: Record<string, EmbedderFactory>;
    /**
     * Skill discovery configuration from YAML.
     *
     * `type`: Manager variant — `'claude'` | `'codex'` | `'filesystem'`.
     * `dirs`: Custom directories (filesystem type only).
     * `projectRoot`: Project root for relative skill dirs (claude/codex types).
     *
     * When omitted and no `skillManager` is injected, skills are disabled.
     */
    skills?: SmartServerSkillsConfig;
    /** Pre-built skill manager injected via DI. Takes precedence over `skills` config. */
    skillManager?: ISkillManager;
    /** Pre-built MCP clients injected via DI. Takes precedence over `mcp` config. */
    mcpClients?: IMcpClient[];
    /** Client adapters for auto-detecting prompt-based clients (e.g. Cline). */
    clientAdapters?: IClientAdapter[];
    /** Whether to include usage stats in SSE stream. Default: true. */
    reportUsage?: boolean;
    /** API protocol adapters injected via DI. Merged with built-in adapters (openai, anthropic). */
    apiAdapters?: ILlmApiAdapter[];
    /** Disable built-in adapter auto-registration. Default: false. */
    disableBuiltInAdapters?: boolean;
    /** Skip startup model validation (useful for testing). Default: false. */
    skipModelValidation?: boolean;
    /** Model resolver for PUT /v1/config model changes. When not set, model updates are rejected with 400. */
    modelResolver?: IModelResolver;
}
export interface SmartServerHandle {
    port: number;
    close(): Promise<void>;
    requestLogger: IRequestLogger;
}
export { generateConfigTemplate, loadYamlConfig, type ResolveConfigArgs, resolveEnvVars, resolveSmartServerConfig, YAML_TEMPLATE, type YamlConfig, } from './config.js';
export declare class SmartServer {
    private readonly cfg;
    private readonly noop;
    constructor(config: SmartServerConfig);
    start(): Promise<SmartServerHandle>;
    private _handle;
    private _handleAdapterRequest;
    private _handleChat;
    /** Whitelisted agent config fields allowed via PUT /v1/config. */
    private static readonly AGENT_CONFIG_FIELDS;
    private _handleConfigUpdate;
}
//# sourceMappingURL=smart-server.d.ts.map