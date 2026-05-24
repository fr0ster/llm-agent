import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RagResult } from '@mcp-abap-adt/llm-agent';
import { ScoreThresholdToolSelection } from '../score-threshold.js';
import { TopKToolSelection } from '../top-k.js';

const r = (id: string, score: number): RagResult => ({
  text: id,
  metadata: { id },
  score,
});

describe('TopKToolSelection', () => {
  it('returns all results unchanged (name top-k)', () => {
    const s = new TopKToolSelection();
    const input = [r('tool:a', 0.9), r('tool:b', 0.1)];
    assert.equal(s.name, 'top-k');
    assert.deepEqual(s.select(input), input);
  });
});

describe('ScoreThresholdToolSelection', () => {
  it('keeps only results with score >= minScore (name threshold)', () => {
    const s = new ScoreThresholdToolSelection(0.4);
    assert.equal(s.name, 'threshold');
    const kept = s.select([
      r('tool:a', 0.9),
      r('tool:b', 0.39),
      r('tool:c', 0.4),
    ]);
    assert.deepEqual(
      kept.map((x) => x.metadata.id),
      ['tool:a', 'tool:c'],
    );
  });

  it('returns empty when all scores are below threshold', () => {
    const s = new ScoreThresholdToolSelection(0.5);
    assert.deepEqual(s.select([r('tool:a', 0.1), r('tool:b', 0.2)]), []);
  });
});
