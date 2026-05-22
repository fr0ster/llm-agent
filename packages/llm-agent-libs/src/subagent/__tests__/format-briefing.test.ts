import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatBriefing } from '../format-briefing.js';

describe('formatBriefing', () => {
  it('returns the raw task when briefing is absent', () => {
    assert.equal(formatBriefing('Find auth bug'), 'Find auth bug');
  });

  it('returns the raw task when briefing has only empty fields', () => {
    assert.equal(
      formatBriefing('Find auth bug', { known: [], tried: [] }),
      'Find auth bug',
    );
  });

  it('renders Goal, Known, Tried, Constraints, Artifacts in canonical order', () => {
    const out = formatBriefing('Fix the failing test', {
      goal: 'Ship the auth refactor by Friday',
      known: ['Token TTL is 15min', 'Refresh endpoint returns 401 for expired'],
      tried: [
        'Step s1: bumped TTL to 30min — same 401',
        'Step s2: grep for setCookie — no results in src/auth/',
      ],
      constraints: ['Do not edit src/legacy/', 'Keep response under 200 words'],
      artifacts: [
        { ref: 'src/auth/token.ts', summary: 'TokenManager — main entry' },
      ],
    });

    const expected = [
      'Goal: Ship the auth refactor by Friday',
      '',
      'Known so far:',
      '- Token TTL is 15min',
      '- Refresh endpoint returns 401 for expired',
      '',
      'Already tried (do not repeat these approaches):',
      '- Step s1: bumped TTL to 30min — same 401',
      '- Step s2: grep for setCookie — no results in src/auth/',
      '',
      'Constraints:',
      '- Do not edit src/legacy/',
      '- Keep response under 200 words',
      '',
      'Relevant artifacts:',
      '- src/auth/token.ts — TokenManager — main entry',
      '',
      'Task: Fix the failing test',
    ].join('\n');

    assert.equal(out, expected);
  });

  it('omits sections whose array is empty', () => {
    const out = formatBriefing('Do X', {
      goal: 'Bigger goal',
      known: ['a'],
      tried: [],
    });
    assert.ok(out.includes('Goal: Bigger goal'));
    assert.ok(out.includes('Known so far:'));
    assert.ok(!out.includes('Already tried'));
    assert.ok(out.endsWith('Task: Do X'));
  });

  it('omits the Goal line when goal is an empty string', () => {
    const out = formatBriefing('Do X', { goal: '', known: ['a'] });
    assert.ok(!out.includes('Goal:'));
    assert.ok(out.includes('Known so far:'));
  });
});
