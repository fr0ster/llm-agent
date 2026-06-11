import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IKnowledgeRagHandle,
  KnowledgeEntry,
  KnowledgeFilter,
} from '@mcp-abap-adt/llm-agent';
import {
  relevantExtract,
  runScopedRecall,
} from '../controller-coordinator-handler.js';

const E = (over: object, content = 'c'): KnowledgeEntry => ({
  content,
  metadata: {
    traceId: 't',
    turnId: 't',
    stepperId: 'controller',
    task: 'x',
    artifactType: 'step-result',
    createdAt: '2026-06-10T00:00:00.000Z',
    ...over,
  },
});

// Rag stub: returns a scripted list in order; records the k it was asked for.
function ragOf(list: KnowledgeEntry[]): {
  rag: IKnowledgeRagHandle;
  lastK: () => number | undefined;
} {
  let lastK: number | undefined;
  const rag = {
    async query(_t: string, opts?: { k?: number; filter?: KnowledgeFilter }) {
      lastK = opts?.k;
      return list;
    },
    async list() {
      return [];
    },
    async write() {},
    fingerprint() {
      return 's';
    },
  } as IKnowledgeRagHandle;
  return { rag, lastK: () => lastK };
}

describe('runScopedRecall', () => {
  it('dedups a step seq to the precedence winner (ok beats failed)', async () => {
    const { rag } = ragOf([
      E({ runId: 'R', seq: 0, attempt: 0, status: 'failed' }, 'fail'),
      E({ runId: 'R', seq: 0, attempt: 1, status: 'ok' }, 'okk'),
    ]);
    const out = await runScopedRecall(rag, 'q', 5, 'R', 25, ['step-result']);
    assert.equal(out.length, 1);
    assert.equal(out[0].content, 'okk', 'precedence winner kept');
  });
  it('preserves the embedding rank order across distinct seqs', async () => {
    const { rag } = ragOf([
      E({ runId: 'R', seq: 2, attempt: 0, status: 'ok' }, 'B'),
      E({ runId: 'R', seq: 1, attempt: 0, status: 'ok' }, 'A'),
    ]);
    const out = await runScopedRecall(rag, 'q', 5, 'R', 25, ['step-result']);
    assert.deepEqual(
      out.map((e) => e.content),
      ['B', 'A'],
      'query order preserved, not seq-sorted',
    );
  });
  it('dedups mcp-results by identityKey; keeps distinct fetches', async () => {
    const { rag } = ragOf([
      E({ runId: 'R', artifactType: 'mcp-result', identityKey: 'K1' }, 'r1'),
      E({ runId: 'R', artifactType: 'mcp-result', identityKey: 'K1' }, 'r1b'),
      E({ runId: 'R', artifactType: 'mcp-result', identityKey: 'K2' }, 'r2'),
    ]);
    const out = await runScopedRecall(rag, 'q', 5, 'R', 10, ['mcp-result']);
    assert.equal(out.length, 2, 'K1 collapsed, K2 distinct');
  });
  it('requests the caller-supplied k prime (explicit over-fetch)', async () => {
    const { rag, lastK } = ragOf([]);
    await runScopedRecall(rag, 'q', 3, 'R', 15, ['step-result']);
    assert.equal(lastK(), 15, 'the explicit kPrime is the requested cap');
  });
  it('over-fetch lets k distinct steps survive a retry-dup even when the backend HONORS the cap', async () => {
    const list = [
      E({ runId: 'R', seq: 0, attempt: 0, status: 'failed' }, 'f0'),
      E({ runId: 'R', seq: 0, attempt: 1, status: 'ok' }, 'o0'),
      E({ runId: 'R', seq: 1, attempt: 0, status: 'ok' }, 'o1'),
    ];
    let askedK: number | undefined;
    const rag = {
      async query(_t: string, opts?: { k?: number }) {
        askedK = opts?.k;
        return list.slice(0, opts?.k ?? list.length);
      },
      async list() {
        return [];
      },
      async write() {},
      fingerprint() {
        return 's';
      },
    } as IKnowledgeRagHandle;
    const out = await runScopedRecall(rag, 'q', 2, 'R', 4, ['step-result']);
    assert.equal(askedK, 4);
    assert.deepEqual(
      out.map((e) => e.content),
      ['o0', 'o1'],
      'both distinct seqs kept (retry-dup did not starve)',
    );
  });
  it('run-wide MCP bound keeps a distinct identity after ALL prior-attempt dups', async () => {
    const maxSteps = 2;
    const maxStepAttempts = 2;
    const maxToolCalls = 2;
    const runBound = maxSteps * maxStepAttempts * maxToolCalls; // 8
    const list = [
      ...Array.from({ length: runBound - 1 }, (_, i) =>
        E(
          { runId: 'R', artifactType: 'mcp-result', identityKey: 'K1' },
          `a${i}`,
        ),
      ),
      E({ runId: 'R', artifactType: 'mcp-result', identityKey: 'K2' }, 'b'),
    ];
    const rag = {
      async query(_t: string, opts?: { k?: number }) {
        return list.slice(0, opts?.k ?? list.length);
      },
      async list() {
        return [];
      },
      async write() {},
      fingerprint() {
        return 's';
      },
    } as IKnowledgeRagHandle;
    const out = await runScopedRecall(rag, 'q', 2, 'R', runBound, [
      'mcp-result',
    ]);
    const ids = new Set(out.map((e) => e.metadata.identityKey));
    assert.ok(
      ids.has('K1') && ids.has('K2'),
      'distinct K2 survives despite runBound-1 K1 dups (run-wide bound)',
    );
  });
});

describe('relevantExtract', () => {
  // Stub embedder: BOTH the ref ("...reference") and any window containing MARK map
  // to the SAME vector [1,0]; everything else is orthogonal [0,1]. So cosine(ref,
  // MARK-window) = 1 and cosine(ref, plain-window) = 0 — the EMBEDDING (not lexical
  // overlap) picks the MARK window. Counts embed calls.
  let calls = 0;
  const embedder = {
    embed: async (t: string) => {
      calls++;
      return { vector: /MARK|reference/.test(t) ? [1, 0] : [0, 1] };
    },
  } as never;
  it('the RETURNED body equals the SCORED window; bounded SEQUENTIAL embeds', async () => {
    calls = 0;
    const out = await relevantExtract(
      `${'y'.repeat(3000)} ...MARK`,
      'the reference',
      100,
      embedder,
    );
    assert.ok(out.includes('MARK'), 'tail-of-window fragment survives');
    assert.ok(out.length <= 100, 'STRICTLY ≤ maxChars');
    assert.ok(calls <= 64 + 1, 'bounded to MAX_EXTRACT_WINDOWS + 1 embeds');
  });
  it('direct scan surfaces a LATE fragment within the point-coverage range', async () => {
    const content = `${'x'.repeat(10000)} MARK relevant fragment`;
    const out = await relevantExtract(
      content,
      'the target reference',
      200,
      embedder,
    );
    assert.ok(
      out.includes('MARK'),
      'direct maxChars-window ranking surfaced the late fragment',
    );
    assert.ok(
      out.length <= 200,
      'STRICTLY bounded to maxChars including ellipses',
    );
  });
  it('returns a bare slice (no double markers) for a tiny maxChars', async () => {
    const out = await relevantExtract('X'.repeat(100), 'ref', 1, embedder);
    assert.ok(out.length <= 1);
  });
});
