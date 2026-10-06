/**
 * 30.1.0 tool records, byte for byte: id, text and metadata of every record
 * `vectorizeMcpTools` writes WITHOUT a profile (spec §7.6, §13). Regenerate only
 * on a deliberate change: GOLDEN_UPDATE=1 node --import tsx/esm --test <this file>.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  IMcpClient,
  IRag,
  McpTool,
  RagMetadata,
} from '@mcp-abap-adt/llm-agent';
import { NoopRequestLogger } from '../logger/noop-request-logger.js';
import { vectorizeMcpTools } from '../mcp/vectorize-mcp-tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(
  HERE,
  '../../../../scripts/rag-eval/tools.mcp-abap-adt-16.0.0-readonly-high.json',
);
const GOLDEN = join(HERE, 'fixtures/baseline-tool-records.golden.json');

interface Written {
  id: string;
  text: string;
  metadata: RagMetadata;
}

function recordingStore(written: Written[]): IRag {
  return {
    query: async () => ({ ok: true, value: [] }),
    healthCheck: async () => ({ ok: true, value: undefined }),
    getById: async () => ({ ok: true, value: null }),
    writer: () => ({
      upsertRaw: async (id, text, metadata) => {
        written.push({ id, text, metadata });
        return { ok: true, value: undefined };
      },
      deleteByIdRaw: async () => ({ ok: true, value: false }),
    }),
  };
}

describe('30.1.0 tool records (golden)', () => {
  it('vectorizeMcpTools without a profile writes exactly the golden records', async () => {
    const { tools } = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as {
      tools: McpTool[];
    };
    const client: IMcpClient = {
      listTools: async () => ({ ok: true, value: tools }),
      callTool: async () => {
        throw new Error('not called');
      },
    } as unknown as IMcpClient;
    const written: Written[] = [];
    const summary = await vectorizeMcpTools(
      [client],
      recordingStore(written),
      new NoopRequestLogger(),
      undefined,
    );
    assert.equal(summary?.vectorized, tools.length);
    // The golden file is the oracle: it is written only on request
    // (GOLDEN_UPDATE=1, Step 2), never because it is missing — a missing or
    // mis-pathed fixture fails the test instead of seeding itself.
    if (process.env.GOLDEN_UPDATE === '1') {
      writeFileSync(GOLDEN, `${JSON.stringify(written, null, 2)}\n`);
    }
    assert.ok(
      existsSync(GOLDEN),
      `golden file missing: ${GOLDEN} — generate it on the untouched code with GOLDEN_UPDATE=1`,
    );
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Written[];
    assert.deepEqual(written, golden);
  });
});
