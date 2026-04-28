/**
 * Contract for adapting agent responses to a specific client format.
 *
 * Some clients (e.g. Cline) are prompt-based agents that expect tool
 * calls formatted as XML inside the assistant `content` field rather
 * than as native OpenAI `tool_calls`.  A client adapter detects such
 * clients and wraps the final response accordingly.
 */
export {};
//# sourceMappingURL=client-adapter.js.map