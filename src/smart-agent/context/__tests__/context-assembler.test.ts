import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  McpTool,
  RagResult,
  ToolCallRecord,
} from '../../interfaces/types.js';
import { ContextAssembler } from '../context-assembler.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFact(text: string, score: number): RagResult {
  return { text, score, metadata: {} };
}

function makeTool(name: string, description: string): McpTool {
  return { name, description, inputSchema: {} };
}

function makeToolRecord(
  name: string,
  content: string | Record<string, unknown>,
): ToolCallRecord {
  return {
    call: { id: `${name}-1`, name, arguments: {} },
    result: { content },
  };
}

const ACTION = { type: 'action' as const, text: 'What should I do next?' };
const EMPTY = { ragResults: {}, tools: [] as McpTool[] };

// ---------------------------------------------------------------------------
// Empty retrieved
// ---------------------------------------------------------------------------

describe('ContextAssembler — empty retrieved', () => {
  it('produces only a user message when all sections empty', async () => {
    const assembler = new ContextAssembler();
    const r = await assembler.assemble(ACTION, EMPTY, []);
    assert.ok(r.ok);
    assert.equal(r.value.length, 1);
    assert.equal(r.value[0].role, 'user');
    assert.equal(r.value[0].content, ACTION.text);
  });

  it('no system message when retrieved is empty and no preamble', async () => {
    const assembler = new ContextAssembler();
    const r = await assembler.assemble(ACTION, EMPTY, []);
    assert.ok(r.ok);
    const systemMsgs = r.value.filter((m) => m.role === 'system');
    assert.equal(systemMsgs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Individual sections
// ---------------------------------------------------------------------------

describe('ContextAssembler — facts only', () => {
  it('system message contains ## Known Facts', async () => {
    const assembler = new ContextAssembler();
    const r = await assembler.assemble(
      ACTION,
      {
        ragResults: { facts: [makeFact('Water boils at 100°C', 0.9)] },
        tools: [],
      },
      [],
    );
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    assert.ok(sys, 'system message should exist');
    assert.ok(sys.content.includes('## Known Facts'));
    assert.ok(sys.content.includes('Water boils at 100°C'));
  });
});

describe('ContextAssembler — feedback only', () => {
  it('system message contains ## Feedback', async () => {
    const assembler = new ContextAssembler();
    const r = await assembler.assemble(
      ACTION,
      {
        ragResults: { feedback: [makeFact('Your last answer was wrong', 0.8)] },
        tools: [],
      },
      [],
    );
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    assert.ok(sys, 'system message should exist');
    assert.ok(sys.content.includes('## Feedback'));
    assert.ok(sys.content.includes('Your last answer was wrong'));
  });
});

describe('ContextAssembler — state only', () => {
  it('system message contains ## Current State', async () => {
    const assembler = new ContextAssembler();
    const r = await assembler.assemble(
      ACTION,
      {
        ragResults: { state: [makeFact('User prefers dark mode', 0.85)] },
        tools: [],
      },
      [],
    );
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    assert.ok(sys, 'system message should exist');
    assert.ok(sys.content.includes('## Current State'));
    assert.ok(sys.content.includes('User prefers dark mode'));
  });
});

describe('ContextAssembler — tools only', () => {
  it('tools-only input produces no tool descriptions in system prompt', async () => {
    const assembler = new ContextAssembler();
    const r = await assembler.assemble(
      ACTION,
      { ragResults: {}, tools: [makeTool('search', 'Search the web')] },
      [],
    );
    assert.ok(r.ok);
    // Tool descriptions are no longer in system prompt — they go via LLM tools parameter
    const sys = r.value.find((m) => m.role === 'system');
    if (sys) {
      assert.ok(!sys.content.includes('## Available Tools'));
    }
  });
});

// ---------------------------------------------------------------------------
// All sections combined
// ---------------------------------------------------------------------------

describe('ContextAssembler — all sections', () => {
  it('system message contains all 4 headers and user msg has action text', async () => {
    const assembler = new ContextAssembler();
    const r = await assembler.assemble(
      ACTION,
      {
        ragResults: {
          facts: [makeFact('Fact A', 0.9)],
          feedback: [makeFact('Feedback B', 0.8)],
          state: [makeFact('State C', 0.7)],
        },
        tools: [makeTool('calculator', 'Perform calculations')],
      },
      [],
    );
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    assert.ok(sys);
    assert.ok(sys.content.includes('## Known Facts'));
    assert.ok(sys.content.includes('## Feedback'));
    assert.ok(sys.content.includes('## Current State'));
    assert.ok(!sys.content.includes('## Available Tools'));

    const userMsg = r.value.find((m) => m.role === 'user');
    assert.ok(userMsg);
    assert.equal(userMsg.content, ACTION.text);
  });
});

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

describe('ContextAssembler — tool results', () => {
  it('one ToolCallRecord → one role:tool message', async () => {
    const assembler = new ContextAssembler();
    const r = await assembler.assemble(ACTION, EMPTY, [
      makeToolRecord('search', 'found 10 results'),
    ]);
    assert.ok(r.ok);
    const toolMsgs = r.value.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 1);
    assert.equal(toolMsgs[0].content, 'search: found 10 results');
  });

  it('two ToolCallRecords → two tool messages in order', async () => {
    const assembler = new ContextAssembler();
    const r = await assembler.assemble(ACTION, EMPTY, [
      makeToolRecord('search', 'result A'),
      makeToolRecord('calculate', 'result B'),
    ]);
    assert.ok(r.ok);
    const toolMsgs = r.value.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 2);
    assert.equal(toolMsgs[0].content, 'search: result A');
    assert.equal(toolMsgs[1].content, 'calculate: result B');
  });
});

// ---------------------------------------------------------------------------
// Sort by score
// ---------------------------------------------------------------------------

describe('ContextAssembler — sort by score', () => {
  it('facts with higher score appear first in system message', async () => {
    const assembler = new ContextAssembler();
    const r = await assembler.assemble(
      ACTION,
      {
        ragResults: {
          facts: [
            makeFact('Low score fact', 0.3),
            makeFact('High score fact', 0.9),
            makeFact('Mid score fact', 0.6),
          ],
        },
        tools: [],
      },
      [],
    );
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    assert.ok(sys);
    const highIdx = sys.content.indexOf('High score fact');
    const midIdx = sys.content.indexOf('Mid score fact');
    const lowIdx = sys.content.indexOf('Low score fact');
    assert.ok(highIdx < midIdx, 'high score should appear before mid score');
    assert.ok(midIdx < lowIdx, 'mid score should appear before low score');
  });
});

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe('ContextAssembler — provenance', () => {
  it('provenance off by default — no score annotations', async () => {
    const assembler = new ContextAssembler();
    const r = await assembler.assemble(
      ACTION,
      { ragResults: { facts: [makeFact('Some fact', 0.92)] }, tools: [] },
      [],
    );
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    assert.ok(sys);
    assert.ok(
      !sys.content.includes('[score:'),
      'should not include score annotation',
    );
  });

  it('provenance on — score annotations present', async () => {
    const assembler = new ContextAssembler({ includeProvenance: true });
    const r = await assembler.assemble(
      ACTION,
      { ragResults: { facts: [makeFact('Some fact', 0.92)] }, tools: [] },
      [],
    );
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    assert.ok(sys);
    assert.ok(
      sys.content.includes('[score: 0.92]'),
      'should include score annotation',
    );
  });
});

// ---------------------------------------------------------------------------
// Snapshot test
// ---------------------------------------------------------------------------

describe('ContextAssembler — snapshot', () => {
  it('fixed input produces exact Message[] structure', async () => {
    const assembler = new ContextAssembler({
      systemPromptPreamble: 'You are a helpful assistant.',
      includeProvenance: true,
    });
    const r = await assembler.assemble(
      { type: 'action', text: 'Calculate 2+2.' },
      {
        ragResults: { facts: [makeFact('Math is universal', 0.95)] },
        tools: [makeTool('calc', 'Basic arithmetic')],
      },
      [makeToolRecord('calc', '4')],
    );
    assert.ok(r.ok);
    assert.equal(r.value.length, 3);

    assert.equal(r.value[0].role, 'system');
    assert.ok(r.value[0].content.includes('You are a helpful assistant.'));
    assert.ok(r.value[0].content.includes('## Known Facts'));
    assert.ok(r.value[0].content.includes('[score: 0.95]'));
    assert.ok(!r.value[0].content.includes('## Available Tools'));

    assert.equal(r.value[1].role, 'user');
    assert.equal(r.value[1].content, 'Calculate 2+2.');

    assert.equal(r.value[2].role, 'tool');
    assert.equal(r.value[2].content, 'calc: 4');
  });
});

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

describe('ContextAssembler — token budget', () => {
  it('budget fits — all entries preserved', async () => {
    const assembler = new ContextAssembler({ maxTokens: 10000 });
    const r = await assembler.assemble(
      ACTION,
      {
        ragResults: {
          facts: [makeFact('Fact A', 0.9)],
          feedback: [makeFact('Feedback B', 0.8)],
          state: [makeFact('State C', 0.7)],
        },
        tools: [makeTool('tool1', 'Does something useful')],
      },
      [],
    );
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    assert.ok(sys);
    assert.ok(sys.content.includes('Fact A'));
    assert.ok(sys.content.includes('Feedback B'));
    assert.ok(sys.content.includes('State C'));
    // Tool descriptions no longer in system prompt — passed via LLM tools parameter
    assert.ok(!sys.content.includes('tool1'));
  });

  it('tools overflow — tools at end of list dropped first', async () => {
    // Set a very small budget that forces dropping
    const assembler = new ContextAssembler({ maxTokens: 10 });
    const r = await assembler.assemble(
      { type: 'action', text: 'Hi' },
      {
        ragResults: {},
        tools: [
          makeTool(
            'first-tool',
            'First tool description that is quite long for budget',
          ),
          makeTool(
            'second-tool',
            'Second tool description also quite long for budget',
          ),
          makeTool(
            'third-tool',
            'Third tool description that overflows the token budget',
          ),
        ],
      },
      [],
    );
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    // With a tiny budget, some tools should be dropped
    if (sys) {
      // If any tools remain, the last tool should be dropped first
      const hasFirstTool = sys.content.includes('first-tool');
      const hasThirdTool = sys.content.includes('third-tool');
      if (hasFirstTool) {
        // third-tool (added last) should have been dropped before first-tool
        assert.ok(
          !hasThirdTool,
          'last tool should be dropped before first tool',
        );
      }
    }
    // User message must always be present
    const userMsg = r.value.find((m) => m.role === 'user');
    assert.ok(userMsg);
    assert.equal(userMsg.content, 'Hi');
  });

  it('facts overflow — facts with lowest score dropped', async () => {
    const assembler = new ContextAssembler({ maxTokens: 10 });
    const r = await assembler.assemble(
      { type: 'action', text: 'Hi' },
      {
        ragResults: {
          facts: [
            makeFact('High importance fact score 0.99', 0.99),
            makeFact('Low importance fact score 0.01', 0.01),
          ],
        },
        tools: [],
      },
      [],
    );
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    if (sys) {
      const hasHigh = sys.content.includes('High importance fact');
      const hasLow = sys.content.includes('Low importance fact');
      if (hasHigh) {
        assert.ok(
          !hasLow,
          'low score fact should be dropped before high score fact',
        );
      }
    }
  });

  it('action always kept — user message preserved even when everything else dropped', async () => {
    const assembler = new ContextAssembler({ maxTokens: 1 });
    const r = await assembler.assemble(
      { type: 'action', text: 'Critical action text' },
      {
        ragResults: {
          facts: [
            makeFact('Some fact that is long and will not fit in budget', 0.5),
          ],
          feedback: [
            makeFact(
              'Some feedback that is long and will not fit in budget',
              0.5,
            ),
          ],
          state: [
            makeFact('Some state that is long and will not fit in budget', 0.5),
          ],
        },
        tools: [
          makeTool('some-tool', 'Some tool description that is very long'),
        ],
      },
      [],
    );
    assert.ok(r.ok);
    const userMsg = r.value.find((m) => m.role === 'user');
    assert.ok(userMsg, 'user message must always be present');
    assert.equal(userMsg.content, 'Critical action text');
  });
});

// ---------------------------------------------------------------------------
// AbortSignal
// ---------------------------------------------------------------------------

describe('ContextAssembler — AbortSignal', () => {
  it('pre-aborted signal → ABORTED error, messages not built', async () => {
    const assembler = new ContextAssembler();
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await assembler.assemble(ACTION, EMPTY, [], {
      signal: ctrl.signal,
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'ABORTED');
  });
});

// ---------------------------------------------------------------------------
// systemPromptPreamble
// ---------------------------------------------------------------------------

describe('ContextAssembler — systemPromptPreamble', () => {
  it('preamble appears in system content even with empty retrieved', async () => {
    const assembler = new ContextAssembler({
      systemPromptPreamble: 'You are a precise assistant.',
    });
    const r = await assembler.assemble(ACTION, EMPTY, []);
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    assert.ok(sys, 'system message should exist when preamble is set');
    assert.ok(sys.content.includes('You are a precise assistant.'));
  });

  it('preamble and context sections joined with double newline', async () => {
    const assembler = new ContextAssembler({
      systemPromptPreamble: 'Preamble text.',
    });
    const r = await assembler.assemble(
      ACTION,
      { ragResults: { facts: [makeFact('Fact here', 0.9)] }, tools: [] },
      [],
    );
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    assert.ok(sys);
    assert.ok(
      sys.content.includes('Preamble text.'),
      'should contain preamble',
    );
    assert.ok(
      sys.content.includes('## Known Facts'),
      'should contain context section',
    );
    // Preamble should come before context sections
    assert.ok(
      sys.content.indexOf('Preamble text.') <
        sys.content.indexOf('## Known Facts'),
      'preamble should precede context',
    );
  });
});

// ---------------------------------------------------------------------------
// McpToolResult object content
// ---------------------------------------------------------------------------

describe('ContextAssembler — McpToolResult object content', () => {
  it('object result is JSON.stringify-ed in tool message', async () => {
    const assembler = new ContextAssembler();
    const objectResult = { status: 'ok', value: 42 };
    const r = await assembler.assemble(ACTION, EMPTY, [
      {
        call: { id: 'tool-1', name: 'get-data', arguments: {} },
        result: { content: objectResult },
      },
    ]);
    assert.ok(r.ok);
    const toolMsg = r.value.find((m) => m.role === 'tool');
    assert.ok(toolMsg);
    assert.equal(toolMsg.content, `get-data: ${JSON.stringify(objectResult)}`);
  });
});
