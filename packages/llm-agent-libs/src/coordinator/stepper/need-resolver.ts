import {
  ClassifierError,
  type ILlm,
  type INeedResolver,
} from '@mcp-abap-adt/llm-agent';
import { coordinatorError } from '../coordinator-error.js';

const NEED_RE =
  /\bI (?:can'?t|cannot|am unable to|need to|lack (?:a|the) (?:tool|way) to)\s+(.+?)[.!]?$/i;

/** Deterministic need detector. Pattern-matches "I can't <X>" / "I need to
 *  <X>" and maps the captured phrase to a tools-RAG query. Default. */
export class RegexNeedResolver implements INeedResolver {
  async resolve(response: string) {
    const line = response.trim().split('\n').pop() ?? response.trim();
    const m = NEED_RE.exec(line);
    if (!m) return undefined;
    return { queryToolsRag: m[1].trim() };
  }
}

export const CLASSIFY_SYSTEM =
  'You decide whether an assistant answer is INCOMPLETE because it is missing ' +
  'data or a capability — so the agent should obtain it and try again. Two cases ' +
  'count as a need:\n' +
  '1. It explicitly cannot proceed (it says it lacks a tool, access, or data).\n' +
  '2. It DID produce an answer but TRANSPARENTLY caveats that the answer is based ' +
  'on PARTIAL/INCOMPLETE input — e.g. a part/sub-part was missing, returned ' +
  '"not found", was inaccessible or could not be read, or the result is "based ' +
  'on X only". A self-flagged incompleteness IS a need, even when the assistant ' +
  'still gave an answer.\n' +
  'Respond with ONLY JSON: {"need":boolean,"capability":string}. capability = a ' +
  'short description of the missing data/capability to obtain (e.g. "read the ' +
  'include bodies of the program"), or "" when the answer is genuinely complete.';

/** LLM-driven need classifier. Opt-in (more accurate on paraphrase, costs a
 *  small classifier call). A classifier that fails — the LLM call answers
 *  `ok: false` or rejects, or the answer is not the JSON verdict — fails the
 *  step (`COORDINATOR_STEP_FAILED`, spec §10.5.7 C6): a failed classification
 *  is never read as "no need". */
export class LlmNeedResolver implements INeedResolver {
  constructor(private readonly llm: ILlm) {}
  async resolve(response: string) {
    let res: Awaited<ReturnType<ILlm['chat']>>;
    try {
      res = await this.llm.chat(
        [
          { role: 'system', content: CLASSIFY_SYSTEM },
          { role: 'user', content: response },
        ],
        [],
      );
    } catch (err) {
      throw coordinatorError(
        'need resolver: classifier LLM failed',
        err,
        'COORDINATOR_STEP_FAILED',
      );
    }
    if (res.ok === false)
      throw coordinatorError(
        'need resolver: classifier LLM failed',
        res.error,
        'COORDINATOR_STEP_FAILED',
      );
    const parsed = parseClassification(res.value.content);
    if (!parsed)
      throw coordinatorError(
        'need resolver',
        new ClassifierError(
          `classifier answered no JSON verdict with a boolean need: ${res.value.content.slice(0, 200)}`,
        ),
        'COORDINATOR_STEP_FAILED',
      );
    if (
      parsed.need &&
      typeof parsed.capability === 'string' &&
      parsed.capability
    )
      return { queryToolsRag: parsed.capability };
    return undefined;
  }
}

/** Parse the classifier's verdict. Tolerates ```json fences and surrounding
 *  prose (first `{` to last `}`, as `parseTaskSpec` does); a verdict without a
 *  boolean `need` is malformed. */
function parseClassification(
  content: string,
): { need: boolean; capability?: unknown } | undefined {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return undefined;
  const verdict = parsed as { need?: unknown; capability?: unknown };
  return typeof verdict.need === 'boolean'
    ? { need: verdict.need, capability: verdict.capability }
    : undefined;
}
