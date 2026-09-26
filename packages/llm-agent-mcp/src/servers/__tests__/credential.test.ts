import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IApiKeyCredential,
  IBearerCredential,
  ISecretLoginCredential,
} from '@mcp-abap-adt/interfaces-auth';
import type {
  McpClientFactoryResult,
  McpConnectionConfig,
} from '@mcp-abap-adt/llm-agent';
import { HttpMcpServer } from '../http-mcp-server.js';
import { StdioMcpServer } from '../stdio-mcp-server.js';

const URL_ = 'https://mcp.example/mcp';

/** Records the config it was given, and how often close() was called. */
function fakeFactory() {
  const configs: McpConnectionConfig[] = [];
  let closes = 0;
  const client = { listTools: async () => [] } as never;
  const factory = async (
    config: McpConnectionConfig,
  ): Promise<McpClientFactoryResult> => {
    configs.push(config);
    return {
      client,
      close: async () => {
        closes += 1;
      },
    };
  };
  return { configs, client, factory, closes: () => closes };
}

describe('HttpMcpServer', () => {
  it('start() resolves the credential into the connection headers and returns the client', async () => {
    const f = fakeFactory();
    let asked = 0;
    const credential: IBearerCredential = {
      kind: 'bearer',
      token: async () => `t${++asked}`,
    };
    const server = new HttpMcpServer(
      {
        url: URL_,
        auth: { scheme: 'bearer', credential },
        headers: { 'X-Trace': 'abc' },
      },
      f.factory,
    );
    const client = await server.start();
    assert.equal(client, f.client, 'start() returns the factory’s client');
    assert.equal(f.configs.length, 1);
    const config = f.configs[0];
    assert.equal(config.type, 'http');
    assert.equal(config.url, URL_);
    assert.equal(config.headers?.Authorization, 'Bearer t1');
    assert.equal(config.headers?.['X-Trace'], 'abc', 'static headers survive');
    assert.equal(
      asked,
      1,
      'asked once per connection: headers() is synchronous',
    );
  });

  it('puts an API key in the header the TARGET names, not in Authorization', async () => {
    const f = fakeFactory();
    const credential: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => 'k-1',
    };
    await new HttpMcpServer(
      {
        url: URL_,
        auth: { scheme: 'header', header: 'x-api-key', credential },
      },
      f.factory,
    ).start();
    const config = f.configs[0];
    assert.equal(config.headers?.['x-api-key'], 'k-1');
    assert.equal(
      config.headers?.Authorization,
      undefined,
      'the api-key contract says nothing about placement, so assuming Bearer would leave ' +
        'a target that wants x-api-key unauthenticated',
    );
  });

  it('honours the prefix, so Authorization: Bearer <api-key> is expressible', async () => {
    const f = fakeFactory();
    const credential: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => 'k-1',
    };
    await new HttpMcpServer(
      {
        url: URL_,
        auth: {
          scheme: 'header',
          header: 'Authorization',
          prefix: 'Bearer ',
          credential,
        },
      },
      f.factory,
    ).start();
    assert.equal(
      f.configs[0].headers?.Authorization,
      'Bearer k-1',
      'an implementation that ignored `prefix` would send the raw key here',
    );
  });

  it('will not accept a bearer credential where a header key is declared', () => {
    const f = fakeFactory();
    const bearer: IBearerCredential = {
      kind: 'bearer',
      token: async () => 't',
    };
    // biome-ignore format: one line — @ts-expect-error covers only the next line
    // @ts-expect-error each variant demands the one kind it can use
    void new HttpMcpServer({ url: URL_, auth: { scheme: 'header', header: 'x-api-key', credential: bearer } }, f.factory);
  });

  it('a static header cannot overwrite the credential, whatever its case', async () => {
    const f = fakeFactory();
    const credential: IBearerCredential = {
      kind: 'bearer',
      token: async () => 'tok',
    };
    await new HttpMcpServer(
      {
        url: URL_,
        auth: { scheme: 'bearer', credential },
        headers: {
          Authorization: 'Bearer stale',
          authorization: 'Bearer stale2',
        },
      },
      f.factory,
    ).start();
    const headers = f.configs[0].headers ?? {};
    const auth = Object.entries(headers).filter(
      ([k]) => k.toLowerCase() === 'authorization',
    );
    assert.deepEqual(
      auth,
      [['Authorization', 'Bearer tok']],
      'fetch merges header names case-insensitively, so a lowercase stale one would be ' +
        'sent joined to the real one',
    );
  });

  it('carries its descriptor, so pairing survives withMcpServers', () => {
    const descriptor = { slotIndex: 2, label: 'sap' };
    const server = new HttpMcpServer(
      { url: URL_, auth: { scheme: 'none' }, descriptor },
      fakeFactory().factory,
    );
    assert.deepEqual(server.descriptor, descriptor);
  });

  it('tolerates a factory that returns no close at all', async () => {
    const client = { listTools: async () => [] } as never;
    const server = new HttpMcpServer(
      { url: URL_, auth: { scheme: 'none' } },
      async () => ({ client }), // `close` is optional on the contract
    );
    await server.start();
    await server.stop(); // must not throw
  });

  it('stop() closes exactly once, and is safe to call twice', async () => {
    const f = fakeFactory();
    const server = new HttpMcpServer(
      { url: URL_, auth: { scheme: 'none' } },
      f.factory,
    );
    await server.start();
    await server.stop();
    await server.stop();
    assert.equal(
      f.closes(),
      1,
      'a second stop must not close a connection it does not hold',
    );
  });

  it('stop() before start() does nothing and leaves the server usable', async () => {
    const f = fakeFactory();
    const server = new HttpMcpServer(
      { url: URL_, auth: { scheme: 'none' } },
      f.factory,
    );
    await server.stop();
    assert.equal(f.closes(), 0);
    await server.start();
    assert.equal(f.configs.length, 1);
  });

  it('a second start() refuses rather than leaking the first connection', async () => {
    const f = fakeFactory();
    const server = new HttpMcpServer(
      { url: URL_, auth: { scheme: 'none' } },
      f.factory,
    );
    await server.start();
    await assert.rejects(() => server.start(), /already started/);
    assert.equal(f.configs.length, 1);
  });

  it('cannot be restarted after stop() — a fresh credential means a fresh instance', async () => {
    const f = fakeFactory();
    const server = new HttpMcpServer(
      { url: URL_, auth: { scheme: 'none' } },
      f.factory,
    );
    await server.start();
    await server.stop();
    await assert.rejects(
      () => server.start(),
      /already stopped; build a new one/,
    );
    assert.equal(f.configs.length, 1);
  });

  it('a start whose credential fails attempts no connection and stays startable', async () => {
    const f = fakeFactory();
    let calls = 0;
    const credential: IBearerCredential = {
      kind: 'bearer',
      token: async () => {
        calls += 1;
        if (calls === 1) throw new Error('idp down');
        return 't';
      },
    };
    const server = new HttpMcpServer(
      { url: URL_, auth: { scheme: 'bearer', credential } },
      f.factory,
    );
    await assert.rejects(() => server.start(), /idp down/);
    assert.equal(
      f.configs.length,
      0,
      'nothing connects without its credential',
    );
    await server.start();
    assert.equal(f.configs[0].headers?.Authorization, 'Bearer t');
  });
});

