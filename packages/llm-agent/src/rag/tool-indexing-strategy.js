// ---------------------------------------------------------------------------
// Original — current behavior: "Tool: name — description"
// ---------------------------------------------------------------------------
/**
 * Indexes the raw tool description as-is.
 * This is the current default behavior.
 */
export class OriginalToolIndexing {
    name = 'original';
    async prepare(tool) {
        return [
            {
                id: `tool:${tool.name}`,
                text: `${tool.name}: ${tool.description}`,
            },
        ];
    }
}
// ---------------------------------------------------------------------------
// Intent — LLM generates concise keyword phrases
// ---------------------------------------------------------------------------
const INTENT_PROMPT = `You receive a tool description with its name and parameters.
Extract the core INTENT in 3-5 short keyword phrases that a user would type when needing this tool.
Focus on WHAT the tool does, not HOW. Use simple action words.

Format: return ONLY the keyword phrases separated by commas, no explanation.

Examples:
- Input: "GetTableContents: Retrieve contents (data preview) of an ABAP database table or CDS view."
  Output: table data preview, read table contents, SE16 data, select from table, show table rows

- Input: "SearchObject: Find, search, locate, or check if an ABAP repository object exists by name or wildcard pattern."
  Output: search object by name, find ABAP object, locate program class table, does object exist, wildcard search`;
/**
 * LLM generates concise intent keywords for the tool.
 * Indexed alongside the original for broader keyword coverage.
 */
export class IntentToolIndexing {
    llm;
    requestLogger;
    name = 'intent';
    constructor(llm, requestLogger) {
        this.llm = llm;
        this.requestLogger = requestLogger;
    }
    async prepare(tool, options) {
        const inputText = `${tool.name}: ${tool.description}`;
        try {
            const chatStart = Date.now();
            const res = await this.llm.chat([
                { role: 'system', content: INTENT_PROMPT },
                { role: 'user', content: inputText },
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
            if (!res.ok || !res.value.content.trim())
                return [];
            return [
                {
                    id: `tool:${tool.name}:intent`,
                    text: `${tool.name}: ${res.value.content.trim()}`,
                },
            ];
        }
        catch {
            return [];
        }
    }
}
// ---------------------------------------------------------------------------
// Synonym — adds action verb synonyms
// ---------------------------------------------------------------------------
const ACTION_SYNONYMS = {
    read: ['show', 'display', 'view', 'get', 'retrieve'],
    create: ['add', 'new', 'make', 'generate'],
    update: ['modify', 'change', 'edit', 'set'],
    delete: ['remove', 'drop', 'destroy'],
    search: ['find', 'locate', 'lookup', 'discover'],
    list: ['show all', 'enumerate', 'browse'],
    run: ['execute', 'start', 'launch', 'trigger'],
    check: ['validate', 'verify', 'test', 'inspect'],
    get: ['read', 'fetch', 'retrieve', 'show'],
    activate: ['enable', 'publish', 'deploy'],
};
/**
 * Adds action verb synonyms to the tool description.
 * E.g. "ReadClass" → also indexed with "show class, display class, view class".
 * Purely deterministic — no LLM needed.
 */
export class SynonymToolIndexing {
    name = 'synonym';
    async prepare(tool) {
        const nameLower = tool.name.toLowerCase();
        const synonymPhrases = [];
        for (const [verb, synonyms] of Object.entries(ACTION_SYNONYMS)) {
            if (nameLower.startsWith(verb)) {
                const objectPart = tool.name
                    .replace(/^[A-Z][a-z]+/, '') // Remove first word (the verb)
                    .replace(/([A-Z])/g, ' $1') // CamelCase to spaces
                    .trim()
                    .toLowerCase();
                if (objectPart) {
                    for (const syn of synonyms) {
                        synonymPhrases.push(`${syn} ${objectPart}`);
                    }
                }
                break;
            }
        }
        if (synonymPhrases.length === 0)
            return [];
        return [
            {
                id: `tool:${tool.name}:synonym`,
                text: `${tool.name}: ${synonymPhrases.join(', ')}`,
            },
        ];
    }
}
//# sourceMappingURL=tool-indexing-strategy.js.map