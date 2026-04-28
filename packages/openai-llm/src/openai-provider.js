/**
 * OpenAI LLM Provider
 */
import { BaseLLMProvider } from '@mcp-abap-adt/llm-agent';
import axios from 'axios';
export class OpenAIProvider extends BaseLLMProvider {
    client;
    model;
    providerName = 'OpenAI';
    constructor(config) {
        super(config);
        this.validateConfig();
        this.model = config.model || 'gpt-4o-mini';
        const headers = {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
        };
        // Add organization header if provided
        if (config.organization) {
            headers['OpenAI-Organization'] = config.organization;
        }
        // Add project header if provided
        if (config.project) {
            headers['OpenAI-Project'] = config.project;
        }
        this.client = axios.create({
            baseURL: config.baseURL || 'https://api.openai.com/v1',
            headers,
        });
    }
    async chat(messages, tools, options) {
        try {
            const model = options?.model ?? this.model;
            const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
            const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;
            const response = await this.client.post('/chat/completions', {
                model,
                messages: this.formatMessages(messages),
                tools: tools && tools.length > 0 ? tools : undefined,
                tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
                temperature,
                ...this.getTokenLimitParam(model, maxTokens),
                ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
                ...(options?.stop ? { stop: options.stop } : {}),
            });
            const choice = response.data.choices[0];
            const usage = response.data.usage
                ? {
                    prompt_tokens: response.data.usage.prompt_tokens,
                    completion_tokens: response.data.usage.completion_tokens,
                    total_tokens: response.data.usage.total_tokens,
                }
                : undefined;
            return {
                content: choice.message.content || '',
                finishReason: choice.finish_reason,
                raw: response.data,
                usage,
            };
        }
        catch (error) {
            const message = axios.isAxiosError(error)
                ? error.response?.data?.error
                    ?.message || error.message
                : error instanceof Error
                    ? error.message
                    : String(error);
            throw new Error(`${this.providerName} API error: ${message}`);
        }
    }
    async *streamChat(messages, tools, options) {
        try {
            const model = options?.model ?? this.model;
            const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
            const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;
            const response = await this.client.post('/chat/completions', {
                model,
                messages: this.formatMessages(messages),
                tools: tools && tools.length > 0 ? tools : undefined,
                tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
                temperature,
                ...this.getTokenLimitParam(model, maxTokens),
                ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
                ...(options?.stop ? { stop: options.stop } : {}),
                stream: true,
                stream_options: { include_usage: true },
            }, { responseType: 'stream' });
            const stream = response.data;
            let buffer = '';
            for await (const chunk of stream) {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed?.startsWith('data: '))
                        continue;
                    const data = trimmed.slice(6);
                    if (data === '[DONE]')
                        break;
                    try {
                        const parsed = JSON.parse(data);
                        const choice = parsed.choices?.[0];
                        if (choice?.delta) {
                            const deltaToolCalls = choice.delta.tool_calls;
                            const toolCalls = deltaToolCalls?.length
                                ? deltaToolCalls.map((tc) => ({
                                    index: tc.index,
                                    id: tc.id,
                                    name: tc.function?.name,
                                    arguments: tc.function?.arguments,
                                }))
                                : undefined;
                            yield {
                                content: choice.delta.content || '',
                                finishReason: choice.finish_reason,
                                raw: parsed,
                                ...(toolCalls ? { toolCalls } : {}),
                            };
                        }
                        // Usage-only chunk (stream_options: include_usage)
                        if (parsed.usage && !choice?.delta) {
                            yield {
                                content: '',
                                raw: parsed,
                                usage: {
                                    prompt_tokens: parsed.usage.prompt_tokens,
                                    completion_tokens: parsed.usage.completion_tokens,
                                    total_tokens: parsed.usage.total_tokens,
                                },
                            };
                        }
                    }
                    catch (_e) {
                        // Ignore parse errors for incomplete chunks
                    }
                }
            }
        }
        catch (error) {
            const message = axios.isAxiosError(error)
                ? error.response?.data?.error
                    ?.message || error.message
                : error instanceof Error
                    ? error.message
                    : String(error);
            throw new Error(`${this.providerName} Streaming error: ${message}`);
        }
    }
    async getModels() {
        const response = await this.client.get('/models');
        return response.data.data.map((m) => ({ id: m.id, owned_by: m.owned_by }));
    }
    async getEmbeddingModels() {
        const response = await this.client.get('/models');
        return response.data.data
            .filter((m) => /embed/i.test(m.id))
            .map((m) => ({ id: m.id, owned_by: m.owned_by }));
    }
    /**
     * Return the appropriate token limit parameter for the model.
     * Newer models (o1, o3, gpt-5+) require max_completion_tokens;
     * legacy models use max_tokens.
     */
    getTokenLimitParam(model, maxTokens) {
        const normalized = model.toLowerCase();
        const needsCompletionTokens = /^(o[13]|gpt-5)/.test(normalized);
        return needsCompletionTokens
            ? { max_completion_tokens: maxTokens }
            : { max_tokens: maxTokens };
    }
    /**
     * Format messages for OpenAI API with strict protocol enforcement.
     */
    formatMessages(messages) {
        const formatted = [];
        for (const msg of messages) {
            if (msg.role === 'tool' && !msg.tool_call_id) {
                continue;
            }
            const entry = {
                role: msg.role,
                content: msg.content ?? '',
            };
            if (msg.role === 'assistant' &&
                msg.tool_calls &&
                msg.tool_calls.length > 0) {
                entry.tool_calls = msg.tool_calls;
                entry.content = msg.content || null;
            }
            if (msg.role === 'tool') {
                entry.tool_call_id = msg.tool_call_id;
                entry.content =
                    typeof msg.content === 'string'
                        ? msg.content
                        : JSON.stringify(msg.content ?? '');
            }
            formatted.push(entry);
        }
        return formatted;
    }
}
//# sourceMappingURL=openai-provider.js.map