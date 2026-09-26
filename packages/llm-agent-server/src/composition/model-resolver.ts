import type { ILlm, IModelResolver } from '@mcp-abap-adt/llm-agent';
import {
  normalizeLlmConfig,
  type SmartServerConfig,
  type SmartServerLlmConfig,
} from '@mcp-abap-adt/llm-agent-server-libs';

/**
 * `IModelResolver` for `PUT /v1/config`: the role's own `llm:` entry — its
 * provider and its `credentialRef` — with the model swapped, built through the
 * same `makeLlm` seam. The temperatures are this root's choice, read from the
 * entries the way `SmartServer` reads them at startup, not the library's
 * `main ? 0.7 : 0.1` (§8 item 2). `undefined` without an `llm:` section, so a
 * model update keeps being refused with 400.
 */
export function createModelResolver(
  makeLlm: (cfg: SmartServerLlmConfig) => Promise<ILlm>,
  llm: SmartServerConfig['llm'],
): IModelResolver | undefined {
  const map = normalizeLlmConfig(llm);
  if (!map) return undefined;
  return {
    resolve(modelName, role) {
      // The same entries SmartServer builds the held instances from (B12): a
      // declared classifier entry is the classifier's own; otherwise it derives
      // from main at classifierTemperature.
      const own =
        role === 'helper'
          ? map.helper
          : role === 'classifier'
            ? map.classifier
            : undefined;
      const base = own ?? map.main;
      // A declared classifier is built as written at startup (B12), so its
      // temperature passes through unchanged here too — a swap must not move it.
      const temperature =
        role === 'main'
          ? Number(map.main.temperature ?? 0.7)
          : role === 'classifier'
            ? own
              ? own.temperature
              : Number(map.main.classifierTemperature ?? 0.1)
            : Number(base.temperature ?? 0.1);
      return makeLlm({ ...base, model: modelName, temperature });
    },
  };
}
