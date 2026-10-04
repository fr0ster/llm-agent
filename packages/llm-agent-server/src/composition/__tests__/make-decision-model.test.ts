import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { staticApiKey } from '@mcp-abap-adt/llm-agent';
import {
  type CredentialEntry,
  DEFAULT_DECISION_REF,
  memoizeCredentials,
} from '../credential-for.js';
import { createLookup } from '../lookup.js';
import {
  createMakeDecisionModel,
  type DecisionProviderCtors,
} from '../make-decision-model.js';

function harness(entries: Record<string, CredentialEntry>) {
  const seen: Array<Record<string, unknown>> = [];
  const ctors = {
    typesafe: class {
      constructor(cfg: Record<string, unknown>) {
        seen.push(cfg);
      }
      async decide() {
        return { ok: true, value: { model: 'f', answers: {} } };
      }
    },
  } as unknown as DecisionProviderCtors;
  const make = createMakeDecisionModel(
    createLookup(memoizeCredentials((r) => entries[r])),
    ctors,
  );
  return { seen, make };
}

describe('makeDecisionModel', () => {
  it("the default ref is 'DECISION'", async () => {
    assert.equal(DEFAULT_DECISION_REF, 'DECISION');
    const cred = staticApiKey('k');
    const { seen, make } = harness({ DECISION: { credential: cred } });
    await make({ provider: 'typesafe' });
    assert.equal(seen[0].credential, cred);
  });

  it('a named ref is used, and credentialRef never reaches the provider', async () => {
    const cred = staticApiKey('k2');
    const { seen, make } = harness({ TYPESAFE: { credential: cred } });
    await make({ provider: 'typesafe', credentialRef: 'TYPESAFE' });
    assert.equal(seen[0].credential, cred);
    assert.equal('credentialRef' in seen[0], false);
    assert.equal('provider' in seen[0], false);
  });

  it('absent optionals stay absent; maxRetries: 0 is forwarded', async () => {
    const { seen, make } = harness({
      DECISION: { credential: staticApiKey('k') },
    });
    await make({ provider: 'typesafe', maxRetries: 0 });
    assert.deepEqual(Object.keys(seen[0]).sort(), ['credential', 'maxRetries']);
    assert.equal(seen[0].maxRetries, 0);
  });

  it('every knob arrives by name', async () => {
    const { seen, make } = harness({
      DECISION: { credential: staticApiKey('k') },
    });
    await make({
      provider: 'typesafe',
      model: 'jev-1.13.0',
      baseUrl: 'https://p.example',
      timeoutMs: 5000,
      maxRetries: 3,
    });
    assert.equal(seen[0].model, 'jev-1.13.0');
    assert.equal(seen[0].baseUrl, 'https://p.example');
    assert.equal(seen[0].timeoutMs, 5000);
    assert.equal(seen[0].maxRetries, 3);
  });

  it('a non-api-key credential is refused, naming the ref', async () => {
    const bearer: IBearerCredential = {
      kind: 'bearer',
      token: async () => 't',
    };
    const { make } = harness({ DECISION: { credential: bearer } });
    await assert.rejects(
      make({ provider: 'typesafe' }),
      /credentialRef 'DECISION' must hold a api-key credential/,
    );
  });

  it('an unknown provider is refused', async () => {
    const { make } = harness({ DECISION: { credential: staticApiKey('k') } });
    await assert.rejects(
      make({ provider: 'nope' as never }),
      /unknown decision provider 'nope'/,
    );
  });
});
