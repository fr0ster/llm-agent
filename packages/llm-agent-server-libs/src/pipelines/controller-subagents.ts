import type {
  ControllerConfig,
  ControllerSubagentConfig,
} from '../smart-agent/controller/types.js';
import { INLINE_LLM_CONFIG_FIELDS } from '../smart-agent/llm-config-map.js';

const REQUIRED = ['evaluator', 'planner', 'executor'] as const;
const OPTIONAL = ['reviewer', 'finalizer'] as const;
const ROLES: readonly string[] = [...REQUIRED, ...OPTIONAL];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseOne(
  role: string,
  raw: unknown,
  llmKeys: ReadonlySet<string>,
): ControllerSubagentConfig {
  if (!isPlainObject(raw)) {
    throw new Error(
      `pipeline 'controller': subagents.${role} must be an object — {} or { llm: <key>, hint: <text> }`,
    );
  }
  const inline = Object.keys(raw).filter((k) =>
    INLINE_LLM_CONFIG_FIELDS.includes(k),
  );
  if (inline.length > 0) {
    throw new Error(
      `pipeline 'controller': subagents.${role} holds an inline LLM configuration ` +
        `(${inline.join(', ')}); models are configured once, in the top-level llm: map — ` +
        `add an entry there and name it here with \`llm: <key>\``,
    );
  }
  for (const k of Object.keys(raw)) {
    if (k !== 'llm' && k !== 'hint') {
      throw new Error(
        `pipeline 'controller': subagents.${role}: unknown field '${k}' (allowed: llm, hint)`,
      );
    }
  }
  const out: ControllerSubagentConfig = {};
  if (raw.llm !== undefined) {
    if (typeof raw.llm !== 'string' || raw.llm === '') {
      throw new Error(
        `pipeline 'controller': subagents.${role}.llm must be a non-empty string naming an llm: entry`,
      );
    }
    if (!llmKeys.has(raw.llm)) {
      throw new Error(
        `pipeline 'controller': subagents.${role}.llm names '${raw.llm}', which has no entry ` +
          `in the top-level llm: map (entries: ${[...llmKeys].join(', ')})`,
      );
    }
    out.llm = raw.llm;
  }
  if (raw.hint !== undefined) {
    if (typeof raw.hint !== 'string') {
      throw new Error(
        `pipeline 'controller': subagents.${role}.hint must be a string`,
      );
    }
    out.hint = raw.hint;
  }
  return out;
}

/**
 * Parse `pipeline.config.subagents` for the controller (§4.6.7). Each role is
 * `{}` or `{ llm?: <key>, hint?: <text> }`. evaluator/planner/executor are
 * required; reviewer/finalizer stay absent when their block is absent, which the
 * factory reads as "the planner's instance". Called by the server in `start()`,
 * with the keys of the main file's `llm:` map, so a named key with no entry is a
 * startup error rather than a silent fallback to `main`.
 */
export function parseControllerSubagents(
  raw: unknown,
  llmKeys: ReadonlySet<string>,
): ControllerConfig['subagents'] {
  if (!isPlainObject(raw)) {
    throw new Error(
      "pipeline 'controller' requires 'subagents' with evaluator, planner and executor " +
        '(each {} or { llm: <key>, hint: <text> })',
    );
  }
  for (const k of Object.keys(raw)) {
    if (!ROLES.includes(k)) {
      throw new Error(
        `pipeline 'controller': unknown subagent role '${k}' (roles: ${ROLES.join(', ')})`,
      );
    }
  }
  for (const role of REQUIRED) {
    if (raw[role] === undefined) {
      throw new Error(
        `pipeline 'controller' requires 'subagents.${role}' ({} or { llm: <key>, hint: <text> })`,
      );
    }
  }
  const subagents: ControllerConfig['subagents'] = {
    evaluator: parseOne('evaluator', raw.evaluator, llmKeys),
    planner: parseOne('planner', raw.planner, llmKeys),
    executor: parseOne('executor', raw.executor, llmKeys),
  };
  for (const role of OPTIONAL) {
    if (raw[role] !== undefined) {
      subagents[role] = parseOne(role, raw[role], llmKeys);
    }
  }
  return subagents;
}
