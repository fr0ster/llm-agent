/**
 * Per-section config builders extracted from resolveSmartServerConfig.
 * Internal module — not re-exported by the package barrel.
 */

import type {
  SmartServerAgentConfig,
  SmartServerConfig,
  SmartServerLlmConfig,
  SmartServerMcpConfig,
} from './smart-server.js';
import type { YamlConfig } from './yaml-loader.js';
import { get } from './yaml-loader.js';

export function resolveLlmSection(
  yaml: YamlConfig,
  apiKey: string,
): SmartServerConfig['llm'] {
  return get(yaml, 'llm')
    ? typeof get(yaml, 'llm', 'provider') === 'string'
      ? {
          provider: get(yaml, 'llm', 'provider') as
            | 'deepseek'
            | 'openai'
            | 'anthropic'
            | 'sap-ai-sdk'
            | 'ollama'
            | undefined,
          apiKey,
          url: get(yaml, 'llm', 'url') as string | undefined,
          model: get(yaml, 'llm', 'model') as string | undefined,
          temperature: Number(get(yaml, 'llm', 'temperature') ?? 0.7),
          classifierTemperature: Number(
            get(yaml, 'llm', 'classifierTemperature') ?? 0.1,
          ),
        }
      : (get(yaml, 'llm') as Record<string, SmartServerLlmConfig>)
    : undefined;
}

export function resolveRagSection(
  yaml: YamlConfig,
  args: Record<string, unknown>,
): SmartServerConfig['rag'] {
  return get(yaml, 'rag')
    ? {
        type: get(yaml, 'rag', 'type') as
          | 'in-memory'
          | 'qdrant'
          | 'hana-vector'
          | 'pg-vector'
          | undefined,
        embedder: (get(yaml, 'rag', 'embedder') as string) ?? undefined,
        url: get(yaml, 'rag', 'url') as string | undefined,
        model: get(yaml, 'rag', 'model') as string | undefined,
        collectionName:
          (args['rag-collection-name'] as string) ??
          get(yaml, 'rag', 'collectionName') ??
          undefined,
        dedupThreshold: Number(get(yaml, 'rag', 'dedupThreshold') ?? 0.92),
        vectorWeight: Number(get(yaml, 'rag', 'vectorWeight') ?? 0.7),
        keywordWeight: Number(get(yaml, 'rag', 'keywordWeight') ?? 0.3),
        ...(get(yaml, 'rag', 'resourceGroup') !== undefined
          ? { resourceGroup: String(get(yaml, 'rag', 'resourceGroup')) }
          : {}),
        ...(get(yaml, 'rag', 'scenario') !== undefined
          ? {
              scenario: String(get(yaml, 'rag', 'scenario')) as
                | 'orchestration'
                | 'foundation-models',
            }
          : {}),
      }
    : undefined;
}

export function resolveMcpSection(
  yaml: YamlConfig,
  args: Record<string, unknown>,
): SmartServerConfig['mcp'] {
  const rawMcp = yaml.mcp;
  const mcpIsArray = Array.isArray(rawMcp);
  const mcpUrl = get(yaml, 'mcp', 'url') as string | undefined;
  const mcpCommand = get(yaml, 'mcp', 'command') as string | undefined;
  const mcpTypeRaw = mcpIsArray
    ? null // array form: type resolved per-entry inside connectMcpClientsFromConfig
    : ((get(yaml, 'mcp', 'type') as string) ??
      (mcpUrl ? 'http' : mcpCommand ? 'stdio' : null));
  const mcpType = (mcpTypeRaw === 'none' ? null : mcpTypeRaw) as
    | 'http'
    | 'stdio'
    | null;

  return mcpIsArray
    ? (rawMcp as SmartServerMcpConfig[])
    : mcpType
      ? {
          type: mcpType,
          url: mcpUrl || undefined,
          command: mcpCommand || undefined,
          args:
            (args['mcp-args'] as string) || get(yaml, 'mcp', 'args')
              ? String(args['mcp-args'] || get(yaml, 'mcp', 'args')).split(' ')
              : undefined,
          headers:
            (get(yaml, 'mcp', 'headers') as Record<string, string>) ||
            undefined,
          ...(get(yaml, 'mcp', 'timeout') !== undefined
            ? { timeout: Number(get(yaml, 'mcp', 'timeout')) }
            : {}),
          ...(get(yaml, 'mcp', 'toolTimeouts') !== undefined
            ? {
                toolTimeouts: get(yaml, 'mcp', 'toolTimeouts') as Record<
                  string,
                  number
                >,
              }
            : {}),
        }
      : undefined;
}

