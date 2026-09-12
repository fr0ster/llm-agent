/**
 * Regression (#285, server path): the 22.2.0 rate-limit policy is declared on
 * the provider config, but a server config reaches a provider through two hand
 * written field lists — the flat `llm:` allow-list in resolveLlmSection, and the
 * object makeDefaultRoleLlm builds for makeLlm. A key missing from either is
 * dropped without a word, and the default budget applies in silence.
 *
 * `llm.maxTokens` is covered here too: it was declared on SmartServerLlmConfig
 * and read by neither, which is the same defect already in flight.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveSmartServerConfig } from '../config.js';
import { makeDefaultRoleLlm } from '../llm/role-llm-resolver.js';

/** Minimal YAML that passes validateResolvedConfig, plus the llm keys under test. */
function yamlWith(llm: Record<string, unknown>) {
  return {
    llm: {
      provider: 'ollama',
      model: 'qwen2.5',
      url: 'http://localhost:11434',
      ...llm,
    },
  };
}

const llmOf = (yaml: Record<string, unknown>) =>
  resolveSmartServerConfig({}, yaml, {}).llm as
    | Record<string, unknown>
    | undefined;

describe('llm.whenThrottled from YAML', () => {
  it('reaches the resolved config', () => {
    const llm = llmOf(
      yamlWith({ whenThrottled: { maxAttempts: 3, maxTotalWaitMs: 20000 } }),
    );
    assert.deepEqual(llm?.whenThrottled, {
      maxAttempts: 3,
      maxTotalWaitMs: 20000,
    });
  });

  it('rejects an on/off switch, which this is not', () => {
    // There is no correct alternative to waiting out a closed quota, so there
    // is no YAML key for skipping it. Different mechanics are a strategy,
    // supplied in code.
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          yamlWith({ whenThrottled: { enabled: false } }),
          {},
        ),
      /Unknown llm\.whenThrottled key 'enabled'/,
    );
  });

  it('stays undefined when omitted, so the documented defaults apply', () => {
    assert.equal(llmOf(yamlWith({}))?.whenThrottled, undefined);
  });

  it('rejects an attempt count that is not a positive integer', () => {
    // It is a count including the first attempt, so 0 would behave as 1 and
    // 1.5 as 2 — each meaning something other than what it says.
    for (const bad of [0, -1, 1.5, 'many']) {
      assert.throws(
        () =>
          resolveSmartServerConfig(
            {},
            yamlWith({ whenThrottled: { maxAttempts: bad } }),
            {},
          ),
        /Invalid llm\.whenThrottled\.maxAttempts/,
        `expected a config error for ${JSON.stringify(bad)}`,
      );
    }
  });

  it('accepts a zero budget, which is a real choice', () => {
    // Unlike attempts, the durations are genuinely allowed to be zero: it means
    // do not wait at all, and the shared pause is still marked.
    const llm = llmOf(yamlWith({ whenThrottled: { maxTotalWaitMs: 0 } }));
    assert.deepEqual(llm?.whenThrottled, { maxTotalWaitMs: 0 });
  });

  it('fails fast on a budget that is not a number', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          yamlWith({ whenThrottled: { maxTotalWaitMs: 'soon' } }),
          {},
        ),
      /llm\.whenThrottled\.maxTotalWaitMs/,
    );
  });

  it('fails fast on a misspelled key rather than ignoring it', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          yamlWith({ whenThrottled: { maxAttempt: 3 } }),
          {},
        ),
      /Unknown llm\.whenThrottled key 'maxAttempt'/,
    );
  });

  it('fails fast when it is not a mapping', () => {
    assert.throws(
      () => resolveSmartServerConfig({}, yamlWith({ whenThrottled: 3 }), {}),
      /Invalid llm\.whenThrottled/,
    );
  });
});

