export class NoopQueryPreprocessor {
    name = 'noop';
    async process(text) {
        return { ok: true, value: text };
    }
}
export class NoopDocumentEnricher {
    name = 'noop';
    async enrich(text) {
        return { ok: true, value: text };
    }
}
const TRANSLATE_SYSTEM_PROMPT = 'Translate the user request to English for tool search. Focus on the ACTION verb — use specific verbs (search, list, create, read, delete, execute, check) rather than generic ones (find, get, show). Preserve technical terms, object names, and abbreviations. Reply with only the English text, no explanation.';
/**
 * Translates non-ASCII queries to English via helper LLM.
 * Passes through ASCII-only text and short text (< 15 chars) without LLM call.
 * Falls back to original text on LLM failure.
 */
export class TranslatePreprocessor {
    llm;
    requestLogger;
    systemPrompt;
    name = 'translate';
    constructor(llm, requestLogger, systemPrompt) {
        this.llm = llm;
        this.requestLogger = requestLogger;
        this.systemPrompt = systemPrompt;
    }
    async process(text, options) {
        if (/^[\p{ASCII}]+$/u.test(text) || text.length < 15) {
            return { ok: true, value: text };
        }
        try {
            const chatStart = Date.now();
            const res = await this.llm.chat([
                {
                    role: 'system',
                    content: this.systemPrompt ?? TRANSLATE_SYSTEM_PROMPT,
                },
                { role: 'user', content: text },
            ], [], options);
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
        }
        catch {
            return { ok: true, value: text };
        }
    }
}
const EXPAND_SYSTEM_PROMPT = 'Given the user query, produce expanded search terms with synonyms and related terms. Return ONLY the expanded terms, no explanation.';
/**
 * Expands queries with LLM-generated synonyms and related terms.
 * Concatenates original + expansion for broader recall.
 */
export class ExpandPreprocessor {
    llm;
    requestLogger;
    systemPrompt;
    name = 'expand';
    constructor(llm, requestLogger, systemPrompt) {
        this.llm = llm;
        this.requestLogger = requestLogger;
        this.systemPrompt = systemPrompt;
    }
    async process(text, options) {
        try {
            const chatStart = Date.now();
            const res = await this.llm.chat([
                {
                    role: 'system',
                    content: this.systemPrompt ?? EXPAND_SYSTEM_PROMPT,
                },
                { role: 'user', content: text },
            ], [], options);
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
            if (!res.ok || !res.value.content.trim()) {
                return { ok: true, value: text };
            }
            return { ok: true, value: `${text} ${res.value.content.trim()}` };
        }
        catch {
            return { ok: true, value: text };
        }
    }
}
const INTENT_ENRICHER_SYSTEM_PROMPT = `You receive a tool description with its name and parameters.
Extract the core INTENT in 3-5 short keyword phrases that a user would type when needing this tool.
Focus on WHAT the tool does, not HOW. Use simple action words.

Format: return ONLY the keyword phrases separated by commas, no explanation.

Examples:
- Input: "GetTableContents: Retrieve contents (data preview) of an ABAP database table or CDS view. Returns rows of data like SE16/SE16N."
  Output: table data preview, read table contents, SE16 data, select from table, show table rows

- Input: "SearchObject: Find, search, locate, or check if an ABAP repository object exists by name or wildcard pattern."
  Output: search object by name, find ABAP object, locate program class table, does object exist, wildcard search

- Input: "GetWhereUsed: Find where-used references for ABAP objects — classes, interfaces, function modules."
  Output: where used references, who uses this object, cross references, find usages, show dependencies`;
/**
 * Generates concise intent-based descriptions via LLM.
 * Replaces verbose tool descriptions with short keyword phrases
 * that match how users actually search.
 *
 * Output format: "ToolName: original_description\nIntent: keyword1, keyword2, ..."
 * Both original and intent are stored — BM25 matches keywords, vector matches semantics.
 */
export class IntentEnricher {
    llm;
    requestLogger;
    systemPrompt;
    name = 'intent';
    constructor(llm, requestLogger, systemPrompt) {
        this.llm = llm;
        this.requestLogger = requestLogger;
        this.systemPrompt = systemPrompt;
    }
    async enrich(text, options) {
        try {
            const chatStart = Date.now();
            const res = await this.llm.chat([
                {
                    role: 'system',
                    content: this.systemPrompt ?? INTENT_ENRICHER_SYSTEM_PROMPT,
                },
                { role: 'user', content: text },
            ], [], options);
            if (this.requestLogger) {
                this.requestLogger.logLlmCall({
                    component: 'helper',
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
            // Append intent keywords to original text — both get embedded together
            return {
                ok: true,
                value: `${text}\nIntent: ${res.value.content.trim()}`,
            };
        }
        catch {
            return { ok: true, value: text };
        }
    }
}
/**
 * Runs multiple preprocessors in sequence.
 * Output of each becomes input of the next.
 * Stops and returns error on first failure.
 */
export class PreprocessorChain {
    preprocessors;
    name;
    constructor(preprocessors) {
        this.preprocessors = preprocessors;
        this.name = preprocessors.map((p) => p.name).join('+') || 'empty';
    }
    async process(text, options) {
        let current = text;
        for (const pp of this.preprocessors) {
            const result = await pp.process(current, options);
            if (!result.ok)
                return result;
            current = result.value;
        }
        return { ok: true, value: current };
    }
}
//# sourceMappingURL=preprocessor.js.map