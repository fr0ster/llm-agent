import type {
  IApiKeyCredential,
  IBearerCredential,
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
 * Where the material goes is the accepting implementation's business (§4): an
 * api key is the same key whether a server wants it as `Authorization: Bearer`,
 * `x-api-key` or `api-key`. So the scheme is declared, not guessed — and each
 * variant demands the ONE credential kind it can use, which keeps this off the
 * shared union §4.6.2 forbids. `'none'` makes an unauthenticated target a
 * statement rather than an omission.
 */
export type HttpMcpAuth =
  | { readonly scheme: 'bearer'; readonly credential: IBearerCredential }
  | {
      readonly scheme: 'header';
      /** Which header carries it: `x-api-key`, `api-key`, or `Authorization`. */
      readonly header: string;
      /**
       * What precedes the key in the value: `'Bearer '` for a target that wants
       * `Authorization: Bearer sk-…`; omitted for one that wants the raw key.
       */
      readonly prefix?: string;
      readonly credential: IApiKeyCredential;
    }
  | { readonly scheme: 'none' };

export interface HttpMcpServerConfig {
  readonly url: string;
  /** Required: a target either authenticates or says it does not. */
  readonly auth: HttpMcpAuth;
  /**
   * Static extra headers (routing, `Accept`). One naming the credential's own
   * header, in any case, is dropped — the credential wins.
   */
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeout?: number;
  readonly toolTimeouts?: Readonly<Record<string, number>>;
  /** Stable identity for tool namespacing (§3.4); absent = array position. */
  readonly descriptor?: McpClientDescriptor;
  // No `requestHeadersStrategy`: its headers are merged AFTER static ones at
  // connect (client.ts buildHttpTransportOptions), so it could replace the
  // credential. It stays extra headers, not the authentication seam (§3.5).
}

/**
 * An http MCP server already running elsewhere: `start()` acquires and holds a
 * connection, `stop()` releases it; nothing is spawned.
 *
 * The credential is resolved at CONNECT, once: `IMcpRequestHeadersStrategy
 * .headers()` is synchronous and merged at connect, so a long-lived connection
 * carries the token it connected with (§3.3). Single-use, like
 * `mcpServerFromFactory`: a fresh credential means a fresh instance, and
 * reconnection is `IMcpConnectionStrategy`'s job.
 */
export class HttpMcpServer implements IMcpServer {
  readonly descriptor?: McpClientDescriptor;
  private state: 'idle' | 'started' | 'stopped' = 'idle';
  private close: (() => Promise<void> | void) | undefined;
  /** The start in flight: `state` stays 'idle' across its awaits. */
  private starting: Promise<IMcpClient> | undefined;

  constructor(
    private readonly cfg: HttpMcpServerConfig,
    private readonly createClient: McpClientFactory = createDefaultMcpClient,
  ) {
    if (cfg.descriptor) this.descriptor = cfg.descriptor;
  }

  start(): Promise<IMcpClient> {
    // Concurrent callers share the one start in flight: without this, both
    // would pass the 'idle' check below and build two clients.
    if (this.starting) return this.starting;
    if (this.state === 'started') {
      return Promise.reject(new Error('HttpMcpServer already started'));
    }
    if (this.state === 'stopped') {
      return Promise.reject(
        new Error('HttpMcpServer already stopped; build a new one'),
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
    const { url, auth, headers, timeout, toolTimeouts } = this.cfg;
    const authed = await authHeaders(auth);
    const taken = new Set(Object.keys(authed).map((k) => k.toLowerCase()));
    const kept = Object.fromEntries(
      Object.entries(headers ?? {}).filter(
        ([k]) => !taken.has(k.toLowerCase()),
      ),
    );
    const config: McpConnectionConfig = {
      type: 'http',
      url,
      headers: { ...kept, ...authed },
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
    this.close = undefined; // cleared FIRST, so a failing close is never retried into a double close
    if (this.state === 'started') this.state = 'stopped';
    // `close?` is optional on McpClientFactoryResult (mcp-connection-strategy.ts:68).
    if (pending) await pending();
  }
}

async function authHeaders(auth: HttpMcpAuth): Promise<Record<string, string>> {
  switch (auth.scheme) {
    case 'none':
      return {};
    case 'bearer':
      return { Authorization: `Bearer ${await auth.credential.token()}` };
    case 'header':
      // The target named its own header AND its own value shape.
      return {
        [auth.header]: `${auth.prefix ?? ''}${await auth.credential.secret()}`,
      };
  }
}
