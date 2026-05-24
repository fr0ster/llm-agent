/**
 * domain-neutral-tool-exposure.test.ts
 *
 * Proves that tool exposure is driven by RAG semantic distance + the
 * tool-selection strategy — NOT by SAP-specific classifier routing rules.
 *
 * Two cases:
 *   POSITIVE  — semantically relevant query; GetTableStructure scores 0.8
 *               (above ScoreThresholdToolSelection(0.5)) → tool is exposed.
 *   NEGATIVE  — off-topic query; every tool scores 0.1 (below threshold)
 *               → no tools exposed. This is the case plain top-k cannot produce.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ScoreThresholdToolSelection } from '../../tool-selection/index.js';
import { ToolSelectHandler } from '../tool-select.js';

const span = { setAttribute() {} };

function makeCtx(toolScore: number) {
  const ragResults = {
    tools: [
      {
        text: 'Get the structure of an ABAP database table',
        metadata: { id: 'tool:GetTableStructure' },
        score: toolScore,
      },
    ],
  };
  return {
    config: { mode: 'smart' },
    mcpTools: [
      {
        name: 'GetTableStructure',
        description: 'Get table structure',
        inputSchema: {},
      },
    ],
    mcpClients: [],
    toolClientMap: new Map(),
    ragResults,
    ragStores: {},
    externalTools: [],
    embedder: undefined,
    toolSelectionStrategy: new ScoreThresholdToolSelection(0.5),
    sessionId: 's1',
    options: {},
    toolAvailabilityRegistry: {
      filterTools: (_s: string, tools: unknown[]) => ({
        allowed: tools,
        blocked: [],
      }),
    },
    selectedTools: [] as unknown[],
    activeTools: [] as unknown[],
  };
}

describe('domain-neutral tool exposure — semantic distance + strategy (no SAP classifier rule)', () => {
  it('POSITIVE: T100 query with above-threshold score exposes GetTableStructure', async () => {
    // Simulate: "Прочитай структуру таблиці T100" — tools RAG returns GetTableStructure at 0.8
    // No SAP classifier rule involved — only RAG score and ScoreThresholdToolSelection(0.5).
    const ctx = makeCtx(0.8);
    // biome-ignore lint/suspicious/noExplicitAny: minimal ctx stub for handler test
    await new ToolSelectHandler().execute(ctx as any, {}, span as any);
    const names = (ctx.activeTools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    assert.ok(
      names.includes('GetTableStructure'),
      `Expected GetTableStructure in active tools, got: ${names}`,
    );
  });

  it('NEGATIVE: off-topic query with below-threshold scores exposes no tools', async () => {
    // Simulate: "привіт, як справи" — all tools score 0.1 (semantically unrelated)
    // ScoreThresholdToolSelection(0.5) filters them all out → activeTools = [].
    const ctx = makeCtx(0.1);
    // biome-ignore lint/suspicious/noExplicitAny: minimal ctx stub for handler test
    await new ToolSelectHandler().execute(ctx as any, {}, span as any);
    assert.deepEqual(
      ctx.activeTools,
      [],
      'Expected no active tools for off-topic query',
    );
  });
});
