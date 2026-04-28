/**
 * DeepSeek LLM Provider — extends OpenAI (DeepSeek uses OpenAI-compatible API).
 */
import { OpenAIProvider } from '@mcp-abap-adt/openai-llm';
export class DeepSeekProvider extends OpenAIProvider {
    providerName = 'DeepSeek';
    constructor(config) {
        super({
            ...config,
            baseURL: config.baseURL || 'https://api.deepseek.com/v1',
            model: config.model || 'deepseek-chat',
        });
    }
    /**
     * DeepSeek always uses max_tokens (no gpt-5/o1/o3 distinction).
     */
    getTokenLimitParam(_model, maxTokens) {
        return { max_tokens: maxTokens };
    }
    async getEmbeddingModels() {
        return [];
    }
    /**
     * Stricter formatMessages — tracks known tool_call_ids and drops orphans.
     */
    formatMessages(messages) {
        const formatted = [];
        const knownToolCallIds = new Set();
        for (const msg of messages) {
            const entry = {
                role: msg.role,
                content: msg.content ?? '',
            };
            if (msg.role === 'assistant' &&
                msg.tool_calls &&
                msg.tool_calls.length > 0) {
                entry.tool_calls = msg.tool_calls;
                entry.content = msg.content || null;
                for (const tc of msg.tool_calls)
                    if (tc.id)
                        knownToolCallIds.add(tc.id);
            }
            if (msg.role === 'tool') {
                if (!msg.tool_call_id || !knownToolCallIds.has(msg.tool_call_id))
                    continue;
                entry.tool_call_id = msg.tool_call_id;
                entry.content =
                    typeof msg.content === 'string'
                        ? msg.content
                        : JSON.stringify(msg.content ?? '');
            }
            // Final safety check: non-assistant roles MUST have string content
            if (entry.role !== 'assistant' && entry.content === null)
                entry.content = '';
            formatted.push(entry);
        }
        return formatted;
    }
}
//# sourceMappingURL=deepseek-provider.js.map