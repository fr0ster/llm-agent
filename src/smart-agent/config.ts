/**
 * Shared config utilities for SmartServer.
 *
 * Single source of truth for:
 *   - YAML_TEMPLATE — default config template
 *   - resolveEnvVars — ${ENV_VAR} substitution in YAML values
 *   - loadYamlConfig — read + parse + substitute a YAML file
 *   - generateConfigTemplate — write YAML_TEMPLATE to a path
 *   - resolveSmartServerConfig — merge CLI args > YAML > env vars > defaults
 */

import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { SmartServerConfig, SmartServerMode } from './smart-server.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: YAML produces unknown structure
export type YamlConfig = Record<string, any>;

export interface ResolveConfigArgs {
  port?: string | boolean;
  host?: string | boolean;
  'llm-api-key'?: string | boolean;
  'llm-model'?: string | boolean;
  'llm-temperature'?: string | boolean;
  'rag-type'?: string | boolean;
  'rag-url'?: string | boolean;
  'rag-model'?: string | boolean;
  'mcp-type'?: string | boolean;
  'mcp-url'?: string | boolean;
  'mcp-command'?: string | boolean;
  'mcp-args'?: string | boolean;
  'prompt-system'?: string | boolean;
  'prompt-classifier'?: string | boolean;
  'agent-show-reasoning'?: boolean;
  mode?: string | boolean;
}

// ---------------------------------------------------------------------------
// YAML template
// ---------------------------------------------------------------------------

export const YAML_TEMPLATE = `port: 4004
host: 0.0.0.0

# Request routing mode:
#   smart       — all requests via SmartAgent (RAG tool selection). Best for SAP/ABAP work.
#   passthrough — all requests directly to LLM (no agent). Preserves Cline XML protocol.
#   hybrid      — auto-detect: Cline client → passthrough, others → SmartAgent. (default)
mode: hybrid

llm:
  apiKey: \${DEEPSEEK_API_KEY}
  model: deepseek-chat
  temperature: 0.7
  classifierTemperature: 0.1

rag:
  type: ollama                        # ollama | in-memory
  url: http://localhost:11434
  model: nomic-embed-text
  dedupThreshold: 0.92
  vectorWeight: 0.7                   # Semantic similarity weight (0..1)
  keywordWeight: 0.3                  # Lexical matching weight (0..1)

mcp:
  # type: none | http | stdio
  # To disable MCP, set type to 'none'
  type: http
  url: http://localhost:3001/mcp/stream/http

  # Example for local stdio MCP:
  # type: stdio
  # command: node
  # args: path/to/server.js

agent:
  maxIterations: 10
  maxToolCalls: 30
  ragQueryK: 10
  showReasoning: false                # Explain strategy at start of response
  historyAutoSummarizeLimit: 10       # History length to trigger compression

# prompts:
#   system: "You are a helpful assistant specialized in SAP ABAP development."
#   classifier: |
#     You are an intent classifier. Decompose the user message into one or more subprompts and classify each as:
#       - "fact"     : critical technical constraints, rules, or domain knowledge (e.g. "ABAP Cloud forbids direct table access"). Store these for long-term reference.
#       - "state"    : project context, team roles, or temporary environmental observations (e.g. "Kristina approves decisions", "Sky is blue", "It is raining"). These represent the current situation.
#       - "feedback" : correction or evaluation of your previous response.
#       - "action"   : a request to perform a task using tools (e.g. "Read table T100", "Brew coffee").
#       - "chat"     : greetings, simple math, or small talk that doesn't need to be remembered (e.g. "Hello", "2+2").
#     Return ONLY a valid JSON array of { "type": "<type>", "text": "<subprompt text>" }.
#     If a message has multiple unrelated parts, split them into separate objects.
#   reasoning: |
#     IMPORTANT: Always start your response with a brief <reasoning> block.
#     Explain: 
#     1. Which tools you selected and why.
#     2. How you interpreted the retrieved context.
#     3. Your step-by-step strategy for the current turn.
#     The reasoning block must be visible to the user and placed at the very beginning.
#   ragTranslate: |
#     You are an SAP ABAP expert. Translate the following user request to English and expand it with relevant SAP technical terms: ABAP object types, SAP table names (e.g. TDEVC for packages, TADIR for repository objects, T100 for messages), operation keywords (read, search, filter, list, create, update), and function descriptors. This expansion is used for semantic tool search. Reply with only the expanded English terms, no explanation.
#   historySummary: |
#     Summarize the conversation so far in 2-3 sentences. Focus on the user goals and the current status of the task. Keep technical SAP terms as is.

log: smart-server.log                 # path to log file; omit for stdout

# --- Advanced pipeline config (optional) ------------------------------------
# When present, overrides / extends the flat llm / rag / mcp fields above.
# pipeline:
#   llm:
#     main:
#       provider: deepseek            # deepseek | openai | anthropic
#       apiKey: \${DEEPSEEK_API_KEY}
#       model: deepseek-chat
#       temperature: 0.7
#     classifier:                     # optional; if absent, main config is reused at 0.1 temp
#       provider: openai
#       apiKey: \${OPENAI_API_KEY}
#       model: gpt-4o-mini
#       temperature: 0.1
#
#   rag:
#     facts:
#       type: ollama
#       url: http://localhost:11434
#       model: nomic-embed-text
#       dedupThreshold: 0.92
#     feedback:
#       type: in-memory
#     state:
#       type: in-memory
#
#   mcp:
#     - type: http
#       url: http://sap-server:3000/mcp/stream/http
#     - type: stdio
#       command: npx
#       args: [github-mcp-server]
`;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function resolveEnvVars(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnvVars(v, env));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveEnvVars(v, env)]),
    );
  }
  return value;
}

