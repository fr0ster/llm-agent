/**
 * Client adapter for Cline (VS Code AI extension).
 *
 * Cline is a prompt-based agent: it describes tools as XML in the system
 * prompt and expects the LLM to respond with XML tool calls in `content`.
 * When a task is complete, Cline requires the response to be wrapped in
 * `<attempt_completion>` XML.
 *
 * This adapter detects Cline by its system prompt signature and wraps
 * the final response accordingly.
 */
export class ClineClientAdapter {
  name = 'cline';
  detect(systemPrompt) {
    return systemPrompt.includes('You are Cline');
  }
  wrapResponse(content) {
    return `<attempt_completion>\n<result>\n${content}\n</result>\n</attempt_completion>`;
  }
}
//# sourceMappingURL=cline-client-adapter.js.map
