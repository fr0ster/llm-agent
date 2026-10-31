import type {
  CallOptions,
  DialoguePlan,
  IAgentProfileRunner,
  IAgentProfileSource,
  IPlanAuthor,
  PlanAuthorError,
  PlanBrief,
  PlanRevisionInput,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import {
  PLAN_CREATE_SYSTEM,
  PLAN_REVISE_SYSTEM,
} from './plan-author-prompt.js';
import { ProfileResolver, ProfileSourceError } from './profile-resolver.js';
import {
  mergePlan,
  planView,
  resultKind,
  stepSchema,
} from './structured-plan.js';

const outputSchema = z
  .object({
    steps: z.array(stepSchema),
    question: z.string().optional(),
    status: z.enum(['active', 'waiting_user', 'done']).default('active'),
  })
  .strict();

// Extract one complete JSON value without treating braces inside strings as boundaries.
function parseAuthorOutput(content: string): unknown {
  let start = -1;
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;
  const values: unknown[] = [];
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (start < 0) {
      if (char !== '{' && char !== '[') continue;
      start = index;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      const opening = stack.pop();
      if (opening !== (char === '}' ? '{' : '['))
        throw new Error('Malformed author JSON');
      if (stack.length === 0) {
        values.push(JSON.parse(content.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  if (start >= 0 || values.length !== 1)
    throw new Error('Expected exactly one complete JSON object');
  return values[0];
}

export class ProfilePlanAuthor implements IPlanAuthor {
  constructor(
    private readonly opts: {
      source: IAgentProfileSource;
      runner: IAgentProfileRunner;
      notes?: (options?: CallOptions) => Promise<string[]>;
    },
  ) {}

  create(
    brief: PlanBrief,
    options?: CallOptions,
  ): Promise<Result<DialoguePlan, PlanAuthorError>> {
    return this.author('create', JSON.stringify(brief), undefined, options);
  }

  revise(
    input: PlanRevisionInput,
    options?: CallOptions,
  ): Promise<Result<DialoguePlan, PlanAuthorError>> {
    return this.author(
      'revise',
      [
        JSON.stringify({ brief: input.brief, change: input.change }),
        planView(input.plan),
        JSON.stringify(input.plan),
      ].join('\n\n'),
      input.plan,
      options,
    );
  }

  private async author(
    mode: 'create' | 'revise',
    message: string,
    current: DialoguePlan | undefined,
    options?: CallOptions,
  ): Promise<Result<DialoguePlan, PlanAuthorError>> {
    let code: PlanAuthorError['code'] = 'unavailable';
    try {
      options?.signal?.throwIfAborted();
      const runner = this.opts.runner;
      const preparePlanAuthor = runner.preparePlanAuthor;
      if (!preparePlanAuthor)
        return {
          ok: false,
          error: {
            code: 'unavailable',
            message: 'profile runner cannot prepare a plan author',
          },
        };
      const resolver = new ProfileResolver(this.opts.source);
      const prompts = await resolver.call(
        (opts) => this.opts.source.getPrompts(opts),
        options,
      );
      const systemPrompt =
        mode === 'create'
          ? (prompts.plannerCreate ?? PLAN_CREATE_SYSTEM)
          : (prompts.plannerRevise ?? PLAN_REVISE_SYSTEM);
      const agent = await resolver.call(
        (opts) => preparePlanAuthor.call(runner, { mode, systemPrompt }, opts),
        options,
      );
      const notes = (await this.opts.notes?.(options)) ?? [];
      options?.signal?.throwIfAborted();
      const response = await agent.process(
        [message, ...notes].join('\n\n'),
        options,
      );
      options?.signal?.throwIfAborted();
      if (!response.ok)
        return {
          ok: false,
          error: { code: 'unavailable', message: response.error.message },
        };
      code = 'invalid';
      const next = outputSchema.parse(
        parseAuthorOutput(response.value.content),
      );
      // Completed work is immutable for author revisions, even if omitted or reopened.
      const steps = next.steps.map((step) => {
        const done = current?.steps.find(
          (old) => old.id === step.id && old.state === 'done',
        );
        return done ?? step;
      });
      for (const done of current?.steps.filter(
        (step) => step.state === 'done',
      ) ?? []) {
        if (steps.some((step) => step.id === done.id)) continue;
        const oldIndex = current?.steps.indexOf(done) ?? 0;
        const following = current?.steps
          .slice(oldIndex + 1)
          .find((old) => steps.some((step) => step.id === old.id));
        const preceding = current?.steps
          .slice(0, oldIndex)
          .reverse()
          .find((old) => steps.some((step) => step.id === old.id));
        const index = following
          ? steps.findIndex((step) => step.id === following.id)
          : preceding
            ? steps.findIndex((step) => step.id === preceding.id) + 1
            : 0;
        steps.splice(index, 0, done);
      }
      const resolved = new Map<string, 'report' | 'verdict'>();
      for (const step of steps) {
        if (step.state === 'done' || !step.worker || resolved.has(step.worker))
          continue;
        resolved.set(
          step.worker,
          (await resolver.selection(step.worker, options)).result,
        );
      }
      return {
        ok: true,
        value: mergePlan(current, steps, next.status, next.question, {
          consent: current?.scopeConsent,
          resolveResult: (worker, stepId) => {
            const done = current?.steps.find(
              (step) => step.id === stepId && step.state === 'done',
            );
            if (done) return resultKind(done);
            const kind = resolved.get(worker);
            if (!kind) throw new Error(`profile ${worker} is unavailable`);
            return kind;
          },
        }),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          // A profile source outage is infrastructure, not a bad plan.
          code: options?.signal?.aborted
            ? 'aborted'
            : error instanceof ProfileSourceError &&
                error.code === 'unavailable'
              ? 'unavailable'
              : code,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
