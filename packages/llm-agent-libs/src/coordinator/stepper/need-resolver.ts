import type { ILlm, INeedResolver } from '@mcp-abap-adt/llm-agent';

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
 *  small classifier call). */
export class LlmNeedResolver implements INeedResolver {
  constructor(private readonly llm: ILlm) {}
  async resolve(response: string) {
    const res = await this.llm.chat(
      [
        { role: 'system', content: CLASSIFY_SYSTEM },
        { role: 'user', content: response },
      ],
      [],
    );
    if (res.ok === false) return undefined;
    try {
      const parsed = JSON.parse(res.value.content) as {
        need?: boolean;
        capability?: string;
      };
      if (parsed.need && parsed.capability)
        return { queryToolsRag: parsed.capability };
    } catch {
      // ignore malformed classifier output → treat as no need
    }
    return undefined;
  }
}
