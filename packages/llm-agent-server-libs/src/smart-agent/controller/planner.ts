import { parseNextStep } from './controller-coordinator-handler.js';
import type { ISubagentClient } from './subagent-client.js';
import type {
  IControllerPlanner,
  NextStep,
  PlannerNextInput,
} from './types.js';

const PLANNER_SYSTEM =
  'You are the planner. Given the goal and progress, return a SINGLE JSON ' +
  'object: {"kind":"next","step":{"name":...,"instructions":...}} to take the ' +
  'next step, {"kind":"done","result":...} when the goal is met, or ' +
  '{"kind":"rewind","reason":...} to discard the current path. Output JSON only.\n' +
  'An executor carries out each step against the LIVE SAP system using the ' +
  'tools listed below. Any fact about the system MUST be obtained by planning a ' +
  'step that fetches it with a tool — do NOT answer from prior knowledge, and do ' +
  'NOT mark the goal "done" until the required data has actually been fetched ' +
  '(fetched results appear under Progress). Until then, return a concrete ' +
  '"next" fetch step.';

const RETRY_HINT =
  '\nIMPORTANT: your previous reply was NOT valid JSON. Reply with ONLY the raw ' +
  'JSON object — no prose, no explanation, no markdown code fences.';

export class IncrementalPlanner implements IControllerPlanner {
  constructor(private readonly planner: ISubagentClient) {}

  async next(input: PlannerNextInput): Promise<NextStep | null> {
    const { bundle, prompt, toolCatalog, retrying, logUsage } = input;
    const res = await this.planner.send([
      {
        role: 'system',
        content: PLANNER_SYSTEM + (retrying ? RETRY_HINT : ''),
      },
      {
        role: 'user',
        content:
          `Goal: ${bundle.goal}\nProgress:${bundle.plannerPrivate}\nRequest: ${prompt}\n` +
          `Available tools (the executor picks the exact one):\n${toolCatalog}`,
      },
    ]);
    logUsage?.('planner', res.usage);
    if (res.kind !== 'content') return null;
    return parseNextStep(res.content);
  }
}
