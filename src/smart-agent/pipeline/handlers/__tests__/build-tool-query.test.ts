import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ISkill } from '../../../interfaces/skill.js';
import type { RagResult } from '../../../interfaces/types.js';
import type { ISpan } from '../../../tracer/types.js';
import type { PipelineContext } from '../../context.js';
import { BuildToolQueryHandler } from '../build-tool-query.js';

function makeSpan(): ISpan {
  return {
    setAttribute() {},
    setStatus() {},
    addEvent() {},
    end() {},
  } as unknown as ISpan;
}

function makeRagResult(id: string, text: string, score = 0.5): RagResult {
  return { text, metadata: { id } as unknown as RagResult['metadata'], score };
}

function makeSkill(name: string, description: string): ISkill {
  return { name, description } as unknown as ISkill;
}

function makeCtx(partial: Partial<PipelineContext>): PipelineContext {
  return {
    inputText: '',
    ragText: '',
    ragResults: {},
    selectedSkills: [],
    options: undefined,
    ...partial,
  } as unknown as PipelineContext;
}

describe('BuildToolQueryHandler', () => {
  it('composes ragText + snippets + skills and writes toolQueryText', async () => {
    const ctx = makeCtx({
      ragText: 'how to read an ABAP table',
      ragResults: {
        facts: [
          makeRagResult('fact:1', 'Tables are stored in DD02L.'),
          makeRagResult('fact:2', 'Use SE16 to preview rows.'),
        ],
      },
      selectedSkills: [makeSkill('abap-basics', 'SE16 / SE11 quick reference')],
    });
    const handler = new BuildToolQueryHandler();
    const ok = await handler.execute(ctx, {}, makeSpan());
    assert.equal(ok, true);
    assert.ok(ctx.toolQueryText);
    assert.match(ctx.toolQueryText ?? '', /how to read an ABAP table/);
    assert.match(ctx.toolQueryText ?? '', /DD02L/);
    assert.match(ctx.toolQueryText ?? '', /SE16 to preview/);
    assert.match(
      ctx.toolQueryText ?? '',
      /abap-basics: SE16 \/ SE11 quick reference/,
    );
  });

  it('excludes tool:* RAG entries from the snippet block', async () => {
    const ctx = makeCtx({
      ragText: 'question',
      ragResults: {
        mixed: [
          makeRagResult(
            'tool:GetTable',
            'Tool description that must be skipped',
          ),
          makeRagResult('fact:1', 'keep this fact'),
        ],
      },
    });
    await new BuildToolQueryHandler().execute(ctx, {}, makeSpan());
    assert.doesNotMatch(ctx.toolQueryText ?? '', /must be skipped/);
    assert.match(ctx.toolQueryText ?? '', /keep this fact/);
  });

  it('honors topK per store', async () => {
    const ctx = makeCtx({
      ragText: 'q',
      ragResults: {
        facts: [
          makeRagResult('fact:1', 'A'),
          makeRagResult('fact:2', 'B'),
          makeRagResult('fact:3', 'C'),
        ],
      },
    });
    await new BuildToolQueryHandler().execute(ctx, { topK: 2 }, makeSpan());
    assert.match(ctx.toolQueryText ?? '', /A/);
    assert.match(ctx.toolQueryText ?? '', /B/);
    assert.doesNotMatch(ctx.toolQueryText ?? '', /\bC\b/);
  });

  it('truncates to maxChars with trailing ellipsis', async () => {
    const longText = 'x'.repeat(5000);
    const ctx = makeCtx({
      ragText: longText,
    });
    await new BuildToolQueryHandler().execute(
      ctx,
      { maxChars: 100 },
      makeSpan(),
    );
    assert.equal(ctx.toolQueryText?.length, 101); // 100 + ellipsis char
    assert.ok(ctx.toolQueryText?.endsWith('…'));
  });

  it('skips sections when flags are disabled', async () => {
    const ctx = makeCtx({
      ragText: 'base',
      ragResults: { facts: [makeRagResult('fact:1', 'snippet-text')] },
      selectedSkills: [makeSkill('skill-a', 'desc-a')],
    });
    await new BuildToolQueryHandler().execute(
      ctx,
      { includeRagSnippets: false, includeSkills: false },
      makeSpan(),
    );
    assert.equal(ctx.toolQueryText, 'base');
  });

  it('respects skipStores', async () => {
    const ctx = makeCtx({
      ragText: 'q',
      ragResults: {
        facts: [makeRagResult('fact:1', 'keep-me')],
        history: [makeRagResult('h:1', 'skip-me')],
      },
    });
    await new BuildToolQueryHandler().execute(
      ctx,
      { skipStores: ['history'] },
      makeSpan(),
    );
    assert.match(ctx.toolQueryText ?? '', /keep-me/);
    assert.doesNotMatch(ctx.toolQueryText ?? '', /skip-me/);
  });
});