export function resolveAgentSection(
  yaml: YamlConfig,
  args: Record<string, unknown>,
): SmartServerAgentConfig {
  return {
    externalToolsValidationMode: (get(
      yaml,
      'agent',
      'externalToolsValidationMode',
    ) ?? 'permissive') as string as 'permissive' | 'strict',
    maxIterations: Number(get(yaml, 'agent', 'maxIterations') ?? 10),
    maxToolCalls: Number(get(yaml, 'agent', 'maxToolCalls') ?? 30),
    toolUnavailableTtlMs: Number(
      get(yaml, 'agent', 'toolUnavailableTtlMs') ?? 600000,
    ),
    ragQueryK: Number(get(yaml, 'agent', 'ragQueryK') ?? 10),
    ...(get(yaml, 'agent', 'contextBudgetTokens') !== undefined
      ? {
          contextBudgetTokens: Number(
            get(yaml, 'agent', 'contextBudgetTokens'),
          ),
        }
      : {}),
    ...(get(yaml, 'agent', 'semanticHistoryEnabled') !== undefined
      ? {
          semanticHistoryEnabled: Boolean(
            get(yaml, 'agent', 'semanticHistoryEnabled'),
          ),
        }
      : {}),
    ...(get(yaml, 'agent', 'historyRecencyWindow') !== undefined
      ? {
          historyRecencyWindow: Number(
            get(yaml, 'agent', 'historyRecencyWindow'),
          ),
        }
      : {}),
    ...(get(yaml, 'agent', 'historyTurnSummaryPrompt') !== undefined
      ? {
          historyTurnSummaryPrompt: String(
            get(yaml, 'agent', 'historyTurnSummaryPrompt'),
          ),
        }
      : {}),
    showReasoning: Boolean(
      args['agent-show-reasoning'] ??
        get(yaml, 'agent', 'showReasoning') ??
        false,
    ),
    historyAutoSummarizeLimit: Number(
      get(yaml, 'agent', 'historyAutoSummarizeLimit') ?? 10,
    ),
    queryExpansionEnabled: Boolean(
      get(yaml, 'agent', 'queryExpansionEnabled') ?? false,
    ),
    toolResultCacheTtlMs: Number(
      get(yaml, 'agent', 'toolResultCacheTtlMs') ?? 300000,
    ),
    sessionTokenBudget: Number(get(yaml, 'agent', 'sessionTokenBudget') ?? 0),
    ...(get(yaml, 'agent', 'classificationEnabled') !== undefined
      ? {
          classificationEnabled: Boolean(
            get(yaml, 'agent', 'classificationEnabled'),
          ),
        }
      : {}),
    ...(get(yaml, 'agent', 'toolReselectPerIteration') !== undefined
      ? {
          toolReselectPerIteration: Boolean(
            get(yaml, 'agent', 'toolReselectPerIteration'),
          ),
        }
      : {}),
    ...(get(yaml, 'agent', 'ragTranslateEnabled') !== undefined
      ? {
          ragTranslateEnabled: Boolean(
            get(yaml, 'agent', 'ragTranslateEnabled'),
          ),
        }
      : {}),
    ...(get(yaml, 'agent', 'refreshToolsPerIteration') !== undefined
      ? {
          refreshToolsPerIteration: Boolean(
            get(yaml, 'agent', 'refreshToolsPerIteration'),
          ),
        }
      : {}),
    ...(get(yaml, 'agent', 'streamMode') !== undefined
      ? {
          streamMode: String(get(yaml, 'agent', 'streamMode')) as
            | 'full'
            | 'final',
        }
      : {}),
    ...(get(yaml, 'agent', 'llmCallStrategy') !== undefined
      ? {
          llmCallStrategy: String(get(yaml, 'agent', 'llmCallStrategy')) as
            | 'streaming'
            | 'non-streaming'
            | 'fallback',
        }
      : {}),
    ...(get(yaml, 'agent', 'heartbeatIntervalMs') !== undefined
      ? {
          heartbeatIntervalMs: Number(
            get(yaml, 'agent', 'heartbeatIntervalMs'),
          ),
        }
      : {}),
    ...(get(yaml, 'agent', 'healthTimeoutMs') !== undefined
      ? {
          healthTimeoutMs: Number(get(yaml, 'agent', 'healthTimeoutMs')),
        }
      : {}),
    ...(get(yaml, 'agent', 'retry') !== undefined
      ? {
          retry: get(yaml, 'agent', 'retry') as {
            maxAttempts?: number;
            backoffMs?: number;
            retryOn?: number[];
            retryOnMidStream?: string[];
          },
        }
      : {}),
    ...(get(yaml, 'agent', 'toolSelection') !== undefined
      ? {
          toolSelection: get(yaml, 'agent', 'toolSelection') as {
            strategy: string;
            minScore?: number;
          },
        }
      : {}),
    ...(get(yaml, 'agent', 'mcpSharedClient') !== undefined
      ? { mcpSharedClient: Boolean(get(yaml, 'agent', 'mcpSharedClient')) }
      : {}),
  };
}

export function resolvePromptsSection(
  yaml: YamlConfig,
): SmartServerConfig['prompts'] {
  const promptSystem = (get(yaml, 'prompts', 'system') as string) ?? null;
  const promptClassifier =
    (get(yaml, 'prompts', 'classifier') as string) ?? null;
  const promptReasoning = get(yaml, 'prompts', 'reasoning') ?? null;
  const promptRagTranslate = get(yaml, 'prompts', 'ragTranslate') ?? null;
  const promptHistorySummary = get(yaml, 'prompts', 'historySummary') ?? null;

  return promptSystem ||
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
    : undefined;
}

export function resolvePipelineSelection(yaml: YamlConfig): {
  pipeline?: SmartServerConfig['pipeline'];
} {
  // Pipeline selection: `pipeline: { name, config }`. `name` is required;
  // `config` is the plugin's opaque dialect (validated by the plugin's
  // parseConfig at build time). A bare string (`pipeline: stepper`) is
  // accepted as shorthand for `{ name: <string> }`.
  const raw = (yaml as { pipeline?: unknown }).pipeline;
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string') return { pipeline: { name: raw } };
  const obj = raw as { name?: unknown; config?: unknown };
  if (typeof obj.name !== 'string') {
    throw new Error(
      "pipeline: requires a 'name' (one of: flat, linear, dag, stepper, controller, controller-weak, or a registered plugin)",
    );
  }
  return {
    pipeline: {
      name: obj.name,
      ...(obj.config && typeof obj.config === 'object'
        ? { config: obj.config as Record<string, unknown> }
        : {}),
    },
  };
}
