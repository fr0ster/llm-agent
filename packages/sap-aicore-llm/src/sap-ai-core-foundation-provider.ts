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
import {
  openAIChatWire as openai,
  openAIResponsesWire as responses,
} from '@mcp-abap-adt/openai-llm';
import { AWS_EVENT_STREAM, readBedrockEvents } from './bedrock-event-stream.js';
import { readSse } from './server-sent-events.js';

export interface SapAiCoreFoundationConfig extends LLMProviderConfig {
  credential: IBearerCredential;
  apiBaseUrl: string;
  resourceGroup?: string;
}

type Tools = Parameters<LLMProvider['chat']>[1];
type RequestHeaders = Record<string, string>;
type InferenceErrorWire = openai.OpenAIErrorResponse & { message?: string };

interface DeploymentResource {
  scenarioId?: string;
  configurationId?: string;
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

interface ListedDeployment {
  model: string;
  url: string;
  configurationId?: string;
}

interface Deployment extends ListedDeployment {
  configuration?: ConfigurationResource;
  configurationLookup?: Lookup<ConfigurationResource>;
}

interface ConfigurationResource {
  executableId?: string;
}

interface Lookup<T> {
  pending: Promise<T>;
  signal?: AbortSignal;
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
const CONTEXT_OVERFLOW_MESSAGE = 'SAP AI Core model context exceeded';

class StaleDeploymentError extends LlmError {
  readonly status = 404;

  constructor() {
    super('SAP AI Core foundation request failed (HTTP 404)');
  }
}

async function awaitWithSignal<T>(pending: Promise<T>, signal?: AbortSignal) {
  if (!signal) return pending;
  let listener: ReturnType<typeof addAbortListener> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        listener = addAbortListener(signal, () => reject(signal.reason));
      }),
    ]);
  } finally {
    listener?.[Symbol.dispose]();
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
  family: 'openai' | 'responses' | 'anthropic',
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

function httpError(status: number, headers: Headers, detail?: string) {
  const message = `SAP AI Core foundation request failed (HTTP ${status})${detail ? `: ${detail}` : ''}`;
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
    const wire = parseInferenceError(body);
    const detail = errorDetail(wire);
    if (
      openai.isContextOverflow(wire?.error) ||
      isContextOverflow(body) ||
      isContextOverflow(detail)
    ) {
      return Object.assign(
        new LlmError(
          detail || CONTEXT_OVERFLOW_MESSAGE,
          MODEL_CONTEXT_EXCEEDED,
        ),
        { status: response.status },
      );
    }
    if (response.status !== 413)
      return httpError(response.status, response.headers, detail);
  } else {
    await response.body?.cancel().catch(() => {});
  }
  return httpError(response.status, response.headers);
}

