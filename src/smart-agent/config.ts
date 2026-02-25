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
  'rag-provider'?: string | boolean;
  'rag-api-key'?: string | boolean;
  'rag-type'?: string | boolean;
  'rag-url'?: string | boolean;
  'rag-model'?: string | boolean;
  'mcp-type'?: string | boolean;
  'mcp-url'?: string | boolean;
  'mcp-command'?: string | boolean;
  'mcp-args'?: string | boolean;
  'prompt-system'?: string | boolean;
  'prompt-classifier'?: string | boolean;
  mode?: string | boolean;
}

// ---------------------------------------------------------------------------
// YAML template
// ---------------------------------------------------------------------------

export const YAML_TEMPLATE = `port: 3001
host: 0.0.0.0

# Request routing mode:
#   hard        — client system prompt and tools ignored; agent builds everything from user text.
#   smart       — preserves client history and tools; augments with RAG context.
#   passthrough — all requests directly to LLM (no agent). Preserves Cline XML protocol.
#   hybrid      — auto-detect: Cline client → passthrough, others → smart. (default)
mode: hybrid

# Flat llm: section always uses the DeepSeek adapter.
# To use OpenAI or Anthropic as the main LLM, use pipeline.llm.main below instead.
llm:
  apiKey: \${DEEPSEEK_API_KEY}
  model: deepseek-chat
  temperature: 0.7
  classifierTemperature: 0.1

rag:
  provider: ollama                    # openai | ollama | in-memory
  url: http://localhost:11434         # Ollama base URL (ignored when provider: openai)
  model: nomic-embed-text             # nomic-embed-text | text-embedding-3-small | etc.
  dedupThreshold: 0.92
  # apiKey: \${OPENAI_API_KEY}         # required when provider: openai
  # timeoutMs: 30000                  # embed HTTP timeout in ms (ollama retries 3× with backoff)

mcp:
  type: http                          # http | stdio
  url: http://localhost:3000/mcp/stream/http
  # type: stdio
  # command: node
  # args: path/to/mcp-server/dist/index.js

agent:
  maxIterations: 10
  maxToolCalls: 30
  ragQueryK: 10
  # ragMinScore: 0.55                 # min cosine score to include a tool in LLM context (0 = off)
                                    # Depends on embedding model: nomic-embed-text scores ~0.40 for
                                    # unrelated pairs, so use 0.50+ to filter irrelevant tools.
  # timeoutMs: 120000                 # overall request pipeline timeout in ms

# ---------------------------------------------------------------------------
# Prompts — all optional. Shown below with their built-in defaults so you can
# inspect and customise any part of the agent's instruction set.
# Uncomment and edit to override. Set ragTranslation: "" to disable translation.
# ---------------------------------------------------------------------------
# prompts:
#
#   # Prepended to every LLM context window. Sets the overall persona and
#   # tool-use policy. Keep domain-agnostic to avoid biasing the LLM.
#   system: >-
#     You are a helpful AI assistant. Answer any question you can directly
#     and accurately. When the user request requires a tool, use the available
#     tools. For all other requests — including general knowledge,
#     calculations, or conversation — answer without tools.
#
#   # Decomposes user messages into typed subprompts (fact / feedback / state /
#   # action). The LLM must return a JSON array of { "type", "text" } objects.
#   classifier: >-
#     You are an intent classifier. Given a user message, decompose it into
#     one or more subprompts and classify each as exactly one of:
#       - "fact"     : a factual statement to remember
#       - "feedback" : a correction or evaluation of a previous response
#       - "state"    : current user context / preferences / session state
#       - "action"   : a request to do something or answer a question
#     Return ONLY a valid JSON array with no markdown fences.
#     Each element: { "type": "<type>", "text": "<subprompt text>" }
#     If the message fits one intent, return a single-element array.
#
#   # Translates non-ASCII queries to English for cross-lingual RAG tool matching.
#   # MCP tool descriptions are always in English; translation improves matching.
#   # Set to "" to disable (when using a multilingual embedding model).
#   # Do NOT add domain context here — neutral phrasing preserves user intent.
#   ragTranslation: >-
#     Translate the following text to English, preserving the exact original
#     intent. Do not add domain-specific context or reinterpret ambiguous
#     words. Reply with only the translation, no explanation.
#
#   # Appended to the system prompt when debug.llmReasoning: true.
#   reasoning: >-
#     Before every response, tool call, or decision, explain your reasoning
#     inside <thinking>...</thinking> tags. Be thorough and show your thought
#     process. After the thinking block, give your actual response.

log: smart-server.log                 # path to log file; omit for stdout

# debug:
#   llmReasoning: true   # inject reasoning instruction into system prompt; parse <thinking> blocks
#   sessions: ./sessions # per-request session debug directory; omit to disable
#                        # Each request creates <sessions>/<timestamp>-<id>/events.ndjson with:
#                        #   client_request, rag_translate, rag_query, tools_selected,
#                        #   llm_context, llm_request, llm_response, client_response

# --- Advanced pipeline config (optional) ------------------------------------
# When present, overrides / extends the flat llm / rag / mcp fields above.
# Use pipeline.llm.main to select a non-DeepSeek LLM provider.
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
#       provider: openai              # openai | ollama | in-memory
#       apiKey: \${OPENAI_API_KEY}
#       model: text-embedding-3-small
#       dedupThreshold: 0.92
#       # url: https://custom-openai-compatible/v1
#       # timeoutMs: 30000
#     feedback:
#       provider: in-memory
#     state:
#       provider: in-memory
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
  const mcpType = (
    (args['mcp-type'] as string | undefined) ??
    get(yaml, 'mcp', 'type') ??
    (mcpUrl ? 'http' : mcpCommand ? 'stdio' : null)
  ) as 'http' | 'stdio' | null;

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
  const promptRagTranslation =
    get(yaml, 'prompts', 'ragTranslation') ??
    env['PROMPT_RAG_TRANSLATION'] ??
    null;
  const promptReasoning =
    get(yaml, 'prompts', 'reasoning') ??
    env['PROMPT_REASONING'] ??
    null;

  return {
    port: Number((args['port'] as string | undefined) ?? get(yaml, 'port') ?? env['PORT'] ?? 3001),
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
      provider: (
        (args['rag-provider'] as string | undefined) ??
        get(yaml, 'rag', 'provider') ??
        (args['rag-type'] as string | undefined) ??
        get(yaml, 'rag', 'type') ??
        env['RAG_PROVIDER'] ??
        'ollama'
      ) as 'openai' | 'ollama' | 'in-memory',
      apiKey:
        (args['rag-api-key'] as string | undefined) ??
        get(yaml, 'rag', 'apiKey') ??
        env['RAG_API_KEY'] ??
        undefined,
      url:
        (args['rag-url'] as string | undefined) ??
        get(yaml, 'rag', 'url') ??
        env['OLLAMA_URL'] ??
        'http://localhost:11434',
      model:
        (args['rag-model'] as string | undefined) ??
        get(yaml, 'rag', 'model') ??
        env['OLLAMA_EMBED_MODEL'] ??
        undefined,
      dedupThreshold: Number(get(yaml, 'rag', 'dedupThreshold') ?? 0.92),
      timeoutMs: get(yaml, 'rag', 'timeoutMs') !== undefined
        ? Number(get(yaml, 'rag', 'timeoutMs'))
        : undefined,
    },

    mcp: mcpType
      ? {
          type: mcpType,
          url: mcpUrl,
          command: mcpCommand,
          args: ((args['mcp-args'] as string | undefined) ?? get(yaml, 'mcp', 'args'))
            ? String((args['mcp-args'] as string | undefined) ?? get(yaml, 'mcp', 'args')).split(' ')
            : undefined,
        }
      : undefined,

    agent: {
      maxIterations: Number(get(yaml, 'agent', 'maxIterations') ?? 10),
      maxToolCalls: Number(get(yaml, 'agent', 'maxToolCalls') ?? 30),
      ragQueryK: Number(get(yaml, 'agent', 'ragQueryK') ?? 10),
      ...(get(yaml, 'agent', 'ragMinScore') !== undefined
        ? { ragMinScore: Number(get(yaml, 'agent', 'ragMinScore')) }
        : {}),
      ...(get(yaml, 'agent', 'timeoutMs') !== undefined
        ? { timeoutMs: Number(get(yaml, 'agent', 'timeoutMs')) }
        : {}),
    },

    prompts:
      promptSystem !== null || promptClassifier !== null || promptRagTranslation !== null || promptReasoning !== null
        ? {
            ...(promptSystem !== null ? { system: promptSystem } : {}),
            ...(promptClassifier !== null ? { classifier: promptClassifier } : {}),
            ...(promptRagTranslation !== null ? { ragTranslation: promptRagTranslation } : {}),
            ...(promptReasoning !== null ? { reasoning: promptReasoning } : {}),
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

    debug: {
      llmReasoning:
        Boolean(get(yaml, 'debug', 'llmReasoning')) ||
        env['DEBUG_LLM_REASON'] === 'true' ||
        false,
      ...(get(yaml, 'debug', 'sessions') !== undefined
        ? { sessions: String(get(yaml, 'debug', 'sessions')) }
        : env['DEBUG_SESSIONS'] ? { sessions: env['DEBUG_SESSIONS'] } : {}),
    },
  };
}
