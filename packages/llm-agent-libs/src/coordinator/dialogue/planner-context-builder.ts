import type {
  IPlannerContextBuilder,
  Message,
  PlannerContextInput,
  PlannerRequestRecord,
} from '@mcp-abap-adt/llm-agent';

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
  record.transcript.push(stored);
  boundRequestTranscript(record);
}

export function boundRequestTranscript(record: PlannerRequestRecord): void {
  const messages = record.transcript;
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
    let offset = 0;
    const parts = record.transcript.map((message) => {
      const content = message.content ?? '';
      const storedCut =
        /\[stored cut: 150000 of \d+ characters\]$/.exec(content)?.[0] ?? '';
      const start = offset + message.role.length + 2;
      offset = start + content.length + 2;
      return {
        ...structuredClone(message),
        content:
          content.length > 20_000
            ? `${content.slice(0, 20_000)}[cut: 20000 of ${content.length}; get_request ${record.id} offset ${start + 20_000}]${storedCut}`
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
      const markerSize =
        `[elided ${index - 1} messages; get_request ${record.id}]`.length;
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
        content: `[elided ${index} messages; get_request ${record.id}]`,
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
    return messages;
  }
}
