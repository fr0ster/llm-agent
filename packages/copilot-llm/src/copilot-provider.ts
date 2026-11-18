import { createHmac, randomBytes } from 'node:crypto';
import { type SessionConfig, ToolSet } from '@github/copilot-sdk';
import {
  type CallOptions,
  deepStableArgsKey,
  type ILlm,
  type IModelInfo,
  LlmError,
  type LlmResponse,
  type LlmStreamChunk,
  type LlmTool,
  type Message,
  type Result,
  retryAfterSecondsOf,
  runWithThrottleRetry,
  WaitAsTold,
} from '@mcp-abap-adt/llm-agent';
import {
  aborted,
  CopilotThrottleError,
  credentialsRejected,
  sdkError,
} from './errors.js';
import {
  type CopilotSdkClientFactory,
  type CopilotSdkSession,
  createSdkClient,
  retainRuntime,
} from './sdk.js';
import { deferred, SessionTurn, withAbort } from './turn.js';

export interface CopilotConfig {
  model?: string;
}

interface ActiveSession {
  sdk: CopilotSdkSession;
  turn: SessionTurn;
  fingerprint: string;
  configuration: string;
  disconnected: AbortController;
  unsubscribe: () => void;
}

const quotaStrategy = new WaitAsTold({ fallbackBackoffMs: 2000 });
const fingerprintKey = randomBytes(32);
const fingerprint = (apiKey: string) =>
  createHmac('sha256', fingerprintKey).update(apiKey).digest('hex');

function sessionConfig(
  model: string | undefined,
  system: string,
  tools: LlmTool[],
): SessionConfig {
  const availableTools = new ToolSet();
  for (const tool of tools) availableTools.addCustom(tool.name);
  return {
    model,
    systemMessage: { mode: 'replace', content: system },
    availableTools: tools.length ? availableTools : [],
    excludedTools: new ToolSet().addBuiltIn('*').addMcp('*'),
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      parameters: inputSchema,
      defer: 'never',
      skipPermission: true,
    })),
    streaming: true,
    infiniteSessions: { enabled: false },
    enableConfigDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSkills: false,
    enableOnDemandInstructionDiscovery: false,
    onPermissionRequest: () => ({ kind: 'reject' }),
  };
}

function renderPrompt(messages: Message[]): string {
  return JSON.stringify(
    messages.flatMap(({ role, content, tool_call_id, tool_calls }) =>
      role === 'system' ? [] : [{ role, content, tool_call_id, tool_calls }],
    ),
  );
}

export class CopilotProvider implements ILlm {
  readonly model?: string;
  private readonly lifetime = new AbortController();
  private runtime?: ReturnType<typeof retainRuntime>;
  private session?: ActiveSession;
  private closing?: Promise<void>;
  private tail = Promise.resolve();
  private disposal?: Promise<void>;

  constructor(
    config: CopilotConfig = {},
    private readonly clientFactory: CopilotSdkClientFactory = createSdkClient,
  ) {
    this.model = config.model;
  }

