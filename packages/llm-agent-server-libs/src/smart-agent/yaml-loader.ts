import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';

export type YamlConfig = Record<string, unknown>;

export const YAML_TEMPLATE = `port: 4004
host: 0.0.0.0

# Request routing mode:
#   hard        — Fully managed context. Ignores client history/system prompt. Uses RAG + internal MCP tools only.
#   pass        — Transparent proxy. Logs everything but modifies nothing.
#   smart       — Hybrid. Preserves client history but enriches it with RAG context and MCP tools based on analysis. (default)
mode: smart

llm:
  provider: deepseek                  # deepseek | openai | anthropic | sap-ai-sdk | ollama
  apiKey: \${DEEPSEEK_API_KEY}        # not required for ollama / sap-ai-sdk
  model: deepseek-chat
  temperature: 0.7
  classifierTemperature: 0.1

rag:
  type: in-memory                     # in-memory | qdrant | hana-vector | pg-vector
  embedder: ollama                    # Embedder to use: ollama | openai | sap-ai-core | <custom>
  url: http://localhost:11434
  model: bge-m3
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

# --- Advanced Multi-Model LLM (optional) ------------------------------------
# Assign different models for different internal roles via a top-level llm: map.
# (The legacy pipeline.llm override was removed — use the top-level llm: map now.)
# llm:
#   main:
#     provider: deepseek              # deepseek | openai | anthropic | sap-ai-sdk
#     apiKey: \${DEEPSEEK_API_KEY}
#     model: deepseek-chat
#     temperature: 0.7
#   classifier:                       # optional; if absent, main config is reused
#     provider: deepseek
#     apiKey: \${DEEPSEEK_API_KEY}
#     model: deepseek-chat
#     temperature: 0.1
#   helper:                           # optional; if absent, main config is reused
#     provider: deepseek
#     apiKey: \${DEEPSEEK_API_KEY}
#     model: deepseek-chat
#     temperature: 0.1

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
# plugins:                            # Explicit plugin module specifiers (npm packages or paths)
#   - "@scope/my-pipeline-plugin"     #   bare specifier resolved from cwd
#   - ./local-plugin.mjs              #   relative path resolved against cwd

# subagents:                          # Optional: nested agents callable from pipeline
#   - name: code-reviewer             # Used as stage config: { agent: code-reviewer }
#     description: |                  # Optional. Shown to the Coordinator planner LLM
#       Reviews code and returns      # so it can pick this agent for the right step.
#       structured JSON.
#     config: ./agents/code-reviewer.yaml

# pipeline:                           # Optional: select the request pipeline.
#   name: flat                        # flat (default) | linear | dag | stepper | controller | controller-weak | <plugin>
#   config:                           # Opaque per-pipeline dialect (validated by the plugin)
#     mode: planned-react             # e.g. stepper: cyclic-react | planned-react | deep-stepper
#     knowledgeSeed: []               # stepper: deployment-supplied tool guidance
#
# NOTE: the legacy 'coordinator:' block and the old 'pipeline:' shape
# (mcp/rag/stages/llm overrides) were REMOVED in this major. A config that
# still uses them fails loud at startup. Top-level 'llm:', 'mcp:', 'rag:' now
# own those concerns; pipeline behavior moves under 'pipeline.config'.
`;

export const get = (obj: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((o, k) => {
    if (o !== null && typeof o === 'object' && k in o) {
      return (o as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);

export function resolveEnvVars(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  if (typeof value === 'string')
    return value.replace(
      /\$\{([^}:]+)(?::-(.*?))?\}/g,
      (_, name, fallback) => env[name] || fallback || '',
    );
  if (Array.isArray(value)) return value.map((v) => resolveEnvVars(v, env));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        resolveEnvVars(v, env),
      ]),
    );
  return value;
}

export function loadYamlConfig(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): YamlConfig {
  const raw = fs.readFileSync(filePath, 'utf8');
  return resolveEnvVars(parseYaml(raw), env) as YamlConfig;
}

export function generateConfigTemplate(outputPath: string): void {
  fs.writeFileSync(outputPath, YAML_TEMPLATE, 'utf8');
}
