/**
 * The selected pipeline's `pipeline.config`, as the start reads it (spec
 * §10.5.9 *The start config*, D83 (11)): the parse half of each built-in
 * registry entry, callable without constructing a plugin, so a file reload
 * validates the section a start from the same file would parse.
 */
import { isDeepStrictEqual } from 'node:util';
import type { ControllerConfig } from './controller/types.js';
import { llmKeySet, type NormalizedLlmMap } from './llm-config-map.js';
import {
  assertNamedLlmKeys,
  type DagPipelineSettings,
  dagNamedLlmKeys,
  parseControllerSettings,
  parseDagSettings,
  parseLinearSettings,
  parseStepperSettings,
} from './pipeline-settings.js';

/** The server's built-in pipelines — the keys of the start's built-in factories and of their section entries. */
export type BuiltinPipelineName =
  | 'flat'
  | 'linear'
  | 'dag'
  | 'stepper'
  | 'controller'
  | 'controller-weak';

/** One section parse: the section, the `llm:` keys a section may name, the start's warning sink. */
export type PipelineSectionParse = (
  section: unknown,
  llm: NormalizedLlmMap | undefined,
  warn: (msg: string) => void,
) => unknown;

/** `parseDagSettings` plus the `llm:` key check the `dag` entry ran inline (moved, unchanged). */
export function parseDagSection(
  section: unknown,
  llm: NormalizedLlmMap | undefined,
  warn: (msg: string) => void,
): DagPipelineSettings {
  const settings = parseDagSettings(section, warn);
  assertNamedLlmKeys(dagNamedLlmKeys(settings), llm, "pipeline 'dag'");
  return settings;
}

/** `parseControllerSettings` over the `llm:` keys (moved from the two controller entries, unchanged). */
export function parseControllerSection(
  section: unknown,
  llm: NormalizedLlmMap | undefined,
): ControllerConfig {
  return parseControllerSettings(section, llmKeySet(llm));
}

/**
 * The parse each built-in entry runs — the start's factory calls it and
 * constructs the plugin with the result; the reload calls it and discards the
 * result. `satisfies` keeps each one's own return type for the factories.
 */
export const BUILTIN_PIPELINE_PARSERS = {
  linear: (section: unknown) => parseLinearSettings(section),
  dag: parseDagSection,
  stepper: (section: unknown) => parseStepperSettings(section),
  controller: parseControllerSection,
  'controller-weak': parseControllerSection,
} satisfies Record<Exclude<BuiltinPipelineName, 'flat'>, PipelineSectionParse>;

/** How a registered pipeline's `pipeline.config` is read at start. */
export type PipelineSectionEntry =
  /** A built-in: its parser, the start's and the reload's. */
  | { readonly kind: 'parser'; readonly parse: PipelineSectionParse }
  /** `flat` and a plugin's instance export: the start reads no section. */
  | { readonly kind: 'no-section' }
  /** A plugin's factory: parser and constructor in one call, called once at start (§4.6.7) — no validation entry. */
  | { readonly kind: 'plugin-factory' };

export const BUILTIN_PIPELINE_SECTIONS: Readonly<
  Record<BuiltinPipelineName, PipelineSectionEntry>
> = {
  flat: { kind: 'no-section' },
  linear: { kind: 'parser', parse: BUILTIN_PIPELINE_PARSERS.linear },
  dag: { kind: 'parser', parse: BUILTIN_PIPELINE_PARSERS.dag },
  stepper: { kind: 'parser', parse: BUILTIN_PIPELINE_PARSERS.stepper },
  controller: { kind: 'parser', parse: BUILTIN_PIPELINE_PARSERS.controller },
  'controller-weak': {
    kind: 'parser',
    parse: BUILTIN_PIPELINE_PARSERS['controller-weak'],
  },
};

/** A pipeline selection: `pipeline.name` (default `flat`) and `pipeline.config` (default `{}`). */
export interface PipelineSelection {
  readonly name: string;
  readonly section: unknown;
}

/** What the server hands the reload watcher (`ConfigReloadDeps.pipeline`). */
export interface ReloadPipeline {
  /** Every registered pipeline's entry — the built-ins' and each plugin's. */
  readonly entries: ReadonlyMap<string, PipelineSectionEntry>;
  /** The selection the running pipeline was constructed from. */
  readonly running: PipelineSelection;
  /** The start's warning sink (`parseDagSettings` warns). */
  readonly warn: (msg: string) => void;
}

/**
 * The reload's check of the selected pipeline (spec D83 (11)): throws one
 * error naming every issue; builds nothing, applies nothing.
 */
export function checkReloadedPipeline(
  pipeline: ReloadPipeline,
  reloaded: PipelineSelection,
  llm: NormalizedLlmMap | undefined,
): void {
  const issues: string[] = [];
  const changed = reloaded.name !== pipeline.running.name;
  if (changed) {
    // The reload does not rebuild the pipeline: a file whose agent is not
    // the one serving is never reported applied.
    issues.push(
      `pipeline change needs a restart — the server runs pipeline '${pipeline.running.name}', the file selects '${reloaded.name}'`,
    );
  }
  const entry = pipeline.entries.get(reloaded.name);
  if (entry === undefined) {
    issues.push(
      `unknown pipeline '${reloaded.name}'; available: ${[...pipeline.entries.keys()].join(', ')}`,
    );
  } else {
    switch (entry.kind) {
      case 'parser':
        try {
          entry.parse(reloaded.section, llm, pipeline.warn);
        } catch (err) {
          issues.push(
            `pipeline '${reloaded.name}' config invalid — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        break;
      case 'no-section':
        break;
      case 'plugin-factory':
        // Strict: never report applied a section no code checked. An
        // unchanged section is the one the factory accepted at start.
        if (
          !changed &&
          !isDeepStrictEqual(reloaded.section, pipeline.running.section)
        ) {
          issues.push(
            `pipeline '${reloaded.name}' is a plugin factory with no validation entry — its changed pipeline.config is checked only by building the pipeline: restart to apply it`,
          );
        }
        break;
      default: {
        const exhaustive: never = entry;
        throw new Error(
          `unknown pipeline section entry: ${String(exhaustive)}`,
        );
      }
    }
  }
  if (issues.length > 0) throw new Error(issues.join('; '));
}
