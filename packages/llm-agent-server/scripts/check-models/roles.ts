/**
 * The LLM configs a server config makes, per role — exactly what SmartServer
 * hands `makeLlm`, so a check sends the same temperature / maxTokens the
 * server would. Built on the composition root's `createModelResolver`, the
 * component that already mirrors SmartServer's per-role rules.
 */
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import {
  normalizeLlmConfig,
  type SmartServerConfig,
  type SmartServerLlmConfig,
} from '@mcp-abap-adt/llm-agent-server-libs';
import { createModelResolver } from '../../src/composition/model-resolver.js';

export interface IRoleLlmConfig {
  role: string;
  cfg: SmartServerLlmConfig;
}

const BUILT_IN = ['main', 'classifier', 'helper'] as const;

export async function roleLlmConfigs(
  llm: SmartServerConfig['llm'],
): Promise<IRoleLlmConfig[]> {
  const map = normalizeLlmConfig(llm);
  if (!map) return [];
  let captured: SmartServerLlmConfig | undefined;
  const resolver = createModelResolver(async (cfg) => {
    captured = cfg;
    return {} as ILlm;
  }, llm);
  const out: IRoleLlmConfig[] = [];
  for (const role of BUILT_IN) {
    // SmartServer always builds main and classifier (the latter derived from
    // main unless declared); a helper only when declared.
    if (role === 'helper' && !map.helper) continue;
    const model = (map[role] ?? map.main).model;
    if (!model || !resolver) continue;
    await resolver.resolve(model, role);
    if (captured) out.push({ role, cfg: captured });
  }
  for (const [role, cfg] of Object.entries(map)) {
    if ((BUILT_IN as readonly string[]).includes(role) || !cfg?.model) continue;
    out.push({ role, cfg });
  }
  return out;
}
