import {
  type CallOptions,
  finishDialogueTask,
  type IMcpClient,
  type LlmTool,
} from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';

export const submitReportSchema = z.object({
  summary: z.string().min(1).max(600),
  result: z.string().min(1).optional(),
});

export function resolveWorkerSummary(
  output: string,
  finishSummary?: string,
): { summary: string; truncated: boolean } {
  return finishSummary === undefined
    ? { summary: output.slice(0, 600), truncated: output.length > 600 }
    : {
        summary: finishSummary.slice(0, 600),
        truncated: finishSummary.length > 600,
      };
}

/** Keep verdict and count intact, cutting only the explanatory note. */
export function resolveVerdictSummary(verdict: {
  verdict: 'pass' | 'fail';
  count?: number;
  note?: string;
}): string {
  const line = `${verdict.verdict}${verdict.count === undefined ? '' : `; count: ${verdict.count}`}`;
  return verdict.note
    ? `${line}; note: ${verdict.note.slice(0, 600 - line.length - 8)}`
    : line;
}

export const submitReportTool: LlmTool = {
  name: 'submit_report',
  description:
    'Finish this report task with a short coordinator summary. Supply the full result, or omit result to use all report text already written.',
  inputSchema: z.toJSONSchema(submitReportSchema),
};

const defaultClients = new WeakSet<IMcpClient>();

export function createSubmitReportClient(): IMcpClient {
  const client: IMcpClient = {
    cacheable: false,
    async listTools() {
      return { ok: true, value: [submitReportTool] };
    },
    async callTool(_name, args, options) {
      const parsed = submitReportSchema.safeParse(args);
      const task = options?.dialogueTask;
      const result = parsed.success
        ? (parsed.data.result ?? options?.dialogueReportText?.())
        : undefined;
      const error = !parsed.success
        ? parsed.error.message
        : !task
          ? 'submit_report requires a dialogue task'
          : !result
            ? 'result is required because no report text was written'
            : undefined;
      if (error || !parsed.success || !task || !result) {
        return {
          ok: true,
          value: { content: error ?? 'Invalid result', isError: true },
        };
      }
      finishDialogueTask(task, result, 'submit_report', parsed.data.summary);
      return { ok: true, value: { content: 'Report submitted.' } };
    },
  };
  defaultClients.add(client);
  return client;
}

/** Per-run default, installed after selection and refresh; host tools take precedence. */
export async function withSubmitReport(
  tools: LlmTool[],
  clients: Map<string, IMcpClient>,
  options?: CallOptions,
  externalTools: LlmTool[] = [],
): Promise<LlmTool[]> {
  if (options?.dialogueTask?.result !== 'report') return tools;
  const client = clients.get('submit_report');
  const withoutDefault = tools.filter((tool) => tool !== submitReportTool);
  if (externalTools.some((tool) => tool.name === 'submit_report')) {
    if (client && defaultClients.has(client)) clients.delete('submit_report');
    return withoutDefault;
  }
  if (client && !defaultClients.has(client)) {
    const hostTool = withoutDefault.find(
      (tool) => tool.name === 'submit_report',
    );
    if (hostTool) {
      return [
        ...withoutDefault.filter((tool) => tool.name !== 'submit_report'),
        hostTool,
      ];
    }
    const listed = await client.listTools(options);
    const tool = listed.ok
      ? listed.value.find((candidate) => candidate.name === 'submit_report')
      : undefined;
    return tool ? [...withoutDefault, tool] : withoutDefault;
  }
  if (!client) clients.set('submit_report', createSubmitReportClient());
  return [
    ...tools.filter((tool) => tool.name !== 'submit_report'),
    submitReportTool,
  ];
}
