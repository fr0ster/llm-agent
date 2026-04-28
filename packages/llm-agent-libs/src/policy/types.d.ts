import { SmartAgentError } from '@mcp-abap-adt/llm-agent';
export declare class PolicyError extends SmartAgentError {
  constructor(message: string, code?: string);
}
export declare class PromptInjectionError extends SmartAgentError {
  constructor(message: string);
}
export interface PolicyVerdict {
  allowed: boolean;
  /** Human-readable reason for blocking. Only present when allowed=false. */
  reason?: string;
}
/**
 * Configuration for ToolPolicyGuard.
 * If allowlist is set, only listed tools are permitted (denylist ignored).
 * If only denylist is set, listed tools are blocked.
 * If neither is set, all tools are allowed.
 */
export interface ToolPolicyConfig {
  allowlist?: string[];
  denylist?: string[];
}
export interface IToolPolicy {
  check(toolName: string): PolicyVerdict;
}
export interface DetectionResult {
  detected: boolean;
  /** Label of the first matched pattern. Only present when detected=true. */
  pattern?: string;
}
export interface IPromptInjectionDetector {
  detect(text: string): DetectionResult;
}
/**
 * Session-scoped data governance policy.
 * Controls RAG record retention and namespace isolation.
 */
export interface SessionPolicy {
  /**
   * Maximum age of RAG records in ms.
   * Converted to a TTL Unix timestamp on upsert: ttl = (Date.now() + maxSessionAgeMs) / 1000.
   * When undefined, records do not expire.
   */
  maxSessionAgeMs?: number;
  /**
   * Logical namespace for all RAG records in this session, e.g. "tenant/user/session".
   * Propagated to RagMetadata.namespace on every upsert call.
   */
  namespace?: string;
}
//# sourceMappingURL=types.d.ts.map
