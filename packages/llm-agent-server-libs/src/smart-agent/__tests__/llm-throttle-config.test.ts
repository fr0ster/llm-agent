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
import { WaitAsTold } from '@mcp-abap-adt/llm-agent';
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
  it('takes a bare strategy name', () => {
    const llm = llmOf(yamlWith({ whenThrottled: 'wait-as-told' }));
    assert.equal(
      (llm?.whenThrottled as { name?: string })?.name,
      'wait-as-told',
    );
  });

  it("refuses a duration, which is not the operator's to guess", () => {
    // How long anyone's users will sit still is not a YAML question, and not
    // the library's either. Waiting is a strategy, and a strategy is code.
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          yamlWith({
            whenThrottled: { strategy: 'wait-as-told', maxTotalWaitMs: 20000 },
          }),
          {},
        ),
      /Unknown llm\.whenThrottled key 'maxTotalWaitMs'/,
    );
  });

  it('refuses a strategy it does not ship', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          yamlWith({ whenThrottled: 'exponential' }),
          {},
        ),
      /expected 'report' or 'wait-as-told'/,
    );
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

  it('carries a strategy through', () => {
    const llm = resolveSmartServerConfig(
      {},
      mapYaml({ whenThrottled: 'wait-as-told' }),
      {},
    ).llm as Record<string, { whenThrottled?: { name?: string } }>;
    assert.equal(llm.main?.whenThrottled?.name, 'wait-as-told');
  });

  it('fails fast on a misspelled key under a role', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          mapYaml({
            whenThrottled: { strategy: 'wait-as-told', maxAttempt: 2 },
          }),
          {},
        ),
      /Unknown llm\.main\.whenThrottled key 'maxAttempt'/,
    );
  });

  it('fails fast on a bad attempt count under a role', () => {
    assert.throws(
      () =>
        resolveSmartServerConfig(
          {},
          mapYaml({
            whenThrottled: { strategy: 'wait-as-told', maxAttempts: 0 },
          }),
          {},
        ),
      /Invalid llm\.main\.whenThrottled\.maxAttempts/,
    );
  });

  it('normalises the values it checks, not just checks them', () => {
    // `${ENV_VAR}` substitution leaves numbers as strings, and the resolved
    // config is typed as though they were numbers. A custom strategy would be
    // handed a string and told it was a number.
    const llm = resolveSmartServerConfig({}, mapYaml({ maxTokens: '8192' }), {})
      .llm as Record<string, { maxTokens?: unknown }>;
    assert.strictEqual(llm.main?.maxTokens, 8192);
  });

  it('leaves the rest of the entry untouched', () => {
    const llm = resolveSmartServerConfig(
      {},
      mapYaml({ whenThrottled: 'wait-as-told' }),
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
        whenThrottled: new WaitAsTold({ maxAttempts: 3 }),
      },
      0.1,
    );
    const config = configOf(llm);
    assert.equal(
      (config?.whenThrottled as { name?: string })?.name,
      'wait-as-told',
    );
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
