import type { IDecisionModel, IReranker } from '@mcp-abap-adt/llm-agent';
import {
  DecisionReranker,
  wrapDecisionModel,
} from '@mcp-abap-adt/llm-agent-libs';
import type {
  SmartServerDecisionConfig,
  SmartServerRerankerConfig,
} from './decision-config.js';

export interface ResolveRerankerInput {
  rerankerCfg?: SmartServerRerankerConfig;
  decisionCfg?: SmartServerDecisionConfig;
  makeDecisionModel?: (
    cfg: SmartServerDecisionConfig,
  ) => Promise<IDecisionModel>;
  pluginReranker?: IReranker;
}

/**
 * The one reranker every agent of this server uses (§7.3). Configuration that
 * says something is never silently ignored: a YAML reranker next to a plugin
 * reranker is an error, as is a decision reranker without the seam to build it.
 */
export async function resolveReranker(
  input: ResolveRerankerInput,
): Promise<IReranker | undefined> {
  const { rerankerCfg, decisionCfg, makeDecisionModel, pluginReranker } = input;
  if (rerankerCfg && pluginReranker) {
    throw new Error(
      `reranker: ${rerankerCfg.type} is configured and a plugin reranker is loaded — choose one`,
    );
  }
  if (rerankerCfg?.type === 'decision') {
    if (!decisionCfg) {
      throw new Error('reranker.type: decision requires a decision: section');
    }
    if (!makeDecisionModel) {
      throw new Error(
        'BuildAgentDeps.makeDecisionModel is required: the config asks for a decision model, and the library constructs none from configuration. Supply it from your composition root.',
      );
    }
    return new DecisionReranker(
      wrapDecisionModel(await makeDecisionModel(decisionCfg)),
    );
  }
  return pluginReranker;
}
