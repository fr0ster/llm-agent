import type {
  BaseAgentLlmBridge,
  DefaultWaitStrategy,
  IPlanAuthor,
  PlanAuthorError,
} from '@mcp-abap-adt/llm-agent';

export interface ConsumerPlanError extends PlanAuthorError {
  requestId: string;
}

type PlanErrorCode = 'invalid' | 'unavailable' | 'aborted';

export async function planErrorCode(
  author: IPlanAuthor,
): Promise<PlanErrorCode | undefined> {
  const result = await author.create({ goal: 'Create a plan' });
  if (!result.ok) return result.error.code;
}

export const author: IPlanAuthor = {
  async create() {
    return { ok: false, error: { code: 'invalid', message: 'Invalid plan' } };
  },
  async revise() {
    return { ok: false, error: { code: 'aborted', message: 'Cancelled' } };
  },
};

export const wait: DefaultWaitStrategy = {
  name: 'default-wait',
  async wait() {
    return 'elapsed';
  },
};

export const bridge: BaseAgentLlmBridge = {
  async callWithTools() {
    return { content: 'Done' };
  },
  async *streamWithTools() {
    yield { content: 'Done' };
  },
};
