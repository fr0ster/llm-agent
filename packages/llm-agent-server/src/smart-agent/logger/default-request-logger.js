const CATEGORY_MAP = {
    'tool-loop': 'request',
    classifier: 'auxiliary',
    translate: 'auxiliary',
    'query-expander': 'auxiliary',
    helper: 'auxiliary',
    embedding: 'initialization',
};
function emptyBucket() {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
}
function addToBucket(bucket, entry) {
    bucket.promptTokens += entry.promptTokens;
    bucket.completionTokens += entry.completionTokens;
    bucket.totalTokens += entry.totalTokens;
    bucket.requests++;
}
export class DefaultRequestLogger {
    initLlmCalls = [];
    requestLlmCalls = [];
    ragQueryEntries = [];
    toolCallEntries = [];
    requestStartMs = 0;
    requestDurationMs = 0;
    startRequest() {
        this.requestLlmCalls = [];
        this.ragQueryEntries = [];
        this.toolCallEntries = [];
        this.requestDurationMs = 0;
        this.requestStartMs = Date.now();
    }
    endRequest() {
        this.requestDurationMs = this.requestStartMs
            ? Date.now() - this.requestStartMs
            : 0;
    }
    logLlmCall(entry) {
        if (entry.scope === 'initialization') {
            this.initLlmCalls.push(entry);
        }
        else {
            this.requestLlmCalls.push(entry);
        }
    }
    logRagQuery(entry) {
        this.ragQueryEntries.push(entry);
    }
    logToolCall(entry) {
        this.toolCallEntries.push(entry);
    }
    getSummary() {
        const byModel = {};
        const byComponent = {};
        const byCategory = {};
        const allCalls = [...this.initLlmCalls, ...this.requestLlmCalls];
        for (const call of allCalls) {
            if (!byModel[call.model])
                byModel[call.model] = emptyBucket();
            addToBucket(byModel[call.model], call);
            if (!byComponent[call.component])
                byComponent[call.component] = emptyBucket();
            addToBucket(byComponent[call.component], call);
            const cat = CATEGORY_MAP[call.component] ?? 'request';
            if (!byCategory[cat])
                byCategory[cat] = emptyBucket();
            addToBucket(byCategory[cat], call);
        }
        return {
            byModel,
            byComponent,
            byCategory,
            ragQueries: this.ragQueryEntries.length,
            toolCalls: this.toolCallEntries.length,
            totalDurationMs: this.requestDurationMs,
        };
    }
    reset() {
        this.requestLlmCalls = [];
        this.ragQueryEntries = [];
        this.toolCallEntries = [];
        this.requestStartMs = 0;
        this.requestDurationMs = 0;
        // NOTE: initLlmCalls is intentionally NOT reset
    }
}
//# sourceMappingURL=default-request-logger.js.map