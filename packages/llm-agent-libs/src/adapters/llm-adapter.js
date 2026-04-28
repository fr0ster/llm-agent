/**
 * LlmAdapter — wraps a bridge object implementing callWithTools/streamWithTools as ILlm.
 */
import { LlmError } from '@mcp-abap-adt/llm-agent';

// ---------------------------------------------------------------------------
// Module-private helper
// ---------------------------------------------------------------------------
function withAbort(promise, signal, makeError) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(makeError());
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(makeError()), {
        once: true,
      });
    }),
  ]);
}
// ---------------------------------------------------------------------------
// parseProviderResponse
// ---------------------------------------------------------------------------
/**
 * Extracts tool calls and usage from the raw provider response.
 *
 * OpenAI / DeepSeek: raw.choices[0].message.tool_calls, raw.usage
 * Anthropic:         raw.content[].type === 'tool_use', raw.usage
 */
function parseProviderResponse(raw, onDiagnostic) {
  // biome-ignore lint/suspicious/noExplicitAny: raw provider payload has no stable type
  const providerRaw = raw.raw;
  if (!providerRaw) {
    return { content: raw.content, finishReason: 'stop' };
  }
  const toolCalls = [];
  let usage;
  // Extract usage
  if (providerRaw.usage) {
    usage = {
      promptTokens:
        providerRaw.usage.prompt_tokens ?? providerRaw.usage.input_tokens ?? 0,
      completionTokens:
        providerRaw.usage.completion_tokens ??
        providerRaw.usage.output_tokens ??
        0,
      totalTokens: providerRaw.usage.total_tokens ?? 0,
    };
    if (usage.totalTokens === 0) {
      usage.totalTokens = usage.promptTokens + usage.completionTokens;
    }
  }
  // OpenAI / DeepSeek format
  if (providerRaw.choices?.[0]?.message?.tool_calls) {
    for (const tc of providerRaw.choices[0].message.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        onDiagnostic?.({
          stage: 'response',
          code: 'TOOL_ARGUMENTS_JSON_PARSE_FAILED',
          message: 'Failed to parse tool call arguments JSON',
          details: {
            toolId: tc.id,
            toolName: tc.function?.name,
          },
        });
        args = {};
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
    }
    return {
      content: raw.content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage,
      raw: providerRaw,
    };
  }
  // Anthropic format
  if (Array.isArray(providerRaw.content)) {
    for (const block of providerRaw.content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input ?? {},
        });
      }
    }
    return {
      content: raw.content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason:
        providerRaw.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
      usage,
      raw: providerRaw,
    };
  }
  return {
    content: raw.content,
    finishReason: 'stop',
    usage,
    raw: providerRaw,
  };
}
/**
 * parseStreamChunk
 *
 * Extracts content delta and other info from a stream chunk.
 */
