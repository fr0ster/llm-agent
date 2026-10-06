import { ConfigFieldError } from './config-fields.js';
import {
  INLINE_LLM_CONFIG_FIELDS,
  type NormalizedLlmMap,
} from './llm-config-map.js';
import type { SmartServerWorkerLlmKeys } from './smart-server.js';

const WORKER_ROLES = ['main', 'helper', 'classifier'] as const;

function inlineError(worker: string): Error {
  return new Error(
    `subagent '${worker}': its llm: holds an inline LLM configuration; a worker names keys ` +
      "of the main file's llm: map instead — `llm: <key>` or " +
      '`llm: { main: <key>, helper: <key>, classifier: <key> }`',
  );
}

/**
 * Read a worker file's `llm` (§4.6.7). A string is `{ main: <key> }`, a map
 * assigns keys to the worker's three roles, and absence names nothing. It is
 * a boundary for input no compiler saw — YAML, or a programmatic
 * `subAgentConfigs` built by a cast — so it checks rather than casts.
 */
export function parseWorkerLlm(
  worker: string,
  raw: unknown,
): SmartServerWorkerLlmKeys {
  if (raw === undefined) return {};
  // Spec D83 (13): a key written with no value is an error, never "no llm".
  if (raw === null) {
    throw new ConfigFieldError([`subagent '${worker}': llm has no value`]);
  }
  if (typeof raw === 'string') {
    if (raw === '') {
      throw new Error(`subagent '${worker}': llm must be a non-empty key`);
    }
    return { main: raw };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw inlineError(worker);
  }
  const src = raw as Record<string, unknown>;
  const out: SmartServerWorkerLlmKeys = {};
  for (const [k, v] of Object.entries(src)) {
    if (INLINE_LLM_CONFIG_FIELDS.includes(k)) throw inlineError(worker);
    if (!(WORKER_ROLES as readonly string[]).includes(k)) {
      throw new Error(
        `subagent '${worker}': llm has unknown role '${k}' (roles: ${WORKER_ROLES.join(', ')})`,
      );
    }
    if (v === null) {
      throw new ConfigFieldError([
        `subagent '${worker}': llm.${k} has no value`,
      ]);
    }
    if (typeof v === 'object') throw inlineError(worker);
    if (typeof v !== 'string' || v === '') {
      throw new Error(`subagent '${worker}': llm.${k} must be a non-empty key`);
    }
    out[k as (typeof WORKER_ROLES)[number]] = v;
  }
  return out;
}

/** Every key a worker NAMES must be an entry of the main file's map — a
 *  misspelled key is a startup error, never `main` (§4.6.7). */
export function assertWorkerLlmConfig(
  subs: readonly { name: string; config: { llm?: unknown } }[] | undefined,
  llmMap: NormalizedLlmMap | undefined,
): void {
  for (const sub of subs ?? []) {
    const keys = parseWorkerLlm(sub.name, sub.config.llm);
    for (const role of WORKER_ROLES) {
      const key = keys[role];
      if (key === undefined) continue;
      if (!llmMap || !Object.hasOwn(llmMap, key)) {
        throw new Error(
          `subagent '${sub.name}': llm.${role} names '${key}', which has no entry in the ` +
            `main file's llm: map (entries: ${Object.keys(llmMap ?? {}).join(', ')})`,
        );
      }
    }
  }
}
