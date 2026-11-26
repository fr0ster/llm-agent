import { addAbortListener } from 'node:events';
import { anthropicMessagesWire as anthropic } from '@mcp-abap-adt/anthropic-llm';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import {
  BaseLLMProvider,
  type IModelInfo,
  type LLMCallOptions,
  type LLMProvider,
  type LLMProviderConfig,
  type LLMResponse,
  LlmError,
  type LlmRequestFacts,
  type Message,
  MODEL_CONTEXT_EXCEEDED,
  parseRetryAfter,
  requestShape,
  startOperation,
} from '@mcp-abap-adt/llm-agent';
import { openAIChatWire as openai } from '@mcp-abap-adt/openai-llm';
import { AWS_EVENT_STREAM, readBedrockEvents } from './bedrock-event-stream.js';
import { readSse } from './server-sent-events.js';

export interface SapAiCoreFoundationConfig extends LLMProviderConfig {
  credential: IBearerCredential;
  apiBaseUrl: string;
  resourceGroup?: string;
}

type Tools = Parameters<LLMProvider['chat']>[1];
type RequestHeaders = Record<string, string>;

interface DeploymentResource {
  scenarioId?: string;
  deploymentUrl?: string;
  deployment_url?: string;
  details?: {
    resources?: {
      backendDetails?: { model?: { name?: string } };
      backend_details?: { model?: { name?: string } };
    };
  };
  model?: { name?: string };
}

interface DeploymentList {
  resources: DeploymentResource[];
  count?: number;
}

interface Deployment {
  model: string;
  url: string;
}

interface BedrockUsageEnvelope {
  'amazon-bedrock-invocationMetrics'?: {
    inputTokenCount?: number;
    outputTokenCount?: number;
  };
}

const OPENAI_PATH = '/chat/completions?api-version=2024-10-21';
const PROVIDER_ID = 'sap-aicore-foundation';
const SSE = 'text/event-stream';

class StaleDeploymentError extends LlmError {
  readonly status = 404;

  constructor() {
    super('SAP AI Core foundation request failed (HTTP 404)');
  }
}

function bedrockUsageFallback(wire: BedrockUsageEnvelope) {
  const metrics = wire['amazon-bedrock-invocationMetrics'];
  if (
    metrics?.inputTokenCount === undefined &&
    metrics?.outputTokenCount === undefined
  )
    return;
  // Bedrock reports uncached input separately from cache reads and writes.
  return {
    input_tokens: metrics.inputTokenCount,
    output_tokens: metrics.outputTokenCount,
  };
}

async function* readStream(
  response: Response,
  family: 'openai' | 'anthropic',
  signal?: AbortSignal,
) {
  const contentType = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  const bedrock = family === 'anthropic' && contentType === AWS_EVENT_STREAM;
  if (contentType !== SSE && !bedrock) {
    await response.body?.cancel().catch(() => {});
    throw new LlmError(
      'Unsupported SAP AI Core foundation stream content type',
    );
  }
  if (!response.body)
    throw new LlmError('SAP AI Core foundation stream has no body');
  yield* bedrock
    ? readBedrockEvents(response.body, signal)
    : readSse(response.body, signal);
}

function httpError(status: number, headers: Headers) {
  const message = `SAP AI Core foundation request failed (HTTP ${status})`;
  if (status === 429) {
    return Object.assign(new LlmError(message), {
      status,
      throttled: true,
      retryAfterSeconds: parseRetryAfter(headers.get('retry-after')),
    });
  }
  return Object.assign(new LlmError(message), { status });
}

