import type { McpError } from './types.js';

export type McpFailureKind = 'unavailable' | 'tool-error';

/** Consumer-owned strategy: decide whether a failed MCP tool call means the
 *  SERVER is unavailable (fail loud) or is a tool-level error (feed back to the
 *  LLM). `probeHealth` (optional) lets an impl authoritatively confirm via the
 *  server's health method (MCP `ping`, behind IMcpClient.healthCheck). */
export interface IMcpFailureClassifier {
  classify(
    error: McpError,
    probeHealth?: () => Promise<boolean>,
  ): Promise<McpFailureKind>;
}
