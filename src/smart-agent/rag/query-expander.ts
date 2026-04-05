import type { ILlm } from '../interfaces/llm.js';
import type { IRequestLogger } from '../interfaces/request-logger.js';
import {
  type CallOptions,
  RagError,
  type Result,
} from '../interfaces/types.js';

export interface IQueryExpander {
  expand(
    query: string,
    options?: CallOptions,
  ): Promise<Result<string, RagError>>;
}

export class NoopQueryExpander implements IQueryExpander {
  async expand(
    query: string,
    _options?: CallOptions,
  ): Promise<Result<string, RagError>> {
    return { ok: true, value: query };
  }
}

const EXPAND_SYSTEM_PROMPT =
  'Given the user query, produce an expanded search query with synonyms and related terms. Return ONLY the expanded query text, no explanation.';

export class LlmQueryExpander implements IQueryExpander {
  constructor(
    private readonly llm: ILlm,
    private readonly requestLogger?: IRequestLogger,
  ) {}

  async expand(
    query: string,
    options?: CallOptions,
  ): Promise<Result<string, RagError>> {
    try {
      const chatStart = Date.now();
      const res = await this.llm.chat(
        [
          { role: 'system' as const, content: EXPAND_SYSTEM_PROMPT },
          { role: 'user' as const, content: query },
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
