import type {
  IFinalizer,
  ILlm,
  ISubAgentContextBuilder,
  IToolSelectionStrategy,
} from '@mcp-abap-adt/llm-agent';
import {
  AutoActivation,
  ExplicitActivation,
  HybridDispatch,
  LlmFinalizer,
  OneShotPlanning,
  PassthroughFinalizer,
  ReplanOnErrorPlanning,
  ScoreThresholdToolSelection,
  SelfDispatch,
  SkillStepsPlanning,
  SubAgentDispatch,
  TemplateFinalizer,
  TopKToolSelection,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  type NormalizedLlmMap,
  resolveLlmConfig,
} from '../smart-agent/llm-config-map.js';
import type { SmartServerLlmConfig } from '../smart-agent/smart-server.js';

export interface YamlCoordinator {
  planning?: 'one-shot' | 'replan-on-error' | 'skill-steps';
  dispatch?: 'subagent' | 'self' | 'hybrid';
  activation?: 'auto' | 'explicit';
  plannerLlm?: 'main' | 'planner' | 'helper';
  maxSteps?: number;
  maxRetriesPerStep?: number;
  failPolicy?: 'abort' | 'continue';
  maxLayer?: number;
  planner?:
    | { type?: string; plannerLlm?: 'main' | 'planner' | 'helper' }
    | Record<string, unknown>;
  interpreter?: { type?: string } | Record<string, unknown>;
  reviewer?: {
    type?: string;
    reviewerLlm?: string;
    plannerLlm?: 'main' | 'planner' | 'helper';
  };
  finalizer?: {
    type?: 'passthrough' | 'llm' | 'template';
    finalizerLlm?: string;
    systemPrompt?: string;
  };
  errorStrategy?: { type?: string; maxReplans?: number };
  stateOracle?: string;
  maxRoundTrips?: number;
}

export function resolveCoordinatorPlanning(name: string, plannerLlm: ILlm) {
  switch (name) {
    case 'one-shot':
      return new OneShotPlanning(plannerLlm);
    case 'replan-on-error':
      return new ReplanOnErrorPlanning(plannerLlm);
    case 'skill-steps':
      // SkillStepsPlanning reads `ctx.activeSkillMeta` (populated by
      // CoordinatorHandler from `ctx.selectedSkills`). No planner LLM
      // needed — the plan comes directly from the skill's `steps:` block.
      return new SkillStepsPlanning();
    default:
      throw new Error(
        `Unknown coordinator.planning strategy: '${name}'. Allowed: one-shot, replan-on-error, skill-steps.`,
      );
  }
}

/**
 * Default coordinator dispatch kind. Omitted → 'hybrid' for ALL planning kinds:
 * agentless steps — the synthesized answer-directly step (#155) and skill steps
 * without an explicit `agent:` — need a self-LLM fallback. Pin 'subagent'
 * explicitly for strict subagent-only routing.
 */
export function resolveCoordinatorDispatchKind(
  explicit?: 'subagent' | 'self' | 'hybrid',
): 'subagent' | 'self' | 'hybrid' {
  return explicit ?? 'hybrid';
}

export function resolveCoordinatorDispatch(
  name: string,
  fallbackLlm?: ILlm,
  contextBuilder?: ISubAgentContextBuilder,
) {
  switch (name) {
    case 'subagent':
      return new SubAgentDispatch(contextBuilder);
    case 'self':
      if (!fallbackLlm) {
        throw new Error(
          'coordinator.dispatch=self requires a planner or main LLM',
        );
      }
      return new SelfDispatch(fallbackLlm);
    case 'hybrid':
      if (!fallbackLlm) {
        throw new Error(
          'coordinator.dispatch=hybrid requires a planner or main LLM',
        );
      }
      return new HybridDispatch(
        new SubAgentDispatch(contextBuilder),
        new SelfDispatch(fallbackLlm),
      );
    default:
      throw new Error(
        `Unknown coordinator.dispatch strategy: '${name}'. Allowed: subagent, self, hybrid.`,
      );
  }
}

export function resolveCoordinatorActivation(name: string) {
  switch (name) {
    case 'auto':
      return new AutoActivation();
    case 'explicit':
      return new ExplicitActivation();
    default:
      throw new Error(
        `Unknown coordinator.activation strategy: '${name}'. Allowed: auto, explicit.`,
      );
  }
}

export function resolveToolSelectionStrategy(
  name: string,
  params?: { minScore?: number },
): IToolSelectionStrategy {
  switch (name) {
    case 'top-k':
      return new TopKToolSelection();
    case 'threshold': {
      const minScore = params?.minScore;
      if (typeof minScore !== 'number') {
        throw new Error(
          "agent.toolSelection.strategy 'threshold' requires a numeric 'minScore'",
        );
      }
      return new ScoreThresholdToolSelection(minScore);
    }
    default:
      throw new Error(
        `Unknown agent.toolSelection.strategy '${name}'. Allowed: top-k, threshold.`,
      );
  }
}

export type FinalizerYaml = {
  type?: 'passthrough' | 'llm' | 'template';
  finalizerLlm?: string;
  systemPrompt?: string;
};

/**
 * Build the IFinalizer impl from `coordinator.finalizer:` YAML.
 *
 * Lookup chain for `type: llm`:
 *   resolveLlmConfig(llmMap, cfg.finalizerLlm, pipelineFallback)
 *   → top-level llm.<name> → llm.main → pipelineFallback (pipeline.llm.main)
 *   → ConfigError if all three are missing.
 *
 * Absent block / `type: passthrough` → PassthroughFinalizer.
 * `type: template` → TemplateFinalizer.
 */
export async function buildFinalizer(
  cfg: FinalizerYaml | undefined,
  llmMap: NormalizedLlmMap | undefined,
  pipelineFallback: SmartServerLlmConfig | undefined,
  makeLlm: (config: SmartServerLlmConfig) => Promise<ILlm>,
): Promise<IFinalizer> {
  const kind = cfg?.type ?? 'passthrough';
  if (kind === 'passthrough') return new PassthroughFinalizer();
  if (kind === 'template') return new TemplateFinalizer();
  // kind === 'llm'
  const resolved = resolveLlmConfig(
    llmMap,
    cfg?.finalizerLlm,
    pipelineFallback,
  );
  if (!resolved) {
    throw new Error(
      'coordinator.finalizer (type: llm) requires an LLM config: provide top-level llm.<name>, llm.main, or pipeline.llm.main',
    );
  }
  const llm = await makeLlm(resolved);
  return new LlmFinalizer(llm, {
    systemPrompt: cfg?.systemPrompt,
  });
}
