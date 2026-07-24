import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  capturedFailureText,
  GENERIC_NO_ANSWER,
  nonEmptyBody,
} from '../controller-coordinator-handler.js';
import type { SessionBundle } from '../types.js';

function bundleWith(cf: unknown, plannerPrivate = ''): SessionBundle {
  return {
    inFlightStep: cf ? { controlFailure: cf } : undefined,
    plannerPrivate,
  } as unknown as SessionBundle;
}

describe('capturedFailureText', () => {
  it('returns the trimmed note when present', () => {
    assert.equal(
      capturedFailureText(
        bundleWith({
          reason: 'control-failure',
          seq: 0,
          note: '  Class X not found  ',
        }),
      ),
      'Class X not found',
    );
  });
  it('treats a blank note as absent', () => {
    assert.equal(
      capturedFailureText(
        bundleWith({ reason: 'control-failure', seq: 0, note: '' }),
      ),
      undefined,
    );
    assert.equal(
      capturedFailureText(
        bundleWith({ reason: 'control-failure', seq: 0, note: ' \n\t ' }),
      ),
      undefined,
    );
  });
  it('maps a legacy typed reason (no note) to its human sentence', () => {
    assert.equal(
      capturedFailureText(bundleWith({ reason: 'maxToolCalls', seq: 0 })),
      'tool-call budget exhausted (maxToolCalls)',
    );
    assert.equal(
      capturedFailureText(bundleWith({ reason: 'step-timeout', seq: 0 })),
      'step time budget exhausted (step-timeout)',
    );
  });
  it('a legacy generic marker or no marker → undefined', () => {
    assert.equal(
      capturedFailureText(bundleWith({ reason: 'control-failure', seq: 0 })),
      undefined,
    );
    assert.equal(capturedFailureText(bundleWith(undefined)), undefined);
  });
  it('NEVER surfaces plannerPrivate — external tool / clarify / rewind tail', () => {
    for (const tail of [
      '\n[external tool ReadClass result] SECRET-PAYLOAD',
      '\n[clarify answer] my private prompt',
      '\n[rewind] backtracking',
    ]) {
      assert.equal(capturedFailureText(bundleWith(undefined, tail)), undefined);
      assert.equal(
        capturedFailureText(
          bundleWith({ reason: 'control-failure', seq: 0 }, tail),
        ),
        undefined,
      );
    }
  });
});

describe('nonEmptyBody', () => {
  it('passes non-empty content through', () => {
    assert.equal(
      nonEmptyBody('Error: Class X not found'),
      'Error: Class X not found',
    );
  });
  it('replaces empty/whitespace with GENERIC_NO_ANSWER', () => {
    assert.equal(nonEmptyBody(''), GENERIC_NO_ANSWER);
    assert.equal(nonEmptyBody('   \n\t '), GENERIC_NO_ANSWER);
  });
});
