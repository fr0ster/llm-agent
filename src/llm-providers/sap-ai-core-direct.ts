/**
 * SAP AI Core Direct LLM Provider
 *
 * Bypasses OrchestrationClient and sends OpenAI-compatible HTTP requests
 * directly to SAP AI Core deployment endpoints.
 * Token counts are accurate (no orchestration overhead).
 */

import type { IModelInfo } from '../smart-agent/interfaces/model-provider.js';
import type { LLMProviderConfig, LLMResponse, Message } from '../types.js';
import { BaseLLMProvider } from './base.js';

export interface SapAiCoreDirectConfig extends LLMProviderConfig {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  resourceGroup?: string;
}

export class SapAiCoreDirectProvider extends BaseLLMProvider<SapAiCoreDirectConfig> {
  readonly model: string;
  private readonly resourceGroup: string;
  private deploymentUrl: string | null = null;
  private modelOverride?: string;

  setModelOverride(model?: string): void {
    this.modelOverride = model;
  }

  constructor(config: SapAiCoreDirectConfig) {
    super(config);
    this.model = config.model || 'gpt-4o';
    this.resourceGroup = config.resourceGroup || 'default';
  }

  private async resolveUrl(): Promise<string> {
    if (this.deploymentUrl) return this.deploymentUrl;

    const { resolveDeploymentUrl } = await import('@sap-ai-sdk/ai-api');
    const url = await resolveDeploymentUrl({
      scenarioId: 'foundation-models',
      model: { name: this.model },
      resourceGroup: this.resourceGroup,
    });
    if (!url) {
      throw new Error(
        `SAP AI Core: no deployment found for model "${this.model}" in resource group "${this.resourceGroup}"`,
      );
    }
    this.deploymentUrl = url;
    return url;
  }

  async chat(messages: Message[], tools?: unknown[]): Promise<LLMResponse> {
    try {
      const url = await this.resolveUrl();
      const model = this.modelOverride ?? this.model;

      const body: Record<string, unknown> = {
        model,
        messages: this.formatMessages(messages),
        temperature: this.config.temperature || 0.7,
        max_tokens: this.config.maxTokens || 16384,
      };
      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      const res = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as {
        choices: Array<{
          message: { role: string; content: string; tool_calls?: unknown[] };
          finish_reason: string;
        }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        };
      };

      const choice = data.choices[0];
      return {
        content: choice.message.content || '',
        finishReason: choice.finish_reason,
        raw: data,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`SAP AI Core Direct API error: ${msg}`);
    } finally {
      this.modelOverride = undefined;
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: unknown[],
  ): AsyncIterable<LLMResponse> {
    try {
      const url = await this.resolveUrl();
      const model = this.modelOverride ?? this.model;

      const body: Record<string, unknown> = {
        model,
        messages: this.formatMessages(messages),
        temperature: this.config.temperature || 0.7,
        max_tokens: this.config.maxTokens || 16384,
        stream: true,
      };
      if (tools && tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }

      const res = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }

      if (!res.body) throw new Error('No response body for streaming');

      const decoder = new TextDecoder();
      let buffer = '';

      for await (const rawChunk of res.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(rawChunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed?.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') return;

          try {
            const chunk = JSON.parse(payload) as {
              choices: Array<{
                delta: { content?: string; tool_calls?: unknown[] };
                finish_reason?: string;
              }>;
              usage?: {
                prompt_tokens: number;
                completion_tokens: number;
                total_tokens: number;
              };
            };

            const delta = chunk.choices[0]?.delta;
            const usage = chunk.usage;

            yield {
              content: delta?.content || '',
              finishReason: chunk.choices[0]?.finish_reason ?? undefined,
              raw: chunk,
              ...(usage
                ? {
                    usage: {
                      promptTokens: usage.prompt_tokens || 0,
                      completionTokens: usage.completion_tokens || 0,
                      totalTokens: usage.total_tokens || 0,
                    },
                  }
                : {}),
            };
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`SAP AI Core Direct streaming error: ${msg}`);
    } finally {
      this.modelOverride = undefined;
    }
  }

  async getModels(): Promise<IModelInfo[]> {
    return [{ id: this.model }];
  }

  private formatMessages(messages: Message[]): Array<Record<string, unknown>> {
    return messages.map((msg) => {
      if (
        msg.role === 'assistant' &&
        msg.tool_calls &&
        msg.tool_calls.length > 0
      ) {
        return {
          role: 'assistant',
          content: msg.content || undefined,
          tool_calls: msg.tool_calls,
        };
      }

      if (msg.role === 'tool' && msg.tool_call_id) {
        return {
          role: 'tool',
          content:
            typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content ?? ''),
          tool_call_id: msg.tool_call_id,
        };
      }

      return {
        role: msg.role,
        content: msg.content ?? '',
      };
    });
  }
}
