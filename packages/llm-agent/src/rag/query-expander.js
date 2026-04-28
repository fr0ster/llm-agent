import { RagError } from '../interfaces/types.js';
export class NoopQueryExpander {
  async expand(query, _options) {
    return { ok: true, value: query };
  }
}
const EXPAND_SYSTEM_PROMPT =
  'Given the user query, produce an expanded search query with synonyms and related terms. Return ONLY the expanded query text, no explanation.';
export class LlmQueryExpander {
  llm;
  requestLogger;
  constructor(llm, requestLogger) {
    this.llm = llm;
    this.requestLogger = requestLogger;
  }
  async expand(query, options) {
    try {
      const chatStart = Date.now();
      const res = await this.llm.chat(
        [
          { role: 'system', content: EXPAND_SYSTEM_PROMPT },
          { role: 'user', content: query },
        ],
        [],
        options,
      );
      if (this.requestLogger) {
        this.requestLogger.logLlmCall({
          component: 'query-expander',
          model: this.llm.model ?? 'unknown',
          promptTokens: res.ok ? (res.value.usage?.promptTokens ?? 0) : 0,
          completionTokens: res.ok
            ? (res.value.usage?.completionTokens ?? 0)
            : 0,
          totalTokens: res.ok ? (res.value.usage?.totalTokens ?? 0) : 0,
          durationMs: Date.now() - chatStart,
        });
      }
      if (!res.ok) {
        return {
          ok: false,
          error: new RagError(res.error.message, 'QUERY_EXPAND_ERROR'),
        };
      }
      const expanded = res.value.content.trim();
      if (!expanded) {
        return { ok: true, value: query };
      }
      // Concatenate original + expansion for broader recall
      return { ok: true, value: `${query} ${expanded}` };
    } catch (err) {
      return {
        ok: false,
        error: new RagError(
          `Query expansion failed: ${String(err)}`,
          'QUERY_EXPAND_ERROR',
        ),
      };
    }
  }
}
//# sourceMappingURL=query-expander.js.map
