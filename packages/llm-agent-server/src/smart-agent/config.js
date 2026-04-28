/**
 * Shared config utilities for SmartServer.
 */
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
export const YAML_TEMPLATE = `port: 4004
host: 0.0.0.0

# Request routing mode:
#   hard        — Fully managed context. Ignores client history/system prompt. Uses RAG + internal MCP tools only.
#   pass        — Transparent proxy. Logs everything but modifies nothing.
#   smart       — Hybrid. Preserves client history but enriches it with RAG context and MCP tools based on analysis. (default)
mode: smart

llm:
  apiKey: \${DEEPSEEK_API_KEY}
  model: deepseek-chat
  temperature: 0.7
  classifierTemperature: 0.1

rag:
  type: ollama                        # ollama | in-memory | qdrant | hana-vector | pg-vector
  # embedder: ollama                  # Embedder to use: ollama | openai | sap-ai-core | <custom>
  url: http://localhost:11434
  model: nomic-embed-text
  # resourceGroup: default            # SAP AI Core resource group (sap-ai-core embedder)
  # scenario: orchestration           # SAP AI Core scenario: orchestration (default) | foundation-models
  # collectionName: llm-agent         # Collection/table name (qdrant | hana-vector | pg-vector)
  dedupThreshold: 0.92
  vectorWeight: 0.7                   # Semantic similarity weight (0..1)
  keywordWeight: 0.3                  # Lexical matching weight (0..1)

mcp:
  # type: none | http | stdio
  # To disable MCP, set type to 'none'
  type: http
  url: http://localhost:3001/mcp/stream/http

agent:
  externalToolsValidationMode: permissive  # permissive | strict
  maxIterations: 10
  maxToolCalls: 30
  toolUnavailableTtlMs: 600000       # Temporary tool blacklist TTL (ms)
  ragQueryK: 10
  # contextBudgetTokens: 4000          # Max tokens for RAG context in system prompt (0 = no limit)
  # semanticHistoryEnabled: false      # Enable semantic history via RAG
  # historyRecencyWindow: 4            # Last N messages from client history in LLM context
  # historyTurnSummaryPrompt: "..."    # LLM prompt for turn summarization
  showReasoning: false                # Explain strategy at start of response
  historyAutoSummarizeLimit: 10       # History length to trigger compression
  queryExpansionEnabled: false        # Expand RAG queries with LLM-generated synonyms
  toolResultCacheTtlMs: 300000       # Tool result cache TTL (ms); 0 to disable
  sessionTokenBudget: 0              # Multi-turn token budget; 0 to disable
  # ragTranslateEnabled: true        # Translate non-ASCII RAG queries to English (default: true)
  # classificationEnabled: false     # Enable for custom pipelines with multi-store routing
  # toolReselectPerIteration: false  # Re-select tools via RAG on each tool-loop iteration
  # llmCallStrategy: streaming       # streaming | non-streaming | fallback
  # streamMode: full                 # full | final — streaming behavior for tool loops
  # heartbeatIntervalMs: 5000       # SSE heartbeat interval during tool execution (ms)
  # healthTimeoutMs: 5000            # Health check probe timeout (ms); increase for slow providers (SAP AI Core: 15000)
  # retry:                           # LLM retry config for 429/5xx errors
  #   maxAttempts: 3
  #   backoffMs: 1000
  #   retryOn: [429, 500, 502, 503]
  #   retryOnMidStream: ['SSE stream']  # Substrings triggering mid-stream retry

# --- Advanced Multi-Model Pipeline (optional) -------------------------------
# Use this section to assign different models for different internal tasks.
# pipeline:
#   llm:
#     main:
#       provider: deepseek            # deepseek | openai | anthropic | sap-ai-sdk
#       apiKey: \${DEEPSEEK_API_KEY}
#       model: deepseek-chat
#       temperature: 0.7
#       streaming: true               # false to disable streaming for this provider
#     classifier:                     # optional; if absent, main config is reused
#       provider: deepseek
#       apiKey: \${DEEPSEEK_API_KEY}
#       model: deepseek-chat
#       temperature: 0.1
#     helper:                         # optional; if absent, main config is reused
#       provider: deepseek
#       apiKey: \${DEEPSEEK_API_KEY}
#       model: deepseek-chat
#       temperature: 0.1
#
#   rag:
#     tools:
#       type: qdrant
#       url: http://qdrant:6333
#       embedder: openai              # ollama | openai | <custom registered name>
#       model: text-embedding-3-small
#       apiKey: \${OPENAI_API_KEY}
#     history:
#       type: in-memory
#
#   mcp:
#     - type: http
#       url: http://localhost:3001/mcp/stream/http

# --- Structured Pipeline (optional) -------------------------------------------
# Replaces the hardcoded orchestration flow with a YAML-defined stage tree.
# When absent, the default flow runs unchanged (full backwards compatibility).
#
# pipeline:
#   version: "1"
#   stages:
#     - id: classify
#       type: classify
#     - id: summarize
#       type: summarize
#     - id: rag-retrieval
#       type: parallel
#       when: "shouldRetrieve"
#       stages:
#         - { id: translate, type: translate }
#         - { id: expand, type: expand }
#       after:
#         - id: rag-queries
#           type: parallel
#           stages:
#             - { id: tools, type: rag-query, config: { store: tools, k: 10 } }
#             - { id: history, type: rag-query, config: { store: history, k: 5 } }
#         - { id: rerank, type: rerank }
#         - { id: tool-select, type: tool-select }
#     - id: assemble
#       type: assemble
#     - id: tool-loop
#       type: tool-loop

# prompts:
#   system: "You are a helpful assistant specialized in SAP ABAP development."
#   classifier: |
#     You are an intent classifier... (see source for full default prompt)
#   reasoning: |
#     IMPORTANT: Always start your response with a brief <reasoning> block...
#   ragTranslate: |
#     Translate the user request to English for search purposes...
#   historySummary: |
#     Summarize the conversation so far...

log: smart-server.log                 # path to log file; omit for stdout
# logDir: sessions                    # Directory for detailed session debug logs
# pluginDir: ./my-plugins             # Additional plugin directory (loaded after defaults)
`;
export function resolveEnvVars(value, env = process.env) {
    if (typeof value === 'string')
        return value.replace(/\$\{([^}:]+)(?::-(.*?))?\}/g, (_, name, fallback) => env[name] || fallback || '');
    if (Array.isArray(value))
        return value.map((v) => resolveEnvVars(v, env));
    if (value !== null && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [
            k,
            resolveEnvVars(v, env),
        ]));
    return value;
}
export function loadYamlConfig(filePath, env = process.env) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return resolveEnvVars(parseYaml(raw), env);
}
export function generateConfigTemplate(outputPath) {
    fs.writeFileSync(outputPath, YAML_TEMPLATE, 'utf8');
}
const get = (obj, ...keys) => keys.reduce((o, k) => {
    if (o !== null && typeof o === 'object' && k in o) {
        return o[k];
    }
    return undefined;
}, obj);
export function resolveSmartServerConfig(args = {}, yaml = {}, env = process.env) {
    const flatApiKey = args['llm-api-key'] ??
        get(yaml, 'llm', 'apiKey') ??
        env.DEEPSEEK_API_KEY ??
        '';
    const pipelineApiKey = get(yaml, 'pipeline', 'llm', 'main', 'apiKey');
    const apiKey = flatApiKey || pipelineApiKey || '';
    if (!apiKey && !get(yaml, 'pipeline', 'llm', 'main'))
        throw new Error('LLM API key is required');
    const mcpUrl = args['mcp-url'] ?? get(yaml, 'mcp', 'url') ?? env.MCP_ENDPOINT;
    const mcpCommand = args['mcp-command'] ??
        get(yaml, 'mcp', 'command') ??
        env.MCP_COMMAND;
    const mcpTypeRaw = args['mcp-type'] ??
        get(yaml, 'mcp', 'type') ??
        (mcpUrl ? 'http' : mcpCommand ? 'stdio' : null);
    const mcpType = (mcpTypeRaw === 'none' ? null : mcpTypeRaw);
    const promptSystem = args['prompt-system'] ??
        get(yaml, 'prompts', 'system') ??
        env.PROMPT_SYSTEM ??
        null;
    const promptClassifier = args['prompt-classifier'] ??
        get(yaml, 'prompts', 'classifier') ??
        env.PROMPT_CLASSIFIER ??
        null;
    const promptReasoning = get(yaml, 'prompts', 'reasoning') ?? null;
    const promptRagTranslate = get(yaml, 'prompts', 'ragTranslate') ?? null;
    const promptHistorySummary = get(yaml, 'prompts', 'historySummary') ?? null;
    return {
        port: Number(args.port ?? get(yaml, 'port') ?? env.PORT ?? 4004),
        host: args.host ?? get(yaml, 'host') ?? '0.0.0.0',
        llm: {
            apiKey,
            model: args['llm-model'] ??
                get(yaml, 'llm', 'model') ??
                env.DEEPSEEK_MODEL ??
                'deepseek-chat',
            temperature: Number(args['llm-temperature'] ??
                get(yaml, 'llm', 'temperature') ??
                0.7),
            classifierTemperature: Number(get(yaml, 'llm', 'classifierTemperature') ?? 0.1),
        },
        rag: {
            type: (args['rag-type'] ??
                get(yaml, 'rag', 'type') ??
                'ollama'),
            embedder: get(yaml, 'rag', 'embedder') ?? undefined,
            url: args['rag-url'] ??
                get(yaml, 'rag', 'url') ??
                env.OLLAMA_URL ??
                'http://localhost:11434',
            model: args['rag-model'] ??
                get(yaml, 'rag', 'model') ??
                env.OLLAMA_EMBED_MODEL ??
                'nomic-embed-text',
            collectionName: args['rag-collection-name'] ??
                get(yaml, 'rag', 'collectionName') ??
                undefined,
            dedupThreshold: Number(get(yaml, 'rag', 'dedupThreshold') ?? 0.92),
            vectorWeight: Number(args['rag-vector-weight'] ?? get(yaml, 'rag', 'vectorWeight') ?? 0.7),
            keywordWeight: Number(args['rag-keyword-weight'] ?? get(yaml, 'rag', 'keywordWeight') ?? 0.3),
            ...(get(yaml, 'rag', 'resourceGroup') !== undefined
                ? { resourceGroup: String(get(yaml, 'rag', 'resourceGroup')) }
                : {}),
            ...(get(yaml, 'rag', 'scenario') !== undefined
                ? {
                    scenario: String(get(yaml, 'rag', 'scenario')),
                }
                : {}),
        },
        mcp: mcpType
            ? {
                type: mcpType,
                url: mcpUrl || undefined,
                command: mcpCommand || undefined,
                args: args['mcp-args'] || get(yaml, 'mcp', 'args')
                    ? String(args['mcp-args'] || get(yaml, 'mcp', 'args')).split(' ')
                    : undefined,
                headers: get(yaml, 'mcp', 'headers') ||
                    undefined,
            }
            : undefined,
        agent: {
            externalToolsValidationMode: (get(yaml, 'agent', 'externalToolsValidationMode') ?? 'permissive'),
            maxIterations: Number(get(yaml, 'agent', 'maxIterations') ?? 10),
            maxToolCalls: Number(get(yaml, 'agent', 'maxToolCalls') ?? 30),
            toolUnavailableTtlMs: Number(get(yaml, 'agent', 'toolUnavailableTtlMs') ?? 600000),
            ragQueryK: Number(get(yaml, 'agent', 'ragQueryK') ?? 10),
            ...(get(yaml, 'agent', 'contextBudgetTokens') !== undefined
                ? {
                    contextBudgetTokens: Number(get(yaml, 'agent', 'contextBudgetTokens')),
                }
                : {}),
            ...(get(yaml, 'agent', 'semanticHistoryEnabled') !== undefined
                ? {
                    semanticHistoryEnabled: Boolean(get(yaml, 'agent', 'semanticHistoryEnabled')),
                }
                : {}),
            ...(get(yaml, 'agent', 'historyRecencyWindow') !== undefined
                ? {
                    historyRecencyWindow: Number(get(yaml, 'agent', 'historyRecencyWindow')),
                }
                : {}),
            ...(get(yaml, 'agent', 'historyTurnSummaryPrompt') !== undefined
                ? {
                    historyTurnSummaryPrompt: String(get(yaml, 'agent', 'historyTurnSummaryPrompt')),
                }
                : {}),
            showReasoning: Boolean(args['agent-show-reasoning'] ??
                get(yaml, 'agent', 'showReasoning') ??
                false),
            historyAutoSummarizeLimit: Number(get(yaml, 'agent', 'historyAutoSummarizeLimit') ?? 10),
            queryExpansionEnabled: Boolean(get(yaml, 'agent', 'queryExpansionEnabled') ?? false),
            toolResultCacheTtlMs: Number(get(yaml, 'agent', 'toolResultCacheTtlMs') ?? 300000),
            sessionTokenBudget: Number(get(yaml, 'agent', 'sessionTokenBudget') ?? 0),
            ...(get(yaml, 'agent', 'classificationEnabled') !== undefined
                ? {
                    classificationEnabled: Boolean(get(yaml, 'agent', 'classificationEnabled')),
                }
                : {}),
            ...(get(yaml, 'agent', 'toolReselectPerIteration') !== undefined
                ? {
                    toolReselectPerIteration: Boolean(get(yaml, 'agent', 'toolReselectPerIteration')),
                }
                : {}),
            ...(get(yaml, 'agent', 'ragTranslateEnabled') !== undefined
                ? {
                    ragTranslateEnabled: Boolean(get(yaml, 'agent', 'ragTranslateEnabled')),
                }
                : {}),
            ...(get(yaml, 'agent', 'refreshToolsPerIteration') !== undefined
                ? {
                    refreshToolsPerIteration: Boolean(get(yaml, 'agent', 'refreshToolsPerIteration')),
                }
                : {}),
            ...(get(yaml, 'agent', 'streamMode') !== undefined
                ? {
                    streamMode: String(get(yaml, 'agent', 'streamMode')),
                }
                : {}),
            ...(get(yaml, 'agent', 'llmCallStrategy') !== undefined
                ? {
                    llmCallStrategy: String(get(yaml, 'agent', 'llmCallStrategy')),
                }
                : {}),
            ...(get(yaml, 'agent', 'heartbeatIntervalMs') !== undefined
                ? {
                    heartbeatIntervalMs: Number(get(yaml, 'agent', 'heartbeatIntervalMs')),
                }
                : {}),
            ...(get(yaml, 'agent', 'healthTimeoutMs') !== undefined
                ? {
                    healthTimeoutMs: Number(get(yaml, 'agent', 'healthTimeoutMs')),
                }
                : {}),
            ...(get(yaml, 'agent', 'retry') !== undefined
                ? {
                    retry: get(yaml, 'agent', 'retry'),
                }
                : {}),
        },
        prompts: promptSystem ||
            promptClassifier ||
            promptReasoning ||
            promptRagTranslate ||
            promptHistorySummary
            ? {
                ...(promptSystem ? { system: promptSystem } : {}),
                ...(promptClassifier ? { classifier: promptClassifier } : {}),
                ...(typeof promptReasoning === 'string'
                    ? { reasoning: promptReasoning }
                    : {}),
                ...(typeof promptRagTranslate === 'string'
                    ? { ragTranslate: promptRagTranslate }
                    : {}),
                ...(typeof promptHistorySummary === 'string'
                    ? { historySummary: promptHistorySummary }
                    : {}),
            }
            : undefined,
        mode: (args.mode ??
            get(yaml, 'mode') ??
            env.SMART_AGENT_MODE ??
            'hybrid'),
        logDir: args['log-dir'] ?? get(yaml, 'logDir') ?? null,
        pluginDir: args['plugin-dir'] ?? get(yaml, 'pluginDir') ?? undefined,
        ...(yaml.pipeline ? { pipeline: yaml.pipeline } : {}),
        ...(yaml.skills
            ? {
                skills: {
                    type: (get(yaml, 'skills', 'type') ?? 'claude'),
                    dirs: get(yaml, 'skills', 'dirs'),
                    projectRoot: get(yaml, 'skills', 'projectRoot'),
                },
            }
            : {}),
    };
}
//# sourceMappingURL=config.js.map