function parseStreamChunk(raw, onDiagnostic) {
  if ('type' in raw) {
    if (raw.type === 'text') {
      return { content: raw.delta };
    }
    if (raw.type === 'tool_calls') {
      return {
        content: '',
        toolCalls: raw.toolCalls,
      };
    }
    if (raw.type === 'usage') {
      return {
        content: '',
        usage: {
          promptTokens: raw.promptTokens,
          completionTokens: raw.completionTokens,
          totalTokens: raw.promptTokens + raw.completionTokens,
        },
      };
    }
    return {
      content: '',
      finishReason: raw.finishReason,
    };
  }
  // biome-ignore lint/suspicious/noExplicitAny: raw provider payload has no stable type
  const providerRaw = raw.raw;
  if (!providerRaw) {
    return { content: raw.content };
  }
  // OpenAI / DeepSeek usage-only chunk (stream_options: include_usage)
  if (providerRaw.usage && !providerRaw.choices?.[0]?.delta) {
    return {
      content: '',
      usage: {
        promptTokens: providerRaw.usage.prompt_tokens ?? 0,
        completionTokens: providerRaw.usage.completion_tokens ?? 0,
        totalTokens:
          providerRaw.usage.total_tokens ??
          (providerRaw.usage.prompt_tokens ?? 0) +
            (providerRaw.usage.completion_tokens ?? 0),
      },
    };
  }
  // OpenAI / DeepSeek format for chunks
  if (providerRaw.choices?.[0]?.delta) {
    const delta = providerRaw.choices[0].delta;
    const toolCalls = [];
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (typeof tc.index !== 'number') {
          onDiagnostic?.({
            stage: 'stream',
            code: 'STREAM_TOOL_DELTA_MISSING_INDEX',
            message: 'Tool-call delta is missing numeric index',
          });
          continue;
        }
        toolCalls.push({
          index: tc.index,
          id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments,
        });
      }
    }
    return {
      content: delta.content || '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: providerRaw.choices[0].finish_reason || undefined,
    };
  }
  return { content: raw.content };
}
function normalizeModelEntry(entry) {
  return typeof entry === 'string' ? { id: entry } : entry;
}
export class LlmAdapter {
  agent;
  provider;
  constructor(agent, provider) {
    this.agent = agent;
    this.provider = provider;
  }
  getModel() {
    return this.provider?.model ?? 'unknown';
  }
  get model() {
    return this.getModel();
  }
  async getModels(options) {
    if (!this.provider?.getModels) {
      return {
        ok: true,
        value: [{ id: this.provider?.model ?? 'unknown' }],
      };
    }
    try {
      const modelsPromise = this.provider.getModels();
      const raw = options?.signal
        ? await withAbort(
            modelsPromise,
            options.signal,
            () => new LlmError('Aborted', 'ABORTED'),
          )
        : await modelsPromise;
      let models = raw.map(normalizeModelEntry);
      if (options?.excludeEmbedding && this.provider.getEmbeddingModels) {
        const embeddingModels = await this.provider.getEmbeddingModels();
        const embeddingIds = new Set(
          embeddingModels.map((m) => (typeof m === 'string' ? m : m.id)),
        );
        models = models.filter((m) => !embeddingIds.has(m.id));
      }
      return { ok: true, value: models };
    } catch (err) {
      if (err instanceof LlmError) return { ok: false, error: err };
      return {
        ok: false,
        error: new LlmError(String(err), 'MODEL_LIST_FAILED'),
      };
    }
  }
  async getEmbeddingModels(options) {
    if (!this.provider?.getEmbeddingModels) {
      return { ok: true, value: [] };
    }
    try {
      const modelsPromise = this.provider.getEmbeddingModels();
      const raw = options?.signal
        ? await withAbort(
            modelsPromise,
            options.signal,
            () => new LlmError('Aborted', 'ABORTED'),
          )
        : await modelsPromise;
      return { ok: true, value: raw.map(normalizeModelEntry) };
    } catch (err) {
      if (err instanceof LlmError) return { ok: false, error: err };
      return {
        ok: false,
        error: new LlmError(String(err), 'MODEL_LIST_FAILED'),
      };
    }
  }
  async chat(messages, tools, options) {
    try {
      const onDiagnostic = options?.sessionLogger
        ? (event) =>
            options.sessionLogger?.logStep('llm_parse_diagnostic', event)
        : undefined;
      const mcpTools =
        tools?.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })) ?? [];
      const agentOptions = options
        ? {
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            topP: options.topP,
            stop: options.stop,
            // model intentionally NOT forwarded — the adapter's configured model
            // takes precedence. Client-facing model names (e.g. "smart-agent")
            // must not override the actual LLM provider model.
          }
        : undefined;
      const raw = await withAbort(
        this.agent.callWithTools(messages, mcpTools, agentOptions),
        options?.signal,
        () => new LlmError('Aborted', 'ABORTED'),
      );
      return { ok: true, value: parseProviderResponse(raw, onDiagnostic) };
    } catch (err) {
      if (err instanceof LlmError) return { ok: false, error: err };
      return { ok: false, error: new LlmError(String(err)) };
    }
  }
  async *streamChat(messages, tools, options) {
    try {
      const onDiagnostic = options?.sessionLogger
        ? (event) =>
            options.sessionLogger?.logStep('llm_parse_diagnostic', event)
        : undefined;
      const mcpTools =
        tools?.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })) ?? [];
      const agentOptions = options
        ? {
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            topP: options.topP,
            stop: options.stop,
            // model intentionally NOT forwarded — the adapter's configured model
            // takes precedence. Client-facing model names (e.g. "smart-agent")
            // must not override the actual LLM provider model.
          }
        : undefined;
      const stream = this.agent.streamWithTools(
        messages,
        mcpTools,
        agentOptions,
      );
      for await (const chunk of stream) {
        if (options?.signal?.aborted) {
          throw new LlmError('Aborted', 'ABORTED');
        }
        yield { ok: true, value: parseStreamChunk(chunk, onDiagnostic) };
      }
    } catch (err) {
      if (err instanceof LlmError) yield { ok: false, error: err };
      else yield { ok: false, error: new LlmError(String(err)) };
    }
  }
  async healthCheck(options) {
    if (!this.provider?.getModels) {
      return { ok: true, value: true };
    }
    try {
      const modelsPromise = this.provider.getModels();
      const models = options?.signal
        ? await withAbort(
            modelsPromise,
            options.signal,
            () => new LlmError('Aborted', 'ABORTED'),
          )
        : await modelsPromise;
      const model = this.provider.model;
      const found = models.some((m) => {
        if (typeof m === 'string') {
          return m === model || m.includes(model);
        }
        return m.id === model || m.id.includes(model);
      });
      return { ok: true, value: found };
    } catch (err) {
      if (err instanceof LlmError) return { ok: false, error: err };
      return {
        ok: false,
        error: new LlmError(String(err), 'HEALTH_CHECK_FAILED'),
      };
    }
  }
}
//# sourceMappingURL=llm-adapter.js.map
