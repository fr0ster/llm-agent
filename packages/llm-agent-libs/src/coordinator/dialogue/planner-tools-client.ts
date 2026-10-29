import type {
  DialoguePlanStep,
  IMcpClient,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import { currentPlannerScope } from './planner-scope.js';
import { dependenciesDone, mergePlan, stepSchema } from './structured-plan.js';
import type { TaskBoard } from './task-board.js';

function assertNoActiveAttempt(step: DialoguePlanStep, board: TaskBoard): void {
  for (const id of new Set([...step.taskIds, step.workTaskId])) {
    const task = id ? board.get(id) : undefined;
    if (task?.state === 'queued' || task?.state === 'running')
      throw new Error(
        `Task attempt ${id} for ${step.id} is ${task.state}; stop it first with stop_task or wait for it to settle`,
      );
  }
}

function textResult(
  value: unknown,
  isError?: boolean,
): Result<McpToolResult, McpError> {
  return {
    ok: true,
    value: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      ...(isError ? { isError } : {}),
    },
  };
}
function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}
export class PlannerToolsClient implements IMcpClient {
  readonly cacheable = false;

  async listTools(): Promise<Result<McpTool[], McpError>> {
    const plan = currentPlannerScope()?.getPlan();
    const workers = currentPlannerScope()?.board.workerNames();
    const string = { type: 'string' };
    const schema = (
      properties: Record<string, unknown>,
      required: string[] = [],
    ) => ({
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    });
    return {
      ok: true,
      value: [
        {
          name: 'new_request',
          description: 'Start unrelated work in a new request; call first.',
          inputSchema: schema({}),
        },
        {
          name: 'delegate_task',
          description:
            'Delegate a result to a worker: goal = the result, context = constraints, facts and the done criterion; a planned independent check is a separate checker task.',
          inputSchema: schema(
            {
              worker: { ...string, ...(workers ? { enum: workers } : {}) },
              goal: string,
              step_id: string,
              context: string,
            },
            [
              'worker',
              'goal',
              ...(typeof plan === 'object' && plan.note === undefined
                ? ['step_id']
                : []),
            ],
          ),
        },
        {
          name: 'search_knowledge',
          description:
            'Search curated planning knowledge for further guidance.',
          inputSchema: schema(
            {
              query: string,
              collection: string,
              k: { type: 'integer', minimum: 1, maximum: 10, default: 4 },
            },
            ['query'],
          ),
        },
        {
          name: 'stop_task',
          description: 'Request a cooperative task stop.',
          inputSchema: schema({ task_id: string }, ['task_id']),
        },
        {
          name: 'deliver',
          description:
            'Return a completed task result verbatim to the user, once per planner call.',
          inputSchema: schema(
            { task_id: string, note: { type: 'string', maxLength: 1000 } },
            ['task_id'],
          ),
        },
        {
          name: 'get_task',
          description: 'Get a task and its bounded output.',
          inputSchema: schema({ task_id: string }, ['task_id']),
        },
        {
          name: 'list_tasks',
          description: 'List task identities, goals and states.',
          inputSchema: schema({}),
        },
        {
          name: 'get_plan',
          description:
            'Read full plan steps, filtered by state and paged in plan order.',
          inputSchema: schema({
            state: {
              type: 'string',
              enum: [
                'ready',
                'pending',
                'running',
                'done',
                'failed',
                'skipped',
                'blocked',
              ],
            },
            offset: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, default: 40 },
          }),
        },
        {
          name: 'update_plan',
          description: 'Store the current plan.',
          inputSchema: schema(
            {
              plan: string,
              steps: { type: 'array', items: z.toJSONSchema(stepSchema) },
              question: string,
              status: {
                type: 'string',
                enum: ['active', 'waiting_user', 'done'],
                default: 'active',
              },
            },
            [],
          ),
        },
      ],
    };
  }
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Result<McpToolResult, McpError>> {
    try {
      const scope = currentPlannerScope();
      if (!scope) throw new Error('no planner session');
      scope.beforeTool?.(name);
      switch (name) {
        case 'new_request':
          z.object({}).strict().parse(args);
          if (!scope.newRequest) throw new Error('new_request is unavailable');
          scope.newRequest();
          return textResult({
            ok: true,
            message: 'new request started; continue in the next call',
          });
        case 'delegate_task': {
          for (const name of ['inputs', 'history'])
            if (Object.hasOwn(args, name))
              throw new Error(
                `${name} is not supported; put what the step needs in context`,
              );
          const worker = requiredString(args, 'worker');
          const goal = requiredString(args, 'goal');
          let context =
            args.context === undefined
              ? undefined
              : requiredString(args, 'context');
          const plan = scope.getPlan();
          const structured =
            typeof plan === 'object' && plan.note === undefined
              ? plan
              : undefined;
          const step = structured?.steps.find((s) => s.id === args.step_id);
          if (structured && !step)
            throw new Error('step_id must identify a plan step');
          if (step && structured && !dependenciesDone(structured, step))
            throw new Error(`dependencies for ${step.id} are not done`);
          const isCheck = step?.worker === 'checker';
          if (step && (worker === 'checker') !== isCheck)
            throw new Error(
              'Check steps (worker checker) must use the separate read-only checker worker; non-check steps cannot use checker. The worker that did the work never checks it.',
            );
          if (isCheck && !step?.dependsOn?.length)
            throw new Error(
              'A check step requires dependsOn identifying the steps to check',
            );
          if (step) assertNoActiveAttempt(step, scope.board);
          const checkedTaskIds: Record<string, string> = {};
          if (step && structured) {
            const sources = (step.dependsOn ?? []).map((id) =>
              structured.steps.find((s) => s.id === id),
            );
            const blocks: string[] = [];
            let size = 0;
            for (const source of sources) {
              if (!source) throw new Error('dependency step is missing');
              const id = source.successfulWorkTaskId;
              const task = id ? scope.board.get(id) : undefined;
              if (task?.state !== 'done')
                throw new Error(
                  `step ${source.id} has no successful work result`,
                );
              if (isCheck && task.worker === worker)
                throw new Error(
                  'The worker that did the work never checks it; checked work must be a separate non-checker task',
                );
              if (isCheck) checkedTaskIds[source.id] = task.id;
              const block = [
                `${isCheck ? '[result to check: step' : '[result of step'} ${source.id} (task ${task.id})]\n${task.output ?? ''}`,
                isCheck && source.items
                  ? `Expected items for step ${source.id}: ${JSON.stringify(source.items)}; expected count: ${source.items.length}. Return JSON with verdict, count and note.`
                  : undefined,
              ]
                .filter(Boolean)
                .join('\n');
              const nextSize = size + block.length + (blocks.length ? 2 : 0);
              if (nextSize > 120_000)
                throw new Error(
                  `result of step ${source.id} (task ${task.id}) requires ${block.length} characters; total ${nextSize} exceeds 120000 (already ${size}); split or narrow the step`,
                );
              blocks.push(block);
              size = nextSize;
            }
            if (blocks.length)
              context = [context, ...blocks].filter(Boolean).join('\n\n');
          }
          const result = scope.board.start({
            worker,
            goal,
            context,
            requestStartedAt: scope.requestStartedAt,
          });
          if (!result.ok) throw new Error(result.error);
          scope.ownTask?.(result.value.id);
          if (typeof plan === 'object') delete plan.scopeConsent;
          if (step) {
            scope.taskSteps?.set(result.value.id, step.id);
            step.taskIds.push(result.value.id);
            step.workTaskId = result.value.id;
            delete step.successfulWorkTaskId;
            delete step.verdict;
            step.checkedTaskIds = isCheck ? checkedTaskIds : undefined;
            step.state = 'running';
          }
          scope.recordAction?.(
            `started ${result.value.id}${step ? ` for ${step.id}` : ''} (${worker})`,
            true,
          );
          return textResult({
            task_id: result.value.id,
            state: result.value.state,
          });
        }
        case 'search_knowledge': {
          const { query, collection, k } = z
            .object({
              query: z.string(),
              collection: z.string().optional(),
              k: z.number().int().positive().optional(),
            })
            .parse(args);
          return textResult(
            (await scope.searchKnowledge?.(
              query.slice(0, 2_000),
              collection,
              Math.min(k ?? 4, 10),
            )) ?? '',
          );
        }
        case 'stop_task': {
          const id = requiredString(args, 'task_id');
          const stopped = scope.board.stop(id);
          scope.recordAction?.(
            `stop ${id} (${stopped ? 'requested' : 'not stopped'})`,
          );
          return textResult({ stopped });
        }
        case 'deliver': {
          const { task_id, note } = z
            .object({
              task_id: z.string(),
              note: z.string().max(1000).optional(),
            })
            .strict()
            .parse(args);
          if (!scope.deliver) throw new Error('deliver is unavailable');
          scope.deliver(task_id, note);
          return textResult({ delivered: task_id });
        }
        case 'get_task': {
          const id = requiredString(args, 'task_id');
          const task = scope.board.get(id);
          if (!task) throw new Error(`unknown task ${id}`);
          if (task.state === 'queued' || task.state === 'running')
            scope.statusRead?.();
          return textResult(task);
        }
        case 'list_tasks':
          if (
            scope.board
              .list()
              .some(
                (task) => task.state === 'queued' || task.state === 'running',
              )
          )
            scope.statusRead?.();
          return textResult(
            scope.board.list().map(({ id, worker, goal, state }) => ({
              id,
              worker,
              goal,
              state,
            })),
          );
        case 'get_plan': {
          const {
            state,
            offset = 0,
            limit = 40,
          } = z
            .object({
              state: z
                .enum([
                  'ready',
                  'pending',
                  'running',
                  'done',
                  'failed',
                  'skipped',
                  'blocked',
                ])
                .optional(),
              offset: z.number().int().min(0).optional(),
              limit: z.number().int().min(1).optional(),
            })
            .parse(args);
          const plan = scope.getPlan();
          if (typeof plan !== 'object')
            return textResult({
              plan: plan ?? null,
              steps: [],
              total: 0,
              offset,
              limit,
            });
          const steps = plan.steps.filter(
            (step) =>
              !state ||
              (state === 'ready'
                ? step.state === 'pending' && dependenciesDone(plan, step)
                : step.state === state),
          );
          return textResult({
            ...plan,
            steps: steps.slice(offset, offset + limit),
            total: steps.length,
            offset,
            limit,
          });
        }
        case 'update_plan': {
          const status = args.status ?? 'active';
          if (
            status !== 'active' &&
            status !== 'waiting_user' &&
            status !== 'done'
          )
            throw new Error('status must be active, waiting_user or done');
          const question =
            args.question === undefined
              ? undefined
              : requiredString(args, 'question');
          if (status === 'waiting_user' && !question?.trim())
            throw new Error('waiting_user requires question');
          const previous = scope.getPlan();
          if (typeof previous === 'object') {
            const retained =
              args.steps === undefined
                ? []
                : z.array(stepSchema).parse(args.steps);
            for (const step of previous.steps) {
              const next = retained.find((s) => s.id === step.id);
              if (
                next &&
                JSON.stringify(next.items) === JSON.stringify(step.items) &&
                next.state !== 'pending'
              )
                continue;
              try {
                assertNoActiveAttempt(step, scope.board);
              } catch (error) {
                throw new Error(
                  `Cannot ${next ? 'reopen or change items for' : 'remove'} step ${step.id}: ${error instanceof Error ? error.message : String(error)}; stop the task first and wait for it to settle, or keep the step`,
                );
              }
            }
          }
          const next =
            args.steps !== undefined
              ? mergePlan(previous, args.steps, status, question, {
                  consent:
                    typeof previous === 'object' && previous.scopeConsent,
                  maxItemsPerStep: scope.maxItemsPerStep,
                  getTask: (id) => scope.board.get(id),
                })
              : requiredString(args, 'plan');
          if (
            typeof previous === 'object' &&
            typeof next === 'string' &&
            previous.steps.some(
              (s) => (s.state !== 'done' && s.state !== 'skipped') || s.items,
            ) &&
            !previous.scopeConsent
          )
            throw new Error(
              'Removing plan steps requires user consent after waiting_user with a question',
            );
          scope.setPlan(next, status, question);
          scope.recordAction?.('plan updated');
          return textResult({ ok: true });
        }
        default:
          throw new Error(`unknown tool ${name}`);
      }
    } catch (error) {
      return textResult(
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
  }
}