describe('the named-map form (llm.main, llm.helper, …)', () => {
  // This branch reaches the config by a cast, so nothing in it used to be
  // checked: a misspelling failed where a config error is least visible.
  const mapYaml = (main: Record<string, unknown>) => ({
    llm: {
      main: { provider: 'ollama', model: 'qwen2.5', apiKey: '', ...main },
    },
  });

  it('carries a valid policy through', () => {
    const llm = resolveSmartServerConfig(
      {},
      mapYaml({ whenThrottled: { maxAttempts: 2 } }),
      {},
    ).llm as Record<string, { whenThrottled?: unknown }>;
    assert.deepEqual(llm.main?.whenThrottled, { maxAttempts: 2 });
  });

  it('fails fast on a misspelled key under a role', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          mapYaml({ whenThrottled: { maxAttempt: 2 } }),
          {},
        ),
      /Unknown llm\.main\.whenThrottled key 'maxAttempt'/,
    );
  });

  it('fails fast on a bad budget under a role', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          mapYaml({ whenThrottled: { maxTotalWaitMs: 'soon' } }),
          {},
        ),
      /Invalid llm\.main\.whenThrottled\.maxTotalWaitMs/,
    );
  });

  it('normalises the values it checks, not just checks them', () => {
    // `${ENV_VAR}` substitution leaves numbers as strings, and the resolved
    // config is typed as though they were numbers. A custom strategy would be
    // handed a string and told it was a number.
    const llm = resolveSmartServerConfig(
      {},
      mapYaml({
        whenThrottled: { maxAttempts: '3', maxTotalWaitMs: '20000' },
        maxTokens: '8192',
      }),
      {},
    ).llm as Record<
      string,
      { whenThrottled?: Record<string, unknown>; maxTokens?: unknown }
    >;
    assert.strictEqual(llm.main?.whenThrottled?.maxAttempts, 3);
    assert.strictEqual(llm.main?.whenThrottled?.maxTotalWaitMs, 20000);
    assert.strictEqual(llm.main?.maxTokens, 8192);
  });

  it('leaves the rest of the entry untouched', () => {
    const llm = resolveSmartServerConfig(
      {},
      mapYaml({ whenThrottled: { maxAttempts: 2 } }),
      {},
    ).llm as Record<string, { model?: string; provider?: string }>;
    assert.equal(llm.main?.model, 'qwen2.5');
    assert.equal(llm.main?.provider, 'ollama');
  });

  it('fails fast on a bad maxTokens under a role', () => {
    assert.throws(
      () => resolveSmartServerConfig({}, mapYaml({ maxTokens: 0 }), {}),
      /llm\.main\.maxTokens/,
    );
  });
});

describe('llm.maxTokens from YAML', () => {
  it('reaches the resolved config', () => {
    assert.equal(llmOf(yamlWith({ maxTokens: 8192 }))?.maxTokens, 8192);
  });

  it('stays undefined when omitted', () => {
    assert.equal(llmOf(yamlWith({}))?.maxTokens, undefined);
  });

  it('fails fast on a value that is not a positive safe integer', () => {
    for (const bad of [0, -1, 1.5, 'many']) {
      assert.throws(
        () => resolveSmartServerConfig({}, yamlWith({ maxTokens: bad }), {}),
        /llm\.maxTokens/,
        `expected a config error for ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe('makeDefaultRoleLlm', () => {
  /** The provider sits behind the bridge the adapter holds; `private` is compile-time only. */
  const configOf = (llm: unknown) =>
    ((llm as { agent?: unknown }).agent as { provider?: { config?: unknown } })
      ?.provider?.config as Record<string, unknown> | undefined;

  it('carries the policy and the token cap all the way to the provider', async () => {
    const llm = await makeDefaultRoleLlm(
      {
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        maxTokens: 8192,
        whenThrottled: { maxAttempts: 3, maxTotalWaitMs: 20_000 },
      },
      0.1,
    );
    const config = configOf(llm);
    assert.deepEqual(config?.whenThrottled, {
      maxAttempts: 3,
      maxTotalWaitMs: 20_000,
    });
    assert.equal(config?.maxTokens, 8192);
  });

  it('leaves the provider on its defaults when neither is set', async () => {
    const llm = await makeDefaultRoleLlm(
      { provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o' },
      0.1,
    );
    assert.equal(configOf(llm)?.whenThrottled, undefined);
  });
});
