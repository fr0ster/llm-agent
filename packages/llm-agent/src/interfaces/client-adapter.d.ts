/**
 * Contract for adapting agent responses to a specific client format.
 *
 * Some clients (e.g. Cline) are prompt-based agents that expect tool
 * calls formatted as XML inside the assistant `content` field rather
 * than as native OpenAI `tool_calls`.  A client adapter detects such
 * clients and wraps the final response accordingly.
 */
export interface IClientAdapter {
  /** Human-readable name used in logs. */
  readonly name: string;
  /**
   * Return `true` if this adapter should handle the given request.
   * Called once per request with the client's system prompt (if any).
   */
  detect(systemPrompt: string): boolean;
  /**
   * Wrap the final assistant content before it is sent to the client.
   * Only called when {@link detect} returned `true` for this request.
   */
  wrapResponse(content: string): string;
}
//# sourceMappingURL=client-adapter.d.ts.map
