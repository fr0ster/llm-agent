/**
 * Config and handle types for SmartAgentBuilder.
 *
 * Public input/output shapes for the builder, relocated from builder.ts
 * so embed-as-library users can import the config contract without pulling
 * in the full builder implementation. Re-exported by builder.ts for API
 * stability.
 */

import type {
  IModelProvider,
  SmartAgentHandle as SmartAgentHandleBase,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgent, SmartAgentConfig } from './agent.js';
import type { SessionPolicy } from './policy/types.js';

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface BuilderMcpConfig {
  type: 'http' | 'stdio';
  /** HTTP: MCP endpoint URL */
  url?: string;
  /** stdio: command to spawn */
  command?: string;
  /** stdio: command arguments */
  args?: string[];
  /** HTTP headers (e.g. x-sap-destination for reverse proxy routing) */
  headers?: Record<string, string>;
}

export interface BuilderPromptsConfig {
  /** Preamble prepended to the ContextAssembler system message. */
  system?: string;
  /** Override the intent-classifier system prompt. */
  classifier?: string;
  /** Instruction for the reasoning/strategy block. */
  reasoning?: string;
  /** Prompt for query translation for RAG. */
  ragTranslate?: string;
  /** Prompt for history summarization. */
  historySummary?: string;
}

export interface SmartAgentBuilderConfig {
  /** MCP connection(s). Pass an array to connect multiple servers simultaneously. */
  mcp?: BuilderMcpConfig | BuilderMcpConfig[];
  /** SmartAgent orchestration limits. */
  agent?: Partial<SmartAgentConfig>;
  /** System / classifier prompt overrides. */
  prompts?: BuilderPromptsConfig;
  /** Data governance policy for RAG records. */
  sessionPolicy?: SessionPolicy;
  /** Skip startup model validation (useful for testing). Default: false. */
  skipModelValidation?: boolean;
  /** Attempts for the startup model-validation chat before aborting — lenient
   *  retry on ANY transient failure (e.g. a SAP AI Core deployment-list blip at
   *  boot). Default 3. */
  modelValidationAttempts?: number;
  /** Base backoff between startup-validation attempts (× attempt number).
   *  Default 2000ms. */
  modelValidationBackoffMs?: number;
}

// ---------------------------------------------------------------------------
// Handle returned by build()
// ---------------------------------------------------------------------------

/**
 * SmartAgentHandle specialized for the concrete SmartAgent class.
 *
 * This re-exports the generic SmartAgentHandle from @mcp-abap-adt/llm-agent
 * with SmartAgent as the type parameter, preserving full concrete typing
 * (including internal methods like `applyConfigUpdate`, `reconfigure`,
 * `getActiveConfig`) for callers in llm-agent-libs and llm-agent-server.
 */
export type SmartAgentHandle = SmartAgentHandleBase<SmartAgent>;

// ---------------------------------------------------------------------------
// Private type guard (package-internal, not in index.ts)
// ---------------------------------------------------------------------------

export function isModelProvider(obj: unknown): obj is IModelProvider {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    typeof (obj as IModelProvider).getModels === 'function' &&
    typeof (obj as IModelProvider).getModel === 'function'
  );
}
