import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IToolSelectionStrategy } from '@mcp-abap-adt/llm-agent';
import {
  ScoreThresholdToolSelection,
  TopKToolSelection,
} from '../../tool-selection/index.js';
import { ToolSelectHandler } from '../tool-select.js';

function makeCtx(strategy: IToolSelectionStrategy | undefined) {
  const ragResults = {
    tools: [
      { text: 't', metadata: { id: 'tool:keep' }, score: 0.9 },
      { text: 't', metadata: { id: 'tool:drop' }, score: 0.1 },
    ],
  };
  return {
    config: { mode: 'smart' },
    mcpTools: [
      { name: 'keep', description: 'k', inputSchema: {} },
      { name: 'drop', description: 'd', inputSchema: {} },
    ],
    mcpClients: [],
    toolClientMap: new Map(),
    ragResults,
    ragStores: {},
    externalTools: [],
    embedder: undefined,
    toolSelectionStrategy: strategy,
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

const span = { setAttribute() {} };

describe('ToolSelectHandler — tool selection strategy', () => {
  it('threshold strategy exposes only above-threshold tools', async () => {
    const ctx = makeCtx(new ScoreThresholdToolSelection(0.5));
    // biome-ignore lint/suspicious/noExplicitAny: minimal ctx stub for handler test
    await new ToolSelectHandler().execute(ctx as any, {}, span as any);
    assert.deepEqual(
      (ctx.activeTools as Array<{ name: string }>).map((t) => t.name),
      ['keep'],
    );
  });

  it('top-k (and undefined) strategy exposes all tool: matches', async () => {
    for (const strat of [new TopKToolSelection(), undefined]) {
      const ctx = makeCtx(strat);
      // biome-ignore lint/suspicious/noExplicitAny: minimal ctx stub for handler test
      await new ToolSelectHandler().execute(ctx as any, {}, span as any);
      assert.deepEqual(
        (ctx.activeTools as Array<{ name: string }>).map((t) => t.name).sort(),
        ['drop', 'keep'],
      );
    }
  });
});
