import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CopilotClient,
  type CopilotSession,
  RuntimeConnection,
  type SessionConfig,
  type SessionEvent,
} from '@github/copilot-sdk';

type SessionRpc = CopilotSession['rpc'];
type Model = Awaited<
  ReturnType<CopilotClient['rpc']['models']['list']>
>['models'][number];

export interface CopilotSdkSession
  extends Pick<CopilotSession, 'abort' | 'disconnect'> {
  send(options: { prompt: string }): Promise<string>;
  on(handler: (event: SessionEvent) => void): () => void;
  onDisconnect(handler: () => void): void;
  rpc: {
    history: Pick<SessionRpc['history'], 'rewind'>;
    tools: Pick<SessionRpc['tools'], 'handlePendingToolCall'>;
  };
}

export interface CopilotSdkClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
  createSession(config: SessionConfig): Promise<CopilotSdkSession>;
  listModels(apiKey: string): Promise<Model[]>;
}

export type CopilotSdkClientFactory = () => CopilotSdkClient;

export const createSdkClient: CopilotSdkClientFactory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'copilot-llm-'));
  const excludedEnv = new Set([
    'COPILOT_TOKEN',
    'COPILOT_GITHUB_TOKEN',
    'COPILOT_SDK_AUTH_TOKEN',
    'COPILOT_CONNECTION_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'COPILOT_RUNTIME_PROCESS_FILE_LOGGING',
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      const name = key.toUpperCase();
      return !excludedEnv.has(name) && !name.startsWith('COPILOT_OTEL_');
    }),
  );
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio(),
    mode: 'empty',
    baseDirectory: directory,
    workingDirectory: directory,
    useLoggedInUser: false,
    logLevel: 'none',
    env,
  });
  const onExit = () => {
    void client.forceStop().catch(() => {});
  };
  process.once('exit', onExit);

  return {
    start: () => client.start(),
    isConnected() {
      try {
        return Boolean(client.rpc);
      } catch {
        return false;
      }
    },
    async stop() {
      try {
        const errors = await client.stop().catch(() => [new Error()]);
        if (errors.length) await client.forceStop();
      } finally {
        process.removeListener('exit', onExit);
        await rm(directory, { recursive: true, force: true });
      }
    },
    async createSession(config) {
      const session = await client.createSession(config);
      return {
        abort: () => session.abort(),
        disconnect: () => session.disconnect(),
        send: (options) => session.send(options),
        on: (handler) => session.on(handler),
        onDisconnect(handler) {
          // SDK 1.0.34 clears event handlers on transport loss without emitting
          // an event. This hook is stripped from its declaration file.
          if (
            !('_setOnDisconnected' in session) ||
            typeof session._setOnDisconnected !== 'function'
          ) {
            throw new Error('Copilot SDK disconnect hook unavailable');
          }
          session._setOnDisconnected(handler);
        },
        rpc: session.rpc,
      };
    },
    async listModels(apiKey) {
      // The SDK convenience method always uses the connection's identity.
      const { models } = await client.rpc.models.list({ gitHubToken: apiKey });
      return models;
    },
  };
};

class SharedRuntime {
  private client?: CopilotSdkClient;
  private ready?: Promise<CopilotSdkClient>;
  private started = false;
  private stop?: Promise<void>;
  private users = 0;

  constructor(private readonly factory: CopilotSdkClientFactory) {}

  retain(): void {
    this.users++;
  }

  async getClient(): Promise<CopilotSdkClient> {
    await this.stop;
    if (this.users === 0) throw new Error('Copilot runtime released');
    this.client ??= this.factory();
    const client = this.client;
    if (this.started && !client.isConnected()) this.invalidate(client);
    this.ready ??= client
      .start()
      .then(() => {
        if (this.client === client) this.started = true;
        return client;
      })
      .catch((error: Error) => {
        this.invalidate(client);
        throw error;
      });
    return this.ready;
  }

  invalidate(client: CopilotSdkClient): void {
    if (this.client === client) {
      this.started = false;
      this.ready = undefined;
    }
  }

  async release(): Promise<void> {
    if (--this.users !== 0 || !this.client) return;
    const client = this.client;
    this.client = undefined;
    this.ready = undefined;
    this.started = false;
    const stop = client.stop().catch(() => {});
    this.stop = stop;
    await stop;
    if (this.stop === stop) this.stop = undefined;
  }
}

const runtimes = new WeakMap<CopilotSdkClientFactory, SharedRuntime>();

export function retainRuntime(factory: CopilotSdkClientFactory): SharedRuntime {
  let runtime = runtimes.get(factory);
  if (!runtime) {
    runtime = new SharedRuntime(factory);
    runtimes.set(factory, runtime);
  }
  runtime.retain();
  return runtime;
}
