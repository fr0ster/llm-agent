import type {
  IMcpClient,
  McpError,
  McpTool,
  McpToolResult,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import { currentPlannerScope } from './planner-scope.js';
import {
  currentWorkTaskId,
  dependenciesDone,
  mergePlan,
  stepSchema,
} from './structured-plan.js';

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
function selectHistory(
  messages: Message[],
  mode: unknown,
): Message[] | undefined {
  if (mode === undefined || mode === 'none') return undefined;
  if (mode === 'all') return structuredClone(messages.slice(-20));
  if (mode !== 'last-turn')
    throw new Error('history must be none, last-turn or all');
  let index = messages.length - 1;
  while (index >= 0 && messages[index].role !== 'user') index--;
  if (index < 0) return [];
  const reply = messages
    .slice(index + 1)
    .find((message) => message.role === 'assistant');
  return structuredClone(reply ? [messages[index], reply] : [messages[index]]);
}
export class PlannerToolsClient implements IMcpClient {
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
          name: 'delegate_task',
          description: 'Delegate background work to a worker.',
          inputSchema: schema(
            {
              worker: { ...string, ...(workers ? { enum: workers } : {}) },
              goal: string,
              step_id: string,
              context: string,
              history: { type: 'string', enum: ['none', 'last-turn', 'all'] },
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
          name: 'stop_task',
          description: 'Request a cooperative task stop.',
          inputSchema: schema({ task_id: string }, ['task_id']),
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
                'checking',
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
      switch (name) {
        case 'delegate_task': {
          const worker = requiredString(args, 'worker');
          const goal = requiredString(args, 'goal');
          const context =
            args.context === undefined
              ? undefined
              : requiredString(args, 'context');
          const history = selectHistory(scope.history(), args.history);
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
          const isCheck = step?.check?.by === 'checker' && worker === 'checker';
          if (isCheck && step?.state !== 'checking')
            throw new Error(
              'checker requires a successful current work attempt (checking)',
            );
          const attemptId = isCheck
            ? step?.check?.taskId
            : step && currentWorkTaskId(step);
          const currentAttempt = attemptId
            ? scope.board.get(attemptId)
            : undefined;
          if (
            currentAttempt?.state === 'queued' ||
            currentAttempt?.state === 'running'
          )
            throw new Error(
              `${isCheck ? 'check' : 'work'} attempt ${attemptId} for ${step?.id} is ${currentAttempt.state}; stop it first with stop_task or wait for it to settle`,
            );
          const result = scope.board.start({ worker, goal, context, history });
          if (!result.ok) throw new Error(result.error);
          if (step) {
            step.taskIds.push(result.value.id);
            if (isCheck && step.check) {
              step.check.taskId = result.value.id;
              delete step.check.verdict;
            } else {
              step.workTaskId = result.value.id;
              step.state = 'running';
              if (step.check) {
                delete step.check.taskId;
                delete step.check.verdict;
              }
            }
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
        case 'stop_task': {
          const id = requiredString(args, 'task_id');
          const stopped = scope.board.stop(id);
          scope.recordAction?.(
            `stop ${id} (${stopped ? 'requested' : 'not stopped'})`,
          );
          return textResult({ stopped });
        }
        case 'get_task': {
          const id = requiredString(args, 'task_id');
          const task = scope.board.get(id);
          if (!task) throw new Error(`unknown task ${id}`);
          return textResult(task);
        }
        case 'list_tasks':
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
                  'checking',
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
          if (
            args.steps !== undefined &&
            status === 'waiting_user' &&
            !question?.trim()
          )
            throw new Error('waiting_user requires question');
          scope.setPlan(
            args.steps !== undefined
              ? mergePlan(scope.getPlan(), args.steps, status, question)
              : requiredString(args, 'plan'),
            status,
            question,
          );
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
