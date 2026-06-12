import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryKnowledgeBackend } from '@mcp-abap-adt/llm-agent-libs';
import {
  classifyRequest,
  fingerprintRequest,
  readTerminal,
  type TerminalOutcome,
  writeTerminal,
} from '../run-scope.js';
import type { SessionBundle } from '../types.js';

describe('fingerprintRequest', () => {
  it('is stable across whitespace/transport noise', () => {
    assert.equal(
      fingerprintRequest('  read T100  '),
      fingerprintRequest('read T100'),
    );
  });
  it('differs for different content', () => {
    assert.notEqual(
      fingerprintRequest('read T100'),
      fingerprintRequest('read T200'),
    );
  });
});

describe('terminal store', () => {
  it('writes and reads a discriminated terminal outcome by runId', async () => {
    const be = new InMemoryKnowledgeBackend();
    const out: TerminalOutcome = { kind: 'success', answer: 'ANSWER' };
    await writeTerminal(
      be,
      'sess',
      'R1',
      out,
      1000,
      '2026-06-10T00:00:00.000Z',
    );
    const got = await readTerminal(
      be,
      'sess',
      'R1',
      '2026-06-10T00:00:00.500Z',
    );
    assert.deepEqual(got, out);
  });
  it('returns undefined once expired (TTL elapsed)', async () => {
    const be = new InMemoryKnowledgeBackend();
    await writeTerminal(
      be,
      'sess',
      'R1',
      { kind: 'error', error: 'boom' },
      1000,
      '2026-06-10T00:00:00.000Z',
    );
    const got = await readTerminal(
      be,
      'sess',
      'R1',
      '2026-06-10T00:00:02.000Z',
    );
    assert.equal(got, undefined);
  });
});

describe('classifyRequest (strict ordered)', () => {
  const bundle = (over = {}): SessionBundle =>
    ({
      runId: 'R1',
      runState: 'active',
      runPhase: 'planning',
      originalRequest: 'read T100',
      goal: 'g',
      plannerPrivate: '',
      budgets: { stepsUsed: 0, rewindsUsed: 0 },
      ...over,
    }) as SessionBundle;

  it('newRun flag wins over everything', () => {
    const r = classifyRequest({
      bundle: bundle(),
      incomingRequest: 'read T100',
      newRun: true,
      explicitKey: 'R1',
      terminalExists: true,
    });
    assert.equal(r.kind, 'fresh');
  });
  it('explicit key in terminal store → replay', () => {
    const r = classifyRequest({
      bundle: bundle({ runState: 'terminal' }),
      incomingRequest: 'x',
      explicitKey: 'R9',
      terminalExists: true,
    });
    assert.deepEqual(r, { kind: 'replay', runId: 'R9' });
  });
  it('explicit key == active bundle runId → resume', () => {
    const r = classifyRequest({
      bundle: bundle(),
      incomingRequest: 'x',
      explicitKey: 'R1',
      terminalExists: false,
    });
    assert.deepEqual(r, { kind: 'resume' });
  });
  it('explicit key matches a TERMINAL current run with no store entry → not-found', () => {
    const r = classifyRequest({
      bundle: bundle({ runState: 'terminal' }),
      incomingRequest: 'x',
      explicitKey: 'R1',
      terminalExists: false,
    });
    assert.equal(r.kind, 'not-found');
  });
  it('no key + fingerprint matches an ACTIVE run → resume', () => {
    const r = classifyRequest({
      bundle: bundle(),
      incomingRequest: 'read T100',
      terminalExists: false,
    });
    assert.deepEqual(r, { kind: 'resume' });
  });
  it('no key + fingerprint matches a TERMINAL run → fresh (no replay)', () => {
    const r = classifyRequest({
      bundle: bundle({ runState: 'terminal' }),
      incomingRequest: 'read T100',
      terminalExists: true,
    });
    assert.equal(r.kind, 'fresh');
  });
});