const contextOverflowPatterns = [
  /\b(?:prompt|input) is too long\b/i,
  /\btoo many (?:input tokens|tokens in the prompt)\b/i,
  /\bmaximum context length\b/i,
  /\bcontext[ _-](?:window|length)[ _-]exceeded\b/i,
  /\b(?:input|prompt) (?:length|tokens?|length and .*?) exceeds?\b/i,
  /\b(?:input|prompt) .*?exceeds? (?:the )?(?:maximum )?(?:model(?:'s)? )?(?:context|token limit)\b/i,
];

function isContextOverflow(message?: string): boolean {
  return (
    typeof message === 'string' &&
    contextOverflowPatterns.some((pattern) => pattern.test(message))
  );
}

async function inferenceError(response: Response): Promise<LlmError> {
  if ([400, 413, 422].includes(response.status)) {
    const body = await response.text().catch(() => '');
    if (isContextOverflow(body)) {
      return Object.assign(modelError(body, true), { status: response.status });
    }
  } else {
    await response.body?.cancel().catch(() => {});
  }
  return httpError(response.status, response.headers);
}

function deploymentOf(resource: DeploymentResource): Deployment | undefined {
  if (resource.scenarioId && resource.scenarioId !== 'foundation-models')
    return;
  const details = resource.details?.resources;
  const model =
    details?.backendDetails?.model?.name ??
    details?.backend_details?.model?.name ??
    resource.model?.name;
  const url = resource.deploymentUrl ?? resource.deployment_url;
  if (model && url) return { model, url: url.replace(/\/+$/, '') };
}

/** Direct chat against running SAP AI Core foundation-model deployments. */
export class SapAiCoreFoundationProvider extends BaseLLMProvider<SapAiCoreFoundationConfig> {
  readonly model: string;
  readonly resourceGroup: string;
  private readonly deployments = new Map<string, Deployment>();

  constructor(config: SapAiCoreFoundationConfig) {
    super(config);
    if (!config.model)
      throw new Error("SAP AI Core foundation provider requires a 'model'");
    this.model = config.model;
    this.resourceGroup = config.resourceGroup ?? 'default';
  }

  protected override quotaCredential(): object {
    return this.config.credential;
  }

  protected override quotaEndpoint(): string {
    return this.config.apiBaseUrl;
  }

  protected override quotaScope(): string {
    return [super.quotaScope(), this.resourceGroup].join('|');
  }

  private async headers(signal?: AbortSignal): Promise<RequestHeaders> {
    signal?.throwIfAborted();
    const pending = this.config.credential.token();
    let listener: ReturnType<typeof addAbortListener> | undefined;
    try {
      const token = signal
        ? await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              listener = addAbortListener(signal, () => reject(signal.reason));
            }),
          ])
        : await pending;
      signal?.throwIfAborted();
      return {
        Authorization: `Bearer ${token}`,
        'AI-Resource-Group': this.resourceGroup,
      };
    } finally {
      listener?.[Symbol.dispose]();
    }
  }

  private async *listDeployments(
    headers: RequestHeaders,
    signal?: AbortSignal,
  ) {
    const url = new URL(
      `${this.config.apiBaseUrl.replace(/\/+$/, '')}/v2/lm/deployments`,
    );
    url.searchParams.set('status', 'RUNNING');
    let offset = 0;
    while (true) {
      const response = await fetch(url.toString(), {
        headers,
        signal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw httpError(response.status, response.headers);
      }
      const page = (await response.json()) as DeploymentList;
      for (const resource of page.resources) {
        const deployment = deploymentOf(resource);
        if (deployment) yield deployment;
      }
      offset += page.resources.length;
      if (
        !page.resources.length ||
        page.count === undefined ||
        offset >= page.count
      )
        return;
      url.searchParams.set('$skip', String(offset));
    }
  }

  private async resolveDeployment(
    model: string,
    headers: RequestHeaders,
    signal?: AbortSignal,
  ) {
    const cached = this.deployments.get(model);
    if (cached) return cached;

    for await (const deployment of this.listDeployments(headers, signal)) {
      if (deployment.model !== model) continue;
      const resolved = this.deployments.get(model) ?? deployment;
      this.deployments.set(model, resolved);
      return resolved;
    }
    throw new LlmError(
      'No RUNNING SAP AI Core foundation deployment found for model "' +
        model +
        '"',
    );
  }

  async getModels(options?: LLMCallOptions): Promise<IModelInfo[]> {
    try {
      const headers = await this.headers(options?.signal);
      const models = new Map<string, IModelInfo>();
      for await (const { model } of this.listDeployments(
        headers,
        options?.signal,
      )) {
        models.set(model, { id: model, scenarios: ['foundation-models'] });
      }
      return [...models.values()];
    } catch (error) {
      throw this.safeError(error, options?.signal);
    }
  }

  private prepare(
    messages: Message[],
    tools: Tools,
    stream: boolean,
    options?: LLMCallOptions,
  ) {
    const model = options?.model ?? this.model;
    const knobs = {
      temperature: options?.temperature ?? this.config.temperature,
      maxTokens: options?.maxTokens ?? this.config.maxTokens,
      promptCaching: options?.promptCaching ?? this.config.promptCaching,
      topP: options?.topP,
      stop: options?.stop,
    };
    if (!model.startsWith('anthropic--')) {
      const sent = openai.formatMessages(messages);
      const body = {
        ...openai.requestBody(model, sent, tools, knobs, (id, maxTokens) =>
          openai.tokenLimitParam(id, maxTokens, { extendedModels: true }),
        ),
        ...(stream ? openai.streamParams() : {}),
      };
      return {
        family: 'openai' as const,
        path: OPENAI_PATH,
        model,
        body,
        shape: () => requestShape(sent, tools),
      };
    }

    // Bedrock requires max_tokens. Its value belongs to the caller or model configuration.
    if (knobs.maxTokens === undefined) {
      throw new LlmError('SAP AI Core Anthropic requests require maxTokens');
    }
    const system = messages.filter((message) => message.role === 'system');
    const sent = anthropic.formatMessages(
      messages.filter((message) => message.role !== 'system'),
      this.toolCallIdMapper.bind(this),
    );
    const body = {
      anthropic_version: 'bedrock-2023-05-31',
      ...anthropic.requestBody(
        sent,
        system.length
          ? system.map((message) => message.content).join('\n\n')
          : undefined,
        tools,
        { ...knobs, maxTokens: knobs.maxTokens },
        'bedrock',
      ),
    };
    return {
      family: 'anthropic' as const,
      path: stream ? '/invoke-with-response-stream' : '/invoke',
      model,
      body,
      shape: () =>
        requestShape(
          anthropic.shapeMessages(body.messages, body.system),
          body.tools,
        ),
    };
  }

  private preparePost<Stream extends boolean>(
    request: ReturnType<SapAiCoreFoundationProvider['prepare']>,
    stream: Stream,
    options?: LLMCallOptions,
  ) {
    const signal = options?.signal;
    const accept = stream
      ? request.family === 'anthropic'
        ? `${AWS_EVENT_STREAM}, ${SSE}`
        : SSE
      : 'application/json';
    const body = JSON.stringify(request.body);
    let headers: RequestHeaders;
    let deployment: Deployment;
    let refreshing = false;

    return {
      post: async () => {
        const response = await fetch(deployment.url + request.path, {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            Accept: accept,
          },
          body,
          signal,
          redirect: 'error',
        });
        if (response.status === 404) {
          if (this.deployments.get(request.model) === deployment)
            this.deployments.delete(request.model);
          await response.body?.cancel().catch(() => {});
          throw new StaleDeploymentError();
        }
        if (!response.ok) throw await inferenceError(response);
        return response;
      },
      throttle: {
        model: request.model,
        signal,
        retryImmediately: (error: object | undefined) => {
          refreshing = error instanceof StaleDeploymentError && !refreshing;
          return refreshing;
        },
      },
      usage: {
        prepare: async () => {
          headers = await this.headers(signal);
          deployment = await this.resolveDeployment(
            request.model,
            headers,
            signal,
          );
          signal?.throwIfAborted();
        },
        opts: options,
        op: startOperation(options),
        get base() {
          return {
            provider: PROVIDER_ID,
            model: request.model,
            stream,
            granularity: 'request' as const,
            retriesVisible: true,
            ...request.shape(),
          };
        },
      },
    };
  }

  private safeError<T>(error: T, signal?: AbortSignal): LlmError {
    if (error instanceof LlmError && error.code === MODEL_CONTEXT_EXCEEDED)
      return error;
    signal?.throwIfAborted();
    if (error instanceof LlmError) return error;
    return this.preserveThrottled(
      error,
      new LlmError('SAP AI Core foundation request failed'),
    );
  }

  async chat(
    messages: Message[],
    tools?: Tools,
    options?: LLMCallOptions,
  ): Promise<LLMResponse> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    const request = this.prepare(messages, tools, false, options);
    try {
      const { post, throttle, usage } = this.preparePost(
        request,
        false,
        options,
      );
      return await this.withThrottleRetry(
        async (handle) => {
          const response = await post();
          let mapped: LLMResponse;
          let facts: Partial<LlmRequestFacts>;
          if (request.family === 'anthropic') {
            const wire =
              (await response.json()) as anthropic.AnthropicChatResponse &
                BedrockUsageEnvelope;
            if (wire.error) throw modelError(wire.error.message);
            const fallback = bedrockUsageFallback(wire);
            const tokenUsage = fallback
              ? anthropic.withUsageFallback(wire.usage, fallback)
              : wire.usage;
            mapped = {
              ...anthropic.chatResponse(
                { ...wire, usage: tokenUsage },
                { defaultToolInput: true },
              ),
              raw: wire,
            };
            facts = anthropic.tokenFacts(tokenUsage);
          } else {
            const wire = (await response.json()) as openai.OpenAIChatResponse;
            if (wire.error)
              throw modelError(
                wire.error.message,
                openai.isContextOverflow(wire.error),
              );
            mapped = openai.chatResponse(wire, { normalizeToolCalls: true });
            facts = openai.tokenFacts(wire.usage);
          }
          handle.end({ outcome: 'ok', ...facts });
          return mapped;
        },
        throttle,
        usage,
      );
    } catch (error) {
      throw this.safeError(error, signal);
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: Tools,
    options?: LLMCallOptions,
  ): AsyncIterable<LLMResponse> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    const request = this.prepare(messages, tools, true, options);
    try {
      const { post, throttle, usage } = this.preparePost(
        request,
        true,
        options,
      );
      const { response, handle } = await this.withThrottleRetry(
        post,
        throttle,
        usage,
      );
      let completed = false;
      let failure: Error | undefined;
      let facts: Partial<LlmRequestFacts> = {};

      try {
        const openAIMapper = new openai.OpenAIStreamMapper({
          includeFinishOnlyChunks: true,
        });
        const anthropicMapper = new anthropic.AnthropicStreamMapper({
          deltaUsage: true,
        });
        for await (const event of readStream(
          response,
          request.family,
          signal,
        )) {
          if (event.data === '[DONE]') break;
          if (request.family === 'anthropic') {
            const wire: anthropic.AnthropicStreamEvent & BedrockUsageEnvelope =
              JSON.parse(event.data);
            const kind = wire.type ?? event.type;
            if (wire.error || kind === 'error') {
              throw modelError(wire.error?.message);
            }
            const mapped = anthropicMapper.map(
              wire,
              kind,
              bedrockUsageFallback(wire),
            );
            facts = anthropicMapper.tokenFacts();
            if (mapped) {
              if (mapped.content || mapped.toolCalls?.length)
                handle.firstToken();
              yield mapped;
            }
            if (kind === 'message_stop') break;
          } else {
            const wire: openai.OpenAIChatEvent = JSON.parse(event.data);
            if (wire.error)
              throw modelError(
                wire.error.message,
                openai.isContextOverflow(wire.error),
              );
            if (wire.usage)
              facts = { ...facts, ...openai.tokenFacts(wire.usage) };
            for (const mapped of openAIMapper.map(wire)) {
              if (mapped.content || mapped.toolCalls?.length)
                handle.firstToken();
              yield mapped;
            }
          }
        }
        completed = true;
      } catch (error) {
        failure =
          error instanceof Error
            ? error
            : new LlmError('SAP AI Core foundation stream failed');
        throw error;
      } finally {
        handle.end({
          ...facts,
          outcome: failure
            ? signal?.aborted
              ? 'aborted'
              : 'error'
            : completed
              ? 'ok'
              : 'aborted',
          error: failure,
          closedEarly: !completed && !failure,
        });
      }
    } catch (error) {
      throw this.safeError(error, signal);
    }
  }
}

function modelError(message?: string, contextOverflow = false): LlmError {
  if (contextOverflow || isContextOverflow(message))
    return new LlmError(
      'SAP AI Core model context exceeded',
      MODEL_CONTEXT_EXCEEDED,
    );
  return new LlmError('SAP AI Core foundation inference failed');
}