function parseInferenceError(body: string): InferenceErrorWire | null {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function errorDetail(wire: InferenceErrorWire | null): string | undefined {
  if (typeof wire?.error?.message === 'string' && wire.error.message)
    return wire.error.message;
  if (typeof wire?.message === 'string') return wire.message;
}

function deploymentOf(
  resource: DeploymentResource,
): ListedDeployment | undefined {
  if (resource.scenarioId && resource.scenarioId !== 'foundation-models')
    return;
  const details = resource.details?.resources;
  const model =
    details?.backendDetails?.model?.name ??
    details?.backend_details?.model?.name ??
    resource.model?.name;
  const url = resource.deploymentUrl ?? resource.deployment_url;
  if (model && url)
    return {
      model,
      url: url.replace(/\/+$/, ''),
      configurationId: resource.configurationId,
    };
}

/** Direct chat against running SAP AI Core foundation-model deployments. */
export class SapAiCoreFoundationProvider extends BaseLLMProvider<SapAiCoreFoundationConfig> {
  readonly model: string;
  readonly resourceGroup: string;
  private readonly deployments = new Map<string, Deployment>();
  private readonly deploymentLookups = new Map<string, Lookup<Deployment>>();

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
    const token = await awaitWithSignal(this.config.credential.token(), signal);
    signal?.throwIfAborted();
    return {
      Authorization: `Bearer ${token}`,
      'AI-Resource-Group': this.resourceGroup,
    };
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
  ): Promise<Deployment> {
    signal?.throwIfAborted();
    const cached = this.deployments.get(model);
    if (cached) return cached;

    const existing = this.deploymentLookups.get(model);
    if (existing && !existing.signal?.aborted) {
      try {
        return await awaitWithSignal(existing.pending, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (!existing.signal?.aborted) throw error;
        // A caller with an active signal can take over an abandoned lookup.
        return this.resolveDeployment(model, headers, signal);
      }
    }

    const pending = this.discoverDeployment(model, headers, signal).then(
      (deployment) => {
        signal?.throwIfAborted();
        this.deployments.set(model, deployment);
        return deployment;
      },
    );
    const lookup = { pending, signal };
    this.deploymentLookups.set(model, lookup);
    try {
      return await pending;
    } finally {
      if (this.deploymentLookups.get(model) === lookup)
        this.deploymentLookups.delete(model);
    }
  }

  private async discoverDeployment(
    model: string,
    headers: RequestHeaders,
    signal?: AbortSignal,
  ): Promise<Deployment> {
    for await (const deployment of this.listDeployments(headers, signal)) {
      if (deployment.model === model) return deployment;
    }
    throw new LlmError(
      'No RUNNING SAP AI Core foundation deployment found for model "' +
        model +
        '"',
    );
  }

  private async resolveConfiguration(
    deployment: Deployment,
    headers: RequestHeaders,
    signal?: AbortSignal,
  ): Promise<ConfigurationResource | undefined> {
    signal?.throwIfAborted();
    const { configurationId, configuration, configurationLookup } = deployment;
    if (!configurationId) return;
    if (configuration) return configuration;

    if (configurationLookup && !configurationLookup.signal?.aborted) {
      try {
        return await awaitWithSignal(configurationLookup.pending, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (!configurationLookup.signal?.aborted) throw error;
        return this.resolveConfiguration(deployment, headers, signal);
      }
    }

    const pending = this.fetchConfiguration(
      configurationId,
      headers,
      signal,
    ).then((configuration) => {
      signal?.throwIfAborted();
      deployment.configuration = configuration;
      return configuration;
    });
    const lookup = { pending, signal };
    deployment.configurationLookup = lookup;
    try {
      return await pending;
    } finally {
      if (deployment.configurationLookup === lookup)
        delete deployment.configurationLookup;
    }
  }

  private async fetchConfiguration(
    configurationId: string,
    headers: RequestHeaders,
    signal?: AbortSignal,
  ): Promise<ConfigurationResource> {
    const baseUrl = this.config.apiBaseUrl.replace(/\/+$/, '');
    const response = await fetch(
      `${baseUrl}/v2/lm/configurations/${encodeURIComponent(configurationId)}`,
      { headers, signal, redirect: 'error' },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw httpError(response.status, response.headers);
    }
    const { executableId } = (await response.json()) as ConfigurationResource;
    return { executableId };
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
    model: string,
    messages: Message[],
    tools: Tools,
    stream: boolean,
    options?: LLMCallOptions,
    executableId?: string,
  ) {
    const azureOpenAI = executableId === 'azure-openai';
    const knobs = {
      temperature: options?.temperature ?? this.config.temperature,
      maxTokens: options?.maxTokens ?? this.config.maxTokens,
      reasoningEffort: azureOpenAI
        ? (options?.reasoningEffort ?? this.config.reasoningEffort)
        : undefined,
      promptCaching: options?.promptCaching ?? this.config.promptCaching,
      topP: options?.topP,
      stop: options?.stop,
    };
    if (!model.startsWith('anthropic--')) {
      if (azureOpenAI && tools?.length) {
        const body = responses.requestBody(
          model,
          messages,
          tools,
          knobs,
          stream,
        );
        return {
          family: 'responses' as const,
          path: '/responses',
          body,
          shape: () => requestShape(messages, body.tools),
        };
      }
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
        body,
        shape: () => requestShape(sent, tools),
      };
    }

    // Bedrock requires max_tokens. The Anthropic wire has no reasoningEffort-to-thinking mapping.
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
      body,
      shape: () =>
        requestShape(
          anthropic.shapeMessages(body.messages, body.system),
          body.tools,
        ),
    };
  }

  private preparePost<Stream extends boolean>(
    messages: Message[],
    tools: Tools,
    stream: Stream,
    options?: LLMCallOptions,
  ) {
    const signal = options?.signal;
    const model = options?.model ?? this.model;
    const anthropicRequest = model.startsWith('anthropic--')
      ? this.prepare(model, messages, tools, stream, options)
      : undefined;
    const needsConfiguration =
      !anthropicRequest &&
      (Boolean(tools?.length) ||
        (options?.reasoningEffort ?? this.config.reasoningEffort) !==
          undefined);
    let request: ReturnType<SapAiCoreFoundationProvider['prepare']>;
    let body: string;
    let headers: RequestHeaders;
    let deployment: Deployment;
    let refreshing = false;

    return {
      post: async () => {
        const accept = stream
          ? request.family === 'anthropic'
            ? `${AWS_EVENT_STREAM}, ${SSE}`
            : SSE
          : 'application/json';
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
          if (this.deployments.get(model) === deployment)
            this.deployments.delete(model);
          await response.body?.cancel().catch(() => {});
          throw new StaleDeploymentError();
        }
        if (!response.ok) throw await inferenceError(response);
        return { response, family: request.family };
      },
      throttle: {
        model,
        signal,
        retryImmediately: (error: object | undefined) => {
          refreshing = error instanceof StaleDeploymentError && !refreshing;
          return refreshing;
        },
      },
      usage: {
        prepare: async () => {
          headers = await this.headers(signal);
          deployment = await this.resolveDeployment(model, headers, signal);
          const configuration = needsConfiguration
            ? await this.resolveConfiguration(deployment, headers, signal)
            : undefined;
          signal?.throwIfAborted();
          request =
            anthropicRequest ??
            this.prepare(
              model,
              messages,
              tools,
              stream,
              options,
              configuration?.executableId,
            );
          body = JSON.stringify(request.body);
        },
        opts: options,
        op: startOperation(options),
        get base() {
          return {
            provider: PROVIDER_ID,
            model,
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
    try {
      const { post, throttle, usage } = this.preparePost(
        messages,
        tools,
        false,
        options,
      );
      return await this.withThrottleRetry(
        async (handle) => {
          const { response, family } = await post();
          let mapped: LLMResponse;
          let facts: Partial<LlmRequestFacts>;
          if (family === 'anthropic') {
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
          } else if (family === 'responses') {
            const wire = (await response.json()) as responses.OpenAIResponse;
            if (wire.error || wire.status === 'failed')
              throw modelError(
                wire.error?.message,
                openai.isContextOverflow(wire.error),
              );
            mapped = responses.chatResponse(wire);
            facts = responses.tokenFacts(wire.usage);
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
    try {
      const { post, throttle, usage } = this.preparePost(
        messages,
        tools,
        true,
        options,
      );
      const {
        response: { response, family },
        handle,
      } = await this.withThrottleRetry(post, throttle, usage);
      let completed = false;
      let failure: Error | undefined;
      let facts: Partial<LlmRequestFacts> = {};

      try {
        const openAIMapper = new openai.OpenAIStreamMapper({
          includeFinishOnlyChunks: true,
        });
        const responsesMapper = new responses.OpenAIResponsesStreamMapper();
        let responsesFinished = false;
        const anthropicMapper = new anthropic.AnthropicStreamMapper({
          deltaUsage: true,
        });
        for await (const event of readStream(response, family, signal)) {
          if (event.data === '[DONE]') break;
          if (family === 'anthropic') {
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
          } else if (family === 'responses') {
            const wire: responses.OpenAIResponseEvent = JSON.parse(event.data);
            if (wire.type === 'error' || wire.type === 'response.failed') {
              const error = wire.type === 'error' ? wire : wire.response.error;
              throw modelError(error?.message, openai.isContextOverflow(error));
            }
            if (
              wire.type === 'response.completed' ||
              wire.type === 'response.incomplete'
            ) {
              responsesFinished = true;
              facts = responses.tokenFacts(wire.response.usage);
            }
            for (const mapped of responsesMapper.map(wire)) {
              if (mapped.content || mapped.toolCalls?.length)
                handle.firstToken();
              yield mapped;
            }
            if (responsesFinished) break;
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
        if (family === 'responses' && !responsesFinished)
          throw new LlmError(
            'SAP AI Core Responses stream ended before completion',
          );
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
    return new LlmError(CONTEXT_OVERFLOW_MESSAGE, MODEL_CONTEXT_EXCEEDED);
  return new LlmError('SAP AI Core foundation inference failed');
}
