/**
 * Anthropic (Claude) LLM Provider
 */
import { BaseLLMProvider } from '@mcp-abap-adt/llm-agent';
import axios from 'axios';
export class AnthropicProvider extends BaseLLMProvider {
  client;
  model;
  constructor(config) {
    super(config);
    this.validateConfig();
    this.model = config.model || 'claude-3-5-sonnet-20241022';
    this.client = axios.create({
      baseURL: config.baseURL || 'https://api.anthropic.com/v1',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    });
  }
  async chat(messages, tools, options) {
    try {
      const systemMessage = messages.find((m) => m.role === 'system');
      const conversationMessages = messages.filter((m) => m.role !== 'system');
      const requestBody = {
        model: options?.model ?? this.model,
        messages: this.formatMessages(conversationMessages),
        max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 4096,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
        ...(options?.stop ? { stop_sequences: options.stop } : {}),
      };
      if (systemMessage) {
        requestBody.system = systemMessage.content;
      }
      if (tools && tools.length > 0) {
        requestBody.tools = tools;
      }
      const response = await this.client.post('/messages', requestBody);
      // Handle multi-block response (text + tool_use)
      const content = response.data.content;
      let textContent = '';
      for (const block of content) {
        if (block.type === 'text') textContent += block.text;
      }
      const rawUsage = response.data.usage;
      const usage = rawUsage
        ? {
            prompt_tokens: rawUsage.input_tokens ?? 0,
            completion_tokens: rawUsage.output_tokens ?? 0,
            total_tokens:
              (rawUsage.input_tokens ?? 0) + (rawUsage.output_tokens ?? 0),
          }
        : undefined;
      return {
        content: textContent,
        finishReason: response.data.stop_reason,
        raw: response.data,
        usage,
      };
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error?.message || error.message
        : error instanceof Error
          ? error.message
          : String(error);
      throw new Error(`Anthropic API error: ${message}`);
    }
  }
  async *streamChat(messages, tools, options) {
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');
    const requestBody = {
      model: options?.model ?? this.model,
      messages: this.formatMessages(conversationMessages),
      max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 4096,
      temperature: options?.temperature ?? this.config.temperature ?? 0.7,
      stream: true,
      ...(options?.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options?.stop ? { stop_sequences: options.stop } : {}),
    };
    if (systemMessage) {
      requestBody.system = systemMessage.content;
    }
    if (tools && tools.length > 0) {
      requestBody.tools = tools;
    }
    const baseURL = this.config.baseURL || 'https://api.anthropic.com/v1';
    const response = await fetch(`${baseURL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Anthropic streaming error: HTTP ${response.status} — ${text}`,
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Anthropic streams tool_use as discrete content blocks: a
    // `content_block_start` with type=tool_use carries id+name, then a series
    // of `content_block_delta` with type=input_json_delta carries the JSON
    // arguments in pieces. Map block index → tool-call index to produce
    // normalized LlmToolCallDelta chunks.
    const toolBlockIndices = new Map();
    let nextToolIndex = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        let eventType = '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            eventType = '';
            continue;
          }
          if (trimmed.startsWith('event: ')) {
            eventType = trimmed.slice(7);
            continue;
          }
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          try {
            const parsed = JSON.parse(data);
            if (
              eventType === 'content_block_delta' &&
              parsed.delta?.type === 'text_delta'
            ) {
              yield { content: parsed.delta.text || '', raw: parsed };
            } else if (
              eventType === 'content_block_start' &&
              parsed.content_block?.type === 'tool_use'
            ) {
              const blockIndex = parsed.index;
              const toolIndex = nextToolIndex++;
              toolBlockIndices.set(blockIndex, toolIndex);
              yield {
                content: '',
                raw: parsed,
                toolCalls: [
                  {
                    index: toolIndex,
                    id: parsed.content_block.id,
                    name: parsed.content_block.name,
                    arguments: '',
                  },
                ],
              };
            } else if (
              eventType === 'content_block_delta' &&
              parsed.delta?.type === 'input_json_delta'
            ) {
              const toolIndex = toolBlockIndices.get(parsed.index);
              if (toolIndex !== undefined) {
                yield {
                  content: '',
                  raw: parsed,
                  toolCalls: [
                    {
                      index: toolIndex,
                      arguments: parsed.delta.partial_json ?? '',
                    },
                  ],
                };
              }
            } else if (eventType === 'message_start' && parsed.message?.usage) {
              const u = parsed.message.usage;
              yield {
                content: '',
                raw: parsed,
                usage: {
                  prompt_tokens: u.input_tokens ?? 0,
                  completion_tokens: u.output_tokens ?? 0,
                  total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
                },
              };
            } else if (eventType === 'message_delta') {
              const u = parsed.usage;
              const stopReason = parsed.delta?.stop_reason;
              yield {
                content: '',
                // Normalize Anthropic's 'tool_use' to 'tool_calls' so the
                // downstream bridge / agent sees the canonical finish reason.
                finishReason:
                  stopReason === 'tool_use' ? 'tool_calls' : stopReason,
                raw: parsed,
                usage: u
                  ? {
                      prompt_tokens: 0,
                      completion_tokens: u.output_tokens ?? 0,
                      total_tokens: u.output_tokens ?? 0,
                    }
                  : undefined,
              };
            } else if (eventType === 'error') {
              const error = parsed.error;
              throw new Error(
                `Anthropic stream error: ${error?.message ?? 'unknown'}`,
              );
            } else {
              yield { content: '', raw: parsed };
            }
          } catch (e) {
            if (
              e instanceof Error &&
              e.message.startsWith('Anthropic stream error:')
            ) {
              throw e;
            }
            /* incomplete JSON — skip */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  async getModels() {
    const response = await this.client.get('/models');
    return response.data.data.map((m) => ({ id: m.id, owned_by: m.owned_by }));
  }
  async getEmbeddingModels() {
    return [];
  }
  /**
   * Format messages for Anthropic API
   */
  formatMessages(messages) {
    return messages.map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    }));
  }
}
//# sourceMappingURL=anthropic-provider.js.map
