import type {
  IApiKeyCredential,
  IBearerCredential,
  ISecretLoginCredential,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  IMcpClient,
  IMcpServer,
  McpClientDescriptor,
  McpClientFactory,
  McpClientFactoryResult,
  McpConnectionConfig,
} from '@mcp-abap-adt/llm-agent';
import { createDefaultMcpClient } from '../factory.js';

/**
 * The stdio twin of `HttpMcpAuth`: each variant demands the ONE kind it can
 * use, and a credential with nowhere to go is unconstructible. A login needs
 * two variables, because a principal and a secret are one fact that travels
 * together (§4) and a child reads them separately.
 */
export type StdioMcpAuth =
  | { readonly scheme: 'none' }
  | {
      readonly scheme: 'env-token';
      readonly variable: string;
      readonly credential: IBearerCredential;
    }
  | {
      readonly scheme: 'env-key';
      readonly variable: string;
      readonly credential: IApiKeyCredential;
    }
  | {
      readonly scheme: 'env-login';
      readonly userVariable: string;
      readonly secretVariable: string;
      readonly credential: ISecretLoginCredential;
    };

export interface StdioMcpServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  /** The caller's own values; merged over the SDK's host-default subset (§3.5). */
  readonly env?: Readonly<Record<string, string>>;
  /** Required: a child either authenticates or says it does not. */
  readonly auth: StdioMcpAuth;
  readonly timeout?: number;
  readonly toolTimeouts?: Readonly<Record<string, number>>;
  readonly descriptor?: McpClientDescriptor;
}

/**
 * A child process this server spawns — the local case (§3.3). The secret goes
 * into the child's `env`, never `args`, which any process can read in `ps`.
 * Single-use, like `mcpServerFromFactory`.
 */
export class StdioMcpServer implements IMcpServer {
  readonly descriptor?: McpClientDescriptor;
  private state: 'idle' | 'started' | 'stopped' = 'idle';
  private close: (() => Promise<void> | void) | undefined;
  /** The start in flight: `state` stays 'idle' across its awaits. */
  private starting: Promise<IMcpClient> | undefined;

  constructor(
    private readonly cfg: StdioMcpServerConfig,
    private readonly createClient: McpClientFactory = createDefaultMcpClient,
  ) {
    if (cfg.descriptor) this.descriptor = cfg.descriptor;
  }

  start(): Promise<IMcpClient> {
    // Concurrent callers share the one start in flight: without this, both
    // would pass the 'idle' check below and build two clients.
    if (this.starting) return this.starting;
    if (this.state === 'started') {
      return Promise.reject(new Error('StdioMcpServer already started'));
    }
    if (this.state === 'stopped') {
      return Promise.reject(
        new Error('StdioMcpServer already stopped; build a new one'),
      );
    }
    const starting = this.connect().then(
      (result) => {
        this.starting = undefined;
        this.state = 'started';
        this.close = result.close;
        return result.client;
      },
      (err: unknown) => {
        // Failed: nothing was acquired, so the server stays startable.
        this.starting = undefined;
        throw err;
      },
    );
    this.starting = starting;
    return starting;
  }

  private async connect(): Promise<McpClientFactoryResult> {
    const { command, args, env, auth, timeout, toolTimeouts } = this.cfg;
    const config: McpConnectionConfig = {
      type: 'stdio',
      command,
      // `args?: string[]` is mutable on the contract, so copy rather than cast.
      args: [...(args ?? [])],
      // The credential goes LAST so a caller's env cannot shadow it.
      env: { ...(env ?? {}), ...(await authEnv(auth)) },
      ...(timeout !== undefined ? { timeout } : {}),
      ...(toolTimeouts ? { toolTimeouts: { ...toolTimeouts } } : {}),
    };
    return this.createClient(config);
  }

  async stop(): Promise<void> {
    // A start in flight finishes first, so the client it makes is closed here
    // rather than leaked. Its failure is delivered to its own callers; for
    // stop() it only means there is nothing to close.
    if (this.starting) await this.starting.catch(() => undefined);
    const pending = this.close;
    this.close = undefined;
    if (this.state === 'started') this.state = 'stopped';
    if (pending) await pending();
  }
}

async function authEnv(auth: StdioMcpAuth): Promise<Record<string, string>> {
  switch (auth.scheme) {
    case 'none':
      return {};
    case 'env-token':
      return { [auth.variable]: await auth.credential.token() };
    case 'env-key':
      return { [auth.variable]: await auth.credential.secret() };
    case 'env-login':
      return {
        [auth.userVariable]: auth.credential.principal,
        [auth.secretVariable]: await auth.credential.secret(),
      };
  }
}