describe('StdioMcpServer', () => {
  it('start() puts the secret in the child env and never in argv', async () => {
    const f = fakeFactory();
    const credential: IBearerCredential = {
      kind: 'bearer',
      token: async () => 'super-secret',
    };
    const server = new StdioMcpServer(
      {
        command: 'node',
        args: ['-e', 'process.stdin.resume()'],
        env: { KEEP: '1' },
        auth: { scheme: 'env-token', variable: 'MCP_TOKEN', credential },
      },
      f.factory,
    );
    const client = await server.start();
    assert.equal(client, f.client);
    const config = f.configs[0];
    assert.equal(config.type, 'stdio');
    assert.equal(config.env?.MCP_TOKEN, 'super-secret');
    assert.equal(config.env?.KEEP, '1', 'the caller’s own env survives');
    assert.ok(
      !config.args?.join(' ').includes('super-secret'),
      'argv is readable by any process on the machine',
    );
    assert.ok(!config.command?.includes('super-secret'));
  });

  it('cannot be constructed with a credential and nowhere to put it', () => {
    const f = fakeFactory();
    const credential: IBearerCredential = {
      kind: 'bearer',
      token: async () => 'x',
    };
    // biome-ignore format: one line — @ts-expect-error covers only the next line
    // @ts-expect-error the variant demands a variable — this state is unconstructible
    void new StdioMcpServer({ command: 'node', args: [], auth: { scheme: 'env-token', credential } }, f.factory);
  });

  it('passes an api key through its own variable', async () => {
    const f = fakeFactory();
    const credential: IApiKeyCredential = {
      kind: 'api-key',
      secret: async () => 'k',
    };
    await new StdioMcpServer(
      {
        command: 'node',
        auth: { scheme: 'env-key', variable: 'API_KEY', credential },
      },
      f.factory,
    ).start();
    assert.equal(f.configs[0].env?.API_KEY, 'k');
  });

  it('passes a login as two variables, because a principal and a secret travel together', async () => {
    const f = fakeFactory();
    const credential: ISecretLoginCredential = {
      kind: 'secret-login',
      principal: 'svc',
      secret: async () => 'pw',
    };
    await new StdioMcpServer(
      {
        command: 'node',
        args: [],
        auth: {
          scheme: 'env-login',
          userVariable: 'DB_USER',
          secretVariable: 'DB_PASS',
          credential,
        },
      },
      f.factory,
    ).start();
    const config = f.configs[0];
    assert.equal(config.env?.DB_USER, 'svc');
    assert.equal(config.env?.DB_PASS, 'pw');
  });

  it('carries no descriptor unless given one', () => {
    const server = new StdioMcpServer(
      { command: 'node', auth: { scheme: 'none' } },
      fakeFactory().factory,
    );
    assert.equal(server.descriptor, undefined);
  });

  it('stop() closes exactly once, and a stopped server is not restarted', async () => {
    const f = fakeFactory();
    const server = new StdioMcpServer(
      { command: 'node', args: [], auth: { scheme: 'none' } },
      f.factory,
    );
    await server.start();
    await server.stop();
    await server.stop();
    assert.equal(f.closes(), 1);
    await assert.rejects(
      () => server.start(),
      /already stopped; build a new one/,
    );
  });
});
