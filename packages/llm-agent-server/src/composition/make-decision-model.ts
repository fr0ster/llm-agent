import type { IProbabilityDecision } from '@mcp-abap-adt/llm-agent';
import type { SmartServerDecisionConfig } from '@mcp-abap-adt/llm-agent-server-libs';
import {
  type TypeSafeDecisionConfig,
  TypeSafeDecisionModel,
} from '@mcp-abap-adt/typesafe-decision';
import { DEFAULT_DECISION_REF } from './credential-for.js';
import type { Lookup } from './lookup.js';

/** Injectable so a test records what each constructor receives. */
export interface DecisionProviderCtors {
  typesafe: new (cfg: TypeSafeDecisionConfig) => IProbabilityDecision;
}

export const SHIPPED_DECISION_PROVIDERS: DecisionProviderCtors = {
  typesafe: TypeSafeDecisionModel,
};

/**
 * `BuildAgentDeps.makeDecisionModel`. The provider config is built from NAMED
 * fields — nothing spreads `cfg` — so `credentialRef` cannot ride along, and an
 * optional field absent from the section stays absent (unset is not sent).
 */
export function createMakeDecisionModel(
  lookup: Lookup,
  ctors: DecisionProviderCtors = SHIPPED_DECISION_PROVIDERS,
): (cfg: SmartServerDecisionConfig) => Promise<IProbabilityDecision> {
  return async (cfg) => {
    switch (cfg.provider) {
      case 'typesafe': {
        const credential = lookup(
          cfg.credentialRef,
          DEFAULT_DECISION_REF,
          'decision typesafe',
        ).require('api-key');
        return new ctors.typesafe({
          credential,
          ...(cfg.model !== undefined ? { model: cfg.model } : {}),
          ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
          ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
          ...(cfg.maxRetries !== undefined
            ? { maxRetries: cfg.maxRetries }
            : {}),
        });
      }
      default:
        throw new Error(
          `unknown decision provider '${String((cfg as { provider?: unknown }).provider)}'`,
        );
    }
  };
}
