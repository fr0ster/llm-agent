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

const textSize = (messages: readonly Message[]): number =>
  messages.reduce(
    (total, message) => total + (message.content?.length ?? 0),
    0,
  );

/** Append independent parts, preserving the first input and the newest part. */
export function appendRequestMessage(
  record: PlannerRequestRecord,
  message: NonNullable<PlannerRequestRecord['transcript']>[number],
): void {
  const stored = structuredClone(message);
  const content = stored.content ?? '';
  if (content.length > 150_000)
    stored.content = `${content.slice(0, 150_000)}[stored cut: 150000 of ${content.length} characters]`;
  record.transcript ??= [];
  record.transcript.push(stored);
  boundRequestTranscript(record);
}

export function boundRequestTranscript(record: PlannerRequestRecord): void {
  const messages = record.transcript ?? [];
  let dropped = 0;
  const previous = messages[1];
  const match =
    previous?.internalKind === 'note'
      ? /^\[dropped (\d+) earlier messages\]$/.exec(previous.content ?? '')
      : null;
  if (match) {
    dropped = Number(match[1]);
    messages.splice(1, 1);
  }
  while (
    messages.length > 2 &&
    (messages.length + (dropped ? 1 : 0) > 400 ||
      textSize(messages) +
        (dropped ? `[dropped ${dropped} earlier messages]`.length : 0) >
        400_000)
  ) {
    messages.splice(1, 1);
    dropped++;
  }
  if (dropped)
    messages.splice(1, 0, {
      role: 'user',
      content: `[dropped ${dropped} earlier messages]`,
      internalKind: 'note',
    });
}

/** Project task references and recent deltas while preserving user constraints. */
export class DefaultPlannerContextBuilder implements IPlannerContextBuilder {
  build(input: PlannerContextInput): Message[] {
    const record = input.open;
    if (!record) return [];
    const transcript = record.transcript ?? [];
    const latestEvent = new Map<string, number>();
    transcript.forEach((message, index) => {
      if (!message.internalKind) return;
      for (const line of (message.content ?? '').split('\n')) {
        const id = /^\[task events\].*?\btask (\S+)/.exec(line)?.[1];
        if (id) latestEvent.set(id, index);
      }
    });
    const parts = transcript.map((message, index) => {
      const original = message.plannerReference ?? message.content ?? '';
      // Assistant prose can contain pending consent or unresolved issues. Only
      // compact explicit delivery references and consumed user-role events.
      const content =
        message.role === 'assistant' || !message.internalKind
          ? original
          : original
              .split('\n')
              .filter((line) => {
                if (
                  /^\[actions\]/.test(line) &&
                  index < transcript.length - 2 &&
                  !/^\[actions\] task \S+.*\b(failed|error|interrupted)\b/.test(
                    line,
                  )
                )
                  return false;
                const id = /^\[task events\].*?\btask (\S+)/.exec(line)?.[1];
                return (
                  !id ||
                  latestEvent.get(id) === index ||
                  /\b(failed|error|interrupted)\b/.test(line)
                );
              })
              .map((line) => {
                if (
                  index >= transcript.length - 2 ||
                  !/^\[task events\]/.test(line)
                )
                  return line;
                const state = line.replace('[task events]', '[task state]');
                return /\b(failed|error|interrupted)\b/.test(line)
                  ? state
                  : state.replace(
                      /; outcome: .*; use get_task to read output/,
                      '; outcome consumed; use get_task to read output',
                    );
              })
              .join('\n');
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
    const selected = parts.filter((part) => part.content.length > 0);
    if (!selected.length) return [];
    const messages: Message[] = [];
    for (const part of selected) {
      const last = messages.at(-1);
      if (last?.role === part.role)
        last.content = `${last.content}\n${part.content}`;
      else messages.push(part);
    }
    const last = messages.at(-1);
    if (last && input.notes.length)
      last.content = `${input.notes.join('\n')}\n${last.content}`;
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
