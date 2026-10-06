import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type RagResult, staticApiKey } from '@mcp-abap-adt/llm-agent';
import { ProbabilityReranker } from '@mcp-abap-adt/llm-agent-reranker';
import { TypeSafeDecisionModel } from '@mcp-abap-adt/typesafe-decision';

const KEY = process.env.DECISION_API_KEY;
const describeLive = KEY ? describe : describe.skip;

describeLive('TypeSafe Jev — live (DECISION_API_KEY)', () => {
  const model = new TypeSafeDecisionModel({
    credential: staticApiKey(KEY ?? ''),
  });

  it('answers one question of each type', async () => {
    const r = await model.decide({
      state: 'I was charged twice for my subscription this month.',
      questions: {
        billing: { type: 'noul', instructions: 'Is this about billing?' },
        team: {
          type: 'choice',
          instructions: 'Which team should handle this?',
          criteria: {
            billing: 'Payments',
            technical: 'Bugs',
            sales: 'Pricing',
          },
        },
        urgency: {
          type: 'score',
          instructions: 'How urgent is this?',
          criteria: ['Not urgent', 'Somewhat urgent', 'Very urgent'],
        },
      },
    });
    assert.ok(r.ok, r.ok ? '' : `${r.error.code}: ${r.error.message}`);
    assert.ok(r.value.answers.billing.type === 'noul');
    assert.ok(r.value.answers.team.type === 'choice');
    assert.ok(r.value.answers.urgency.type === 'score');
    console.log(JSON.stringify(r.value, null, 2));
  });

  it('reranking puts the relevant passage first (spec §6.1 quality check)', async () => {
    const passages: RagResult[] = [
      {
        text: 'The cafeteria opens at 8am on weekdays.',
        metadata: { id: 'x1' },
        score: 0.9,
      },
      {
        text: 'Parking permits are renewed every January.',
        metadata: { id: 'x2' },
        score: 0.85,
      },
      {
        text: 'To reset your password, open Settings → Security and choose "Reset password"; a link is emailed to you.',
        metadata: { id: 'hit' },
        score: 0.5,
      },
      {
        text: 'The office plants are watered on Fridays.',
        metadata: { id: 'x3' },
        score: 0.8,
      },
    ];
    const r = await new ProbabilityReranker(model).rerank(
      'How do I reset my password?',
      passages,
    );
    assert.ok(r.ok, r.ok ? '' : r.error.message);
    console.log(
      r.value.map((p) => `${p.metadata.id} ${p.score.toFixed(3)}`).join('\n'),
    );
    assert.equal(r.value[0].metadata.id, 'hit');
  });
});
