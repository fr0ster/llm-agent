import type { SmartServerLlmConfig } from './smart-server.js';

export type LlmConfigMap = Record<string, SmartServerLlmConfig>;
export type NormalizedLlmMap = { main: SmartServerLlmConfig } & LlmConfigMap;

/**
 * Detect whether an object is a flat SmartServerLlmConfig shape.
 * Flat shape is identified by the presence of ANY of the known flat-shape
 * fields: `provider`, `credentialRef`, `model`, or `url`. This covers keyless
 * providers (Ollama, SAP AI Core) that omit `credentialRef` — using
 * `credentialRef`-only detection silently misclassified those configs as a
 * "map" shape.
 */
function isFlatLlmConfig(input: SmartServerLlmConfig | LlmConfigMap): boolean {
  const flat = input as Partial<SmartServerLlmConfig>;
  return (
    typeof flat.provider === 'string' ||
    typeof flat.credentialRef === 'string' ||
    typeof flat.model === 'string' ||
    typeof flat.url === 'string'
  );
}

/**
 * A numeric LLM knob (`temperature`, `classifierTemperature`) as configured, or
 * `undefined` when unset — never a default. Unset knobs are not sent, so the
 * model applies its own; a forced value breaks models that accept only theirs.
 */
export function optionalNumber(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : Number(value);
}

/**
 * Normalize the optional top-level `llm:` block.
 * - undefined → undefined (pipeline-only configs stay valid)
 * - flat shape (has `provider` | `credentialRef` | `model` | `url`) → { main: flat } (backward compat)
 * - map shape → must include `main`; returned as NormalizedLlmMap
 */
export function normalizeLlmConfig(
  input?: SmartServerLlmConfig | LlmConfigMap,
): NormalizedLlmMap | undefined {
  if (input === undefined) return undefined;
  if (isFlatLlmConfig(input)) {
    return { main: input as SmartServerLlmConfig } as NormalizedLlmMap;
  }
  const map = input as LlmConfigMap;
  if (!map.main) {
    throw new Error(
      "llm: map must include a 'main' key (default LLM for unspecified roles)",
    );
  }
  return map as NormalizedLlmMap;
}

/**
 * Strict lookup: returns map[name] if explicitly present, else undefined.
 * Does NOT fall through to map.main. Use when the caller needs to
 * detect explicit-presence (e.g. to decide between an alias and the
 * named map entry).
 */
export function resolveLlmConfigStrict(
  map: NormalizedLlmMap | undefined,
  name: string | undefined,
): SmartServerLlmConfig | undefined {
  if (!map || !name) return undefined;
  return map[name];
}

/**
 * Resolve a per-role LLM config by name from a normalized map.
 * Lookup chain: map[name] → map.main → pipelineFallback.
 * When map is undefined, falls back to pipelineFallback (so pipeline-only
 * configs keep working with no top-level llm: block).
 *
 * The caller decides whether `undefined` is an error.
 */
export function resolveLlmConfig(
  map: NormalizedLlmMap | undefined,
  name?: string,
  pipelineFallback?: SmartServerLlmConfig,
): SmartServerLlmConfig | undefined {
  if (!map) return pipelineFallback;
  if (!name || name === 'main') return map.main;
  return map[name] ?? map.main;
}

/**
 * Read the reviewer block's LLM-name selector, accepting both the
 * preferred `reviewerLlm` field and the deprecated `plannerLlm` alias.
 * When the alias is used, calls `warn(message)`.
 */
export function resolveReviewerLlmName(
  block: { reviewerLlm?: string; plannerLlm?: string } | undefined,
  warn: (msg: string) => void,
): string | undefined {
  if (!block) return undefined;
  if (typeof block.reviewerLlm === 'string') return block.reviewerLlm;
  if (typeof block.plannerLlm === 'string') {
    warn(
      "coordinator.reviewer.plannerLlm is deprecated; rename to 'reviewerLlm'",
    );
    return block.plannerLlm;
  }
  return undefined;
}

/**
 * Fields that belong to an LLM configuration and therefore to an `llm:` entry
 * only. A pipeline section or a worker file that carries one of them is holding
 * an inline model, which §4.6.7 refuses: the file configures each model once.
 */
export const INLINE_LLM_CONFIG_FIELDS: readonly string[] = [
  'provider',
  'model',
  'url',
  'apiKey',
  'credentialRef',
  'temperature',
  'classifierTemperature',
  'maxTokens',
  'whenThrottled',
  'resourceGroup',
];

/** The keys a file may name: a flat `llm:` block normalizes to `{ main }`. */
export function llmKeySet(
  map: NormalizedLlmMap | undefined,
): ReadonlySet<string> {
  return new Set(map ? Object.keys(map) : []);
}
