import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  ILlm,
  IMcpClient,
  IMcpConnectionStrategy,
  IRag,
} from '@mcp-abap-adt/llm-agent';
import { McpError, RagError } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../agent.js';
import { makeDefaultDeps, makeRag } from '../../testing/index.js';
import { buildAgentHealthSnapshot } from '../agent-health.js';

// Spec §10.5.10 (D72): every configured component is probed, and one that is
// not working — or did not answer — is reported not OK (H2–H4; H5 kept).

const options = {} as CallOptions;

const healthyLlm = {
  async chat() {
    return { ok: true as const, value: {} };
  },
  async healthCheck() {
    return { ok: true as const, value: true };
  },
} as unknown as ILlm;

function storeAnswering(ok: boolean): IRag {
  const store = makeRag();
  store.healthCheck = async () =>
    ok
      ? { ok: true as const, value: undefined }
      : { ok: false as const, error: new RagError('store down') };
  return store;
}

function clientWithHealth(healthCheck: IMcpClient['healthCheck']): IMcpClient {
  return {
    async listTools() {
      return { ok: true as const, value: [] };
    },
    async callTool() {
      return { ok: true as const, value: { content: '' } };
    },
    healthCheck,
  };
}

describe('buildAgentHealthSnapshot — fail loud (D72)', () => {
  it('H2: every RAG store is probed — the second store down ⇒ rag: false', async () => {
    let secondProbed = false;
    const second = storeAnswering(false);
    const probe = second.healthCheck.bind(second);
    second.healthCheck = async (o) => {
      secondProbed = true;
      return probe(o);
    };
    const snapshot = await buildAgentHealthSnapshot(
      healthyLlm,
      { first: storeAnswering(true), second },
      [],
      options,
    );
    assert.equal(secondProbed, true, 'the second store must be probed');
    assert.equal(snapshot.rag, false);
  });

  it('H2: a store whose probe rejects ⇒ rag: false', async () => {
    const rejecting = makeRag();
    rejecting.healthCheck = async () => {
      throw new Error('socket hang up');
    };
    const snapshot = await buildAgentHealthSnapshot(
      healthyLlm,
      { first: storeAnswering(true), rejecting },
      [],
      options,
    );
    assert.equal(snapshot.rag, false);
  });

  it('H2: every store answering ⇒ rag: true', async () => {
    const snapshot = await buildAgentHealthSnapshot(
      healthyLlm,
      { a: storeAnswering(true), b: storeAnswering(true) },
      [],
      options,
    );
    assert.equal(snapshot.rag, true);
  });

  it('H2 (pinned): no store ⇒ rag: true (absent by design)', async () => {
    const snapshot = await buildAgentHealthSnapshot(
      healthyLlm,
      {},
      [],
      options,
    );
    assert.equal(snapshot.rag, true);
  });

  it('H3: an MCP healthCheck answering { ok: true, value: false } ⇒ its entry ok: false', async () => {
    const snapshot = await buildAgentHealthSnapshot(
      healthyLlm,
      {},
      [
        clientWithHealth(async () => ({ ok: true, value: false })),
        clientWithHealth(async () => ({ ok: true, value: true })),
      ],
      options,
    );
    assert.equal(snapshot.mcp.length, 2);
    assert.equal(snapshot.mcp[0].ok, false);
    assert.equal(snapshot.mcp[1].ok, true);
  });

  it('H3: an MCP healthCheck answering ok: false carries its error', async () => {
    const snapshot = await buildAgentHealthSnapshot(
      healthyLlm,
      {},
      [
        clientWithHealth(async () => ({
          ok: false,
          error: new McpError('ping failed', 'MCP_UNAVAILABLE'),
        })),
      ],
      options,
    );
    assert.deepEqual(snapshot.mcp, [
      { name: 'mcp-client', ok: false, error: 'ping failed' },
    ]);
  });

  it('H4: a probe that rejects (timeout) is reported ok: false with the error — never mcp: []', async () => {
    const timeout = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
    const snapshot = await buildAgentHealthSnapshot(
      healthyLlm,
      {},
      [
        clientWithHealth(async () => {
          throw timeout;
        }),
        clientWithHealth(async () => ({ ok: true, value: true })),
      ],
      options,
    );
    assert.equal(snapshot.mcp.length, 2, 'every client is reported');
    assert.equal(snapshot.mcp[0].ok, false);
    assert.match(snapshot.mcp[0].error ?? '', /timeout/);
    assert.equal(snapshot.mcp[1].ok, true);
  });

  it('H4: a probe that never answers is reported ok: false with the timeout once the health signal fires', {
    timeout: 5_000,
  }, async () => {
    const snapshot = await buildAgentHealthSnapshot(
      healthyLlm,
      {},
      [
        clientWithHealth(() => new Promise(() => {})),
        clientWithHealth(async () => ({ ok: true, value: true })),
      ],
      { signal: AbortSignal.timeout(20) } as CallOptions,
    );
    assert.equal(snapshot.mcp.length, 2, 'every client is reported');
    assert.equal(snapshot.mcp[0].ok, false);
    assert.match(snapshot.mcp[0].error ?? '', /timeout/i);
    assert.equal(snapshot.mcp[1].ok, true);
  });
});

describe('SmartAgent health — H5 kept', () => {
  it('a strategy reporting no readiness ⇒ isReady() true; its MCP health comes from the probes', async () => {
    const strategy: IMcpConnectionStrategy = {
      async resolve(current) {
        return { clients: current, toolsChanged: false };
      },
    };
    const { deps } = makeDefaultDeps({
      connectionStrategy: strategy,
      mcpClients: [clientWithHealth(async () => ({ ok: true, value: false }))],
    });
    const agent = new SmartAgent(deps, { maxIterations: 5 });
    assert.equal(agent.isReady(), true);
    const health = await agent.healthCheck();
    assert.ok(health.ok);
    assert.equal(health.value.mcp.length, 1);
    assert.equal(health.value.mcp[0].ok, false);
  });
});
