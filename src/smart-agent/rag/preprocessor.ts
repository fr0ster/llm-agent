import type { ILlm } from '../interfaces/llm.js';
import type { IRequestLogger } from '../interfaces/request-logger.js';
import type { CallOptions, RagError, Result } from '../interfaces/types.js';

/**
 * Transforms query text before RAG search.
 * Used for translation, expansion, normalization, etc.
 * Runs inside IRag.query() before embedding.
 */
export interface IQueryPreprocessor {
  readonly name: string;
  process(
    text: string,
    options?: CallOptions,
  ): Promise<Result<string, RagError>>;
}

/**
 * Enriches document text before RAG storage.
 * Used for adding translations, synonyms, example queries, etc.
 * Runs inside IRag.upsert() before embedding.
 */
export interface IDocumentEnricher {
  readonly name: string;
  enrich(
    text: string,
    options?: CallOptions,
  ): Promise<Result<string, RagError>>;
}

export class NoopQueryPreprocessor implements IQueryPreprocessor {
  readonly name = 'noop';
  async process(text: string): Promise<Result<string, RagError>> {
    return { ok: true, value: text };
  }
}

export class NoopDocumentEnricher implements IDocumentEnricher {
  readonly name = 'noop';
  async enrich(text: string): Promise<Result<string, RagError>> {
    return { ok: true, value: text };
  }
}

const TRANSLATE_SYSTEM_PROMPT =
  'Translate the user request to English for search purposes. Preserve technical terms, object names, and abbreviations. Reply with only the English text, no explanation.';

/**
 * Translates non-ASCII queries to English via helper LLM.
 * Passes through ASCII-only text and short text (< 15 chars) without LLM call.
 * Falls back to original text on LLM failure.
 */
export class TranslatePreprocessor implements IQueryPreprocessor {
  readonly name = 'translate';

  constructor(
    private readonly llm: ILlm,
    private readonly requestLogger?: IRequestLogger,
    private readonly systemPrompt?: string,
  ) {}

  async process(
    text: string,
    options?: CallOptions,
  ): Promise<Result<string, RagError>> {
    if (/^[\p{ASCII}]+$/u.test(text) || text.length < 15) {
      return { ok: true, value: text };
    }

    try {
      const chatStart = Date.now();
      const res = await this.llm.chat(
        [
          {
            role: 'system' as const,
            content: this.systemPrompt ?? TRANSLATE_SYSTEM_PROMPT,
          },
          { role: 'user' as const, content: text },
        ],
        [],
        options,
      );
      if (this.requestLogger) {
        this.requestLogger.logLlmCall({
          component: 'translate',
          model: this.llm.model ?? 'unknown',
          promptTokens: res.ok ? (res.value.usage?.promptTokens ?? 0) : 0,
          completionTokens: res.ok
            ? (res.value.usage?.completionTokens ?? 0)
            : 0,
          totalTokens: res.ok ? (res.value.usage?.totalTokens ?? 0) : 0,
          durationMs: Date.now() - chatStart,
        });
      }

      if (!res.ok || !res.value.content.trim()) {
        return { ok: true, value: text };
      }

      return { ok: true, value: res.value.content.trim() };
    } catch {
      return { ok: true, value: text };
    }
  }
}