  chat(
    messages: Message[],
    tools: LlmTool[] = [],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>> {
    return this.run(messages, tools, options, () => {});
  }

  async *streamChat(
    messages: Message[],
    tools: LlmTool[] = [],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    const controller = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const chunks: LlmStreamChunk[] = [];
    let changed = deferred<void>();
    let result: Result<LlmResponse, LlmError> | undefined;
    let streamed = false;
    let delivered = false;
    const task = this.run(messages, tools, { ...options, signal }, (chunk) => {
      streamed = !chunk.reset;
      chunks.push(chunk);
      changed.resolve();
    }).then((response) => {
      result = response;
      changed.resolve();
    });
    try {
      while (!result || chunks.length) {
        await changed.promise;
        for (const chunk of chunks.splice(0)) yield { ok: true, value: chunk };
        if (!chunks.length && !result) changed = deferred<void>();
      }
      delivered = true;
      if (!result.ok) {
        yield result;
        return;
      }
      yield {
        ok: true,
        value: {
          ...result.value,
          content: streamed ? '' : result.value.content,
        },
      };
    } finally {
      if (!delivered) controller.abort();
      await task;
    }
  }

  getModels(options?: CallOptions): Promise<Result<IModelInfo[], LlmError>> {
    return this.enqueue(options?.signal, async (signal) => {
      const apiKey = options?.apiKey;
      if (!apiKey?.trim()) throw credentialsRejected();
      return this.retry(apiKey, undefined, signal, async () => {
        const runtime = this.getRuntime();
        const client = await withAbort(runtime.getClient(), signal);
        try {
          const models = await withAbort(client.listModels(apiKey), signal);
          return models.map(({ id, name, capabilities }) => ({
            id,
            displayName: name,
            provider: 'copilot',
            contextLength: capabilities.limits?.max_context_window_tokens,
            ...(capabilities.limits?.max_output_tokens !== undefined
              ? { maxOutputTokens: capabilities.limits.max_output_tokens }
              : {}),
          }));
        } catch (error) {
          if (!signal.aborted) runtime.invalidate(client);
          throw sdkError(error);
        }
      });
    });
  }

  dispose(): Promise<void> {
    this.lifetime.abort();
    this.disposal ??= (async () => {
      const current = this.session;
      if (current) await this.closeSession(current, true);
      await this.tail;
      await this.runtime?.release();
      await this.closing;
    })();
    return this.disposal;
  }

  private async enqueue<T>(
    requestedSignal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<Result<T, LlmError>> {
    const signal = requestedSignal
      ? AbortSignal.any([requestedSignal, this.lifetime.signal])
      : this.lifetime.signal;
    const previous = this.tail;
    const finished = deferred<void>();
    this.tail = previous.then(() => finished.promise);
    try {
      await withAbort(previous, signal);
      if (signal.aborted) throw aborted();
      return { ok: true, value: await work(signal) };
    } catch (error) {
      return { ok: false, error: signal.aborted ? aborted() : sdkError(error) };
    } finally {
      finished.resolve();
    }
  }

  private run(
    messages: Message[],
    tools: LlmTool[],
    options: CallOptions | undefined,
    emit: (chunk: LlmStreamChunk) => void,
  ): Promise<Result<LlmResponse, LlmError>> {
    return this.enqueue(options?.signal, async (signal) => {
      const apiKey = options?.apiKey;
      if (!apiKey?.trim()) throw credentialsRejected();
      const model = options?.model ?? this.model;
      const system = messages
        .filter(({ role }) => role === 'system')
        .map(({ content }) => content ?? '')
        .join('\n\n');
      const configuration = deepStableArgsKey({ model, system, tools });
      const tokenFingerprint = fingerprint(apiKey);
      return this.retry(apiKey, model, signal, async () => {
        let current: ActiveSession | undefined;
        let streamed = false;
        try {
          current = await this.getSession(
            apiKey,
            tokenFingerprint,
            configuration,
            model,
            system,
            tools,
            signal,
          );
          const { sdk, turn, disconnected } = current;
          const results = turn.matchingResults(messages);
          turn.resume();
          if (!results.size) {
            if (turn.hasPending()) {
              turn.clearPending();
              await withAbort(sdk.abort(), signal);
            }
            if (turn.firstUserEvent) {
              const rewind = await withAbort(
                sdk.rpc.history.rewind({
                  eventId: turn.firstUserEvent,
                  mode: 'conversation',
                }),
                signal,
              );
              if (rewind.outcome !== 'success')
                throw new LlmError(
                  'Copilot history rewind failed',
                  'COPILOT_ERROR',
                );
              turn.firstUserEvent = undefined;
            }
          }
          if (signal.aborted) throw aborted();
          const response = await turn.collect(
            results.size
              ? () => turn.submitResults(results, signal)
              : async () => {
                  await sdk.send({ prompt: renderPrompt(messages) });
                },
            signal,
            disconnected.signal,
            (content) => {
              if (!content) return;
              streamed = true;
              emit({ content });
            },
            results.size > 0,
          );
          if (signal.aborted) throw aborted();
          if (response.finishReason === 'tool_calls') {
            turn.suspend(signal, () => {
              void this.closeSession(current, true);
            });
          } else {
            turn.clearPending();
          }
          return response;
        } catch (error) {
          void this.closeSession(current, true);
          const failure = signal.aborted ? aborted() : sdkError(error);
          if (failure instanceof CopilotThrottleError && streamed)
            emit({ content: '', reset: true });
          throw failure;
        }
      });
    });
  }

  private retry<T>(
    apiKey: string,
    model: string | undefined,
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    return runWithThrottleRetry(work, {
      key: `copilot:${fingerprint(apiKey)}:${model ?? 'default'}`,
      strategy: quotaStrategy,
      isThrottled: (error) => error instanceof CopilotThrottleError,
      retryAfterSeconds: (error) =>
        error instanceof CopilotThrottleError
          ? retryAfterSecondsOf(error)
          : undefined,
      signal,
    });
  }

  private getRuntime() {
    this.runtime ??= retainRuntime(this.clientFactory);
    return this.runtime;
  }

  private async getSession(
    apiKey: string,
    tokenFingerprint: string,
    configuration: string,
    model: string | undefined,
    system: string,
    tools: LlmTool[],
    signal: AbortSignal,
  ): Promise<ActiveSession> {
    const previous = this.session;
    if (
      previous?.fingerprint === tokenFingerprint &&
      previous.configuration === configuration
    )
      return previous;
    await withAbort(this.closeSession(previous, true), signal);
    if (signal.aborted) throw aborted();
    const runtime = this.getRuntime();
    const client = await withAbort(runtime.getClient(), signal);
    if (signal.aborted) throw aborted();
    const opening = client.createSession({
      ...sessionConfig(model, system, tools),
      gitHubToken: apiKey,
    });
    let sdk: CopilotSdkSession;
    try {
      sdk = await withAbort(opening, signal);
    } catch (error) {
      if (signal.aborted) {
        void this.trackClosing(opening.then((late) => late.disconnect()));
      } else {
        runtime.invalidate(client);
      }
      throw error;
    }
    const turn = new SessionTurn(sdk);
    const current = {
      sdk,
      turn,
      fingerprint: tokenFingerprint,
      configuration,
      disconnected: new AbortController(),
      unsubscribe: sdk.on((event) => turn.onEvent(event)),
    };
    this.session = current;
    try {
      sdk.onDisconnect(() => {
        current.disconnected.abort();
        if (this.session !== current) return;
        this.session = undefined;
        current.turn.clearPending();
        runtime.invalidate(client);
      });
    } catch (error) {
      runtime.invalidate(client);
      void this.closeSession(current, true);
      throw error;
    }
    return current;
  }

  private async closeSession(
    current: ActiveSession | undefined,
    abort: boolean,
  ): Promise<void> {
    if (!current || this.session !== current) return this.closing;
    this.session = undefined;
    current.turn.clearPending();
    current.unsubscribe();
    current.disconnected.abort();
    if (abort) void current.sdk.abort().catch(() => {});
    return this.trackClosing(current.sdk.disconnect());
  }

  private async trackClosing(operation: Promise<void>): Promise<void> {
    const closing = operation.catch(() => {});
    this.closing = closing;
    await closing;
    if (this.closing === closing) this.closing = undefined;
  }
}