export function loadYamlConfig(filePath: string, env: NodeJS.ProcessEnv = process.env): YamlConfig {
  const raw = fs.readFileSync(filePath, 'utf8');
  return resolveEnvVars(parseYaml(raw), env) as YamlConfig;
}

export function generateConfigTemplate(outputPath: string): void {
  fs.writeFileSync(outputPath, YAML_TEMPLATE, 'utf8');
}

// ---------------------------------------------------------------------------
// Config resolver
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: helper for nested get
const get = (obj: any, ...keys: string[]): any => keys.reduce((o, k) => o?.[k], obj);

/**
 * Merge: CLI args > YAML config > env vars > defaults.
 * Throws Error if no API key can be resolved — caller must catch and exit(1).
 * When pipeline.llm.main is present its apiKey is used as fallback, so the
 * flat llm.apiKey is not required.
 */
export function resolveSmartServerConfig(
  args: ResolveConfigArgs = {},
  yaml: YamlConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): Omit<SmartServerConfig, 'log'> {
  const flatApiKey =
    (args['llm-api-key'] as string | undefined) ??
    get(yaml, 'llm', 'apiKey') ??
    env['DEEPSEEK_API_KEY'] ??
    '';

  // pipeline.llm.main.apiKey serves as fallback when the flat section is absent
  const pipelineApiKey = get(yaml, 'pipeline', 'llm', 'main', 'apiKey') as string | undefined;
  const hasPipelineLlm = !!get(yaml, 'pipeline', 'llm', 'main');

  const apiKey = flatApiKey || pipelineApiKey || '';

  if (!apiKey && !hasPipelineLlm) {
    throw new Error(
      'LLM API key is required. Set --llm-api-key, YAML llm.apiKey, DEEPSEEK_API_KEY, or pipeline.llm.main.apiKey.',
    );
  }

  const mcpUrl = (args['mcp-url'] as string | undefined) ?? get(yaml, 'mcp', 'url') ?? env['MCP_ENDPOINT'];
  const mcpCommand =
    (args['mcp-command'] as string | undefined) ?? get(yaml, 'mcp', 'command') ?? env['MCP_COMMAND'];
  const mcpTypeRaw = (args['mcp-type'] as string | undefined) ?? get(yaml, 'mcp', 'type') ?? (mcpUrl ? 'http' : mcpCommand ? 'stdio' : null);
  const mcpType = (mcpTypeRaw === 'none' ? null : mcpTypeRaw) as 'http' | 'stdio' | null;

  const promptSystem =
    (args['prompt-system'] as string | undefined) ??
    get(yaml, 'prompts', 'system') ??
    env['PROMPT_SYSTEM'] ??
    null;
  const promptClassifier =
    (args['prompt-classifier'] as string | undefined) ??
    get(yaml, 'prompts', 'classifier') ??
    env['PROMPT_CLASSIFIER'] ??
    null;
  const promptReasoning = get(yaml, 'prompts', 'reasoning') ?? null;
  const promptRagTranslate = get(yaml, 'prompts', 'ragTranslate') ?? null;
  const promptHistorySummary = get(yaml, 'prompts', 'historySummary') ?? null;

  return {
    port: Number((args['port'] as string | undefined) ?? get(yaml, 'port') ?? env['PORT'] ?? 4004),
    host: (args['host'] as string | undefined) ?? get(yaml, 'host') ?? '0.0.0.0',

    llm: {
      apiKey,
      model:
        (args['llm-model'] as string | undefined) ??
        get(yaml, 'llm', 'model') ??
        env['DEEPSEEK_MODEL'] ??
        'deepseek-chat',
      temperature: Number(
        (args['llm-temperature'] as string | undefined) ?? get(yaml, 'llm', 'temperature') ?? 0.7,
      ),
      classifierTemperature: Number(get(yaml, 'llm', 'classifierTemperature') ?? 0.1),
    },

    rag: {
      type: ((args['rag-type'] as string | undefined) ?? get(yaml, 'rag', 'type') ?? 'ollama') as
        | 'ollama'
        | 'in-memory',
      url:
        (args['rag-url'] as string | undefined) ??
        get(yaml, 'rag', 'url') ??
        env['OLLAMA_URL'] ??
        'http://localhost:11434',
      model:
        (args['rag-model'] as string | undefined) ??
        get(yaml, 'rag', 'model') ??
        env['OLLAMA_EMBED_MODEL'] ??
        'nomic-embed-text',
      dedupThreshold: Number(get(yaml, 'rag', 'dedupThreshold') ?? 0.92),
      vectorWeight: Number(get(yaml, 'rag', 'vectorWeight') ?? 0.7),
      keywordWeight: Number(get(yaml, 'rag', 'keywordWeight') ?? 0.3),
    },

    mcp: mcpType
      ? {
          type: mcpType,
          url: mcpUrl || undefined,
          command: mcpCommand || undefined,
          args: ((args['mcp-args'] as string | undefined) ?? get(yaml, 'mcp', 'args'))
            ? String((args['mcp-args'] as string | undefined) ?? get(yaml, 'mcp', 'args')).split(' ')
            : undefined,
        }
      : undefined,

    agent: {
      maxIterations: Number(get(yaml, 'agent', 'maxIterations') ?? 10),
      maxToolCalls: Number(get(yaml, 'agent', 'maxToolCalls') ?? 30),
      ragQueryK: Number(get(yaml, 'agent', 'ragQueryK') ?? 10),
      showReasoning: Boolean(args['agent-show-reasoning'] ?? get(yaml, 'agent', 'showReasoning') ?? false),
      historyAutoSummarizeLimit: Number(get(yaml, 'agent', 'historyAutoSummarizeLimit') ?? 10),
    },

    prompts:
      promptSystem || promptClassifier || promptReasoning || promptRagTranslate || promptHistorySummary
        ? {
            ...(promptSystem ? { system: promptSystem } : {}),
            ...(promptClassifier ? { classifier: promptClassifier } : {}),
            ...(promptReasoning ? { reasoning: promptReasoning } : {}),
            ...(promptRagTranslate ? { ragTranslate: promptRagTranslate } : {}),
            ...(promptHistorySummary ? { historySummary: promptHistorySummary } : {}),
          }
        : undefined,

    mode: (
      (args['mode'] as string | undefined) ??
      get(yaml, 'mode') ??
      env['SMART_AGENT_MODE'] ??
      'hybrid'
    ) as SmartServerMode,

    // Pass through pipeline config as-is — env-var substitution was already applied
    // by loadYamlConfig, so no further transformation is needed here.
    ...(yaml.pipeline ? { pipeline: yaml.pipeline } : {}),
  };
}
