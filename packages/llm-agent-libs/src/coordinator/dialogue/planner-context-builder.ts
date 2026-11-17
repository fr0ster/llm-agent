import type {
  IPlannerContextBuilder,
  Message,
  PlannerContextInput,
  PlannerRequestRecord,
} from '@mcp-abap-adt/llm-agent';
import { formatTrust } from '@mcp-abap-adt/llm-agent';

/** Escape bracket delimiters in retrieved data, including source labels. */
export const escapePlannerData = (text: string): string =>
  text.replaceAll('[', '&#91;').replaceAll(']', '&#93;');

function renderBlock(
  name: string,
  entries: readonly string[],
  budget: number,
): string {
  if (!entries.length) return '';
  const start = `[${name}]\n`;
  const end = `\n[/${name}]`;
  let body = '';
  for (const entry of entries) {
    const available =
      budget - start.length - end.length - body.length - (body ? 1 : 0);
    if (available <= 0) break;
    const labelEnd = entry.indexOf(')') + 1;
    if (available <= labelEnd) break;
    body += `${body ? '\n' : ''}${entry.slice(0, available)}`;
  }
  return body ? start + body + end : '';
}

export function renderPlannerRetrieval(input: PlannerContextInput): string[] {
  const memory = renderBlock(
    'session memory',
    input.memory.map(
      (entry) =>
        `(${escapePlannerData(typeof entry.trust === 'number' && entry.source !== undefined ? entry.source : `${entry.kind} ${entry.sourceId} ${entry.requestId} offset ${entry.offset}`)}${typeof entry.trust === 'number' ? `; trust ${formatTrust(entry.trust)}` : ''}) ${escapePlannerData(entry.text)}`,
    ),
    input.memoryCharBudget ?? 12_000,
  );
  const collections = [
    ...new Set(input.knowledge.map((entry) => entry.collection)),
  ];
  const budget = input.knowledgeCharBudget ?? 12_000;
  const overhead = '[planning knowledge]\n\n[/planning knowledge]'.length;
  let remaining = Math.max(0, budget - overhead);
  const selected: string[] = [];
  for (let index = 0; index < collections.length; index++) {
    const share = Math.floor(remaining / (collections.length - index));
    let used = 0;
    for (const entry of input.knowledge.filter(
      (item) => item.collection === collections[index],
    )) {
      const label = `(${escapePlannerData(typeof entry.trust === 'number' && entry.source !== undefined ? entry.source : `${entry.collection}/${entry.id}`)}${typeof entry.trust === 'number' ? `; trust ${formatTrust(entry.trust)}` : ''}) `;
      const available = share - used - (selected.length ? 1 : 0);
      if (available <= label.length) break;
      const line =
        label +
        escapePlannerData(entry.text).slice(0, available - label.length);
      used += line.length + (selected.length ? 1 : 0);
      selected.push(line);
    }
    remaining -= used;
  }
  const knowledge = renderBlock('planning knowledge', selected, budget);
  return [knowledge, memory].filter(Boolean);
}

/** Append a complete independent message without mutating the caller's value. */
export function appendRequestMessage(
  record: PlannerRequestRecord,
  message: NonNullable<PlannerRequestRecord['transcript']>[number],
): void {
  record.transcript ??= [];
  record.transcript.push(structuredClone(message));
}

/** Project complete transcript content without applying message or character caps. */
export class DefaultPlannerContextBuilder implements IPlannerContextBuilder {
  build(input: PlannerContextInput): Message[] {
    const record = input.open;
    if (!record) return [];
    const transcript = record.transcript ?? [];
    const parts = transcript.map((message) => {
      const content = message.content ?? '';
      const {
        plannerReference: _reference,
        internalKind: _internal,
        ...stored
      } = structuredClone(message);
      return {
        ...stored,
        content,
      };
    });
    const selected = parts.filter(
      (part) =>
        part.content.length > 0 ||
        (part.tool_calls?.length ?? 0) > 0 ||
        part.role === 'tool',
    );
    if (!selected.length) return [];
    const messages: Message[] = [];
    for (const part of selected) {
      const last = messages.at(-1);
      if (
        last?.role === part.role &&
        part.role !== 'tool' &&
        !last.tool_calls?.length &&
        !part.tool_calls?.length
      )
        last.content = `${last.content}\n${part.content}`;
      else messages.push(part);
    }
    const last = messages.at(-1);
    if (last && input.notes.length)
      last.content = `${input.notes.join('\n')}\n${last.content}`;
    // Older persisted transcripts can still contain storage truncation markers.
    const storageElided = transcript.some((message) =>
      /\[(?:stored cut:|dropped) /.test(message.content ?? ''),
    );
    const blocks = renderPlannerRetrieval({
      ...input,
      memory: input.memory.filter(
        (entry) => entry.requestId !== record.id || storageElided,
      ),
    });
    if (blocks.length && messages[0])
      messages[0].content = `${blocks.join('\n')}\n${messages[0].content}`;
    return messages;
  }
}
