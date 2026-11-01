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
  message: Message,
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
    previous?.role === 'user'
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
    });
}

/** Bounded chronological projection; the supplied record is never modified. */
export class DefaultPlannerContextBuilder implements IPlannerContextBuilder {
  build(input: PlannerContextInput): Message[] {
    const record = input.open;
    if (!record) return [];
    const parts = (record.transcript ?? []).map((message) => {
      const content = message.content ?? '';
      const storedCut =
        /\[stored cut: 150000 of \d+ characters\]$/.exec(content)?.[0] ?? '';
      return {
        ...structuredClone(message),
        content:
          content.length > 20_000
            ? `${content.slice(0, 20_000)}[cut: 20000 of ${content.length}]${storedCut}`
            : content,
      };
    });
    if (!parts.length) return [];
    const first = parts[0];
    const selected: Message[] = [first];
    let size = first.content.length;
    let index = parts.length - 1;
    // Reserve space for the elision note and for separators introduced by merging.
    for (; index > 0; index--) {
      const part = parts[index];
      const markerSize = `[elided ${index - 1} messages]`.length;
      if (
        size + part.content.length + markerSize + selected.length + 2 >
        60_000
      )
        break;
      selected.splice(1, 0, part);
      size += part.content.length;
    }
    if (index > 0)
      selected.splice(1, 0, {
        role: 'user',
        content: `[elided ${index} messages]`,
      });
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
    const projectionElided = selected.some((message) =>
      /\[(?:elided|cut:|stored cut:|dropped) /.test(message.content ?? ''),
    );
    const blocks = renderPlannerRetrieval({
      ...input,
      memory: input.memory.filter(
        (entry) => entry.requestId !== record.id || projectionElided,
      ),
    });
    if (blocks.length && messages[0])
      messages[0].content = `${blocks.join('\n')}\n${messages[0].content}`;
    return messages;
  }
}
