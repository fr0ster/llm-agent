/**
 * A whole config document for a reload test (spec §10.5.9 V6, D83 (10)): the
 * reload validates the whole resolved file with the start's validator, so a
 * test reload carries a document a server could start from — a minimal `llm:`
 * section plus the given hot-reloadable values at the paths `ConfigWatcher`
 * reads them (`agent.*`, the in-memory store's weights, `prompts`,
 * `circuitBreaker`, `logDir`).
 */
import type { EventEmitter } from 'node:events';
import { stringify } from 'yaml';
import { startConfigInput } from '../config-fields.js';
import {
  BUILTIN_PIPELINE_SECTIONS,
  type PipelineSectionEntry,
  type ReloadPipeline,
} from '../pipeline-sections.js';
import type { YamlConfig } from '../yaml-loader.js';

/** The `llm:` section every test document starts with — valid at start (no provider runtime is reached). */
export const LLM_SECTION = 'llm:\n  provider: ollama\n  model: m\n';

/** Hot-reloadable values by their `HotReloadableConfig` key, valid or not (a test may pass an invalid one). */
export type ReloadValues = Readonly<Record<string, unknown>>;

/** The document holding `values` at the watcher's paths, with `LLM_SECTION`'s `llm:`. */
export function reloadDocument(values: ReloadValues = {}): YamlConfig {
  const {
    vectorWeight,
    keywordWeight,
    prompts,
    circuitBreaker,
    logDir,
    ...agent
  } = values;
  const weights = {
    ...(vectorWeight !== undefined ? { vectorWeight } : {}),
    ...(keywordWeight !== undefined ? { keywordWeight } : {}),
  };
  return {
    llm: { provider: 'ollama', model: 'm' },
    ...(Object.keys(agent).length > 0 ? { agent } : {}),
    ...(Object.keys(weights).length > 0
      ? { rag: { store: { type: 'in-memory', ...weights } } }
      : {}),
    ...(prompts !== undefined ? { prompts } : {}),
    ...(circuitBreaker !== undefined ? { circuitBreaker } : {}),
    ...(logDir !== undefined ? { logDir } : {}),
  };
}

/** `reloadDocument(values)` as the YAML text a test saves. */
export function reloadYaml(values: ReloadValues = {}): string {
  return stringify(reloadDocument(values));
}

/**
 * Emits on a `ConfigWatcher`'s emitter what the real watcher emits for
 * `reloadDocument(values)`: the extracted values (`startConfigInput` — pinned
 * equal to the watcher's extraction) and the document.
 */
export function emitReload(
  watcher: EventEmitter,
  values: ReloadValues = {},
): void {
  const document = reloadDocument(values);
  watcher.emit('reload', startConfigInput(document), document);
}

/**
 * The `ConfigReloadDeps.pipeline` of a server running pipeline `name` with
 * `section` (spec D83 (11)): the built-in section entries plus `plugins`
 * (a plugin's `no-section` / `plugin-factory` entry), warnings dropped.
 */
export function runningPipeline(
  name: string,
  section: unknown = {},
  plugins: Iterable<readonly [string, PipelineSectionEntry]> = [],
): ReloadPipeline {
  return {
    entries: new Map<string, PipelineSectionEntry>([
      ...Object.entries(BUILTIN_PIPELINE_SECTIONS),
      ...plugins,
    ]),
    running: { name, section },
    warn: () => {},
  };
}

/** A server running `flat` — what every `reloadDocument` selects (no `pipeline:`). */
export const FLAT_PIPELINE: ReloadPipeline = runningPipeline('flat');
