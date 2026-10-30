import type { Message } from '@mcp-abap-adt/llm-agent';

/** Static guidance shared by planner and worker system prompts. */
export const REQUEST_TIME_GUIDANCE =
  'The context gives the time the request started. Use it for dates and as a rough "now"; it is not a clock; do not reason about exact time or elapsed durations from it. Never invent dates; when a date is needed, use this one.';

/** Format the existing request timestamp to minute precision in a deployment zone. */
export function formatRequestTime(openedAt: number, timeZone = 'UTC'): string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
  const parts = formatter.formatToParts(openedAt);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((entry) => entry.type === type)?.value;
    if (value === undefined)
      throw new Error(`Missing request time part: ${type}`);
    return value;
  };
  const offset = part('timeZoneName').replace('GMT', '') || '+00:00';
  return `[request time] ${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} ${offset} (${timeZone})`;
}

/** Validate the deployment zone before loading session state. */
export function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
  } catch (cause) {
    throw new RangeError(
      `timeZone must be a valid time zone; received ${JSON.stringify(timeZone)}`,
      { cause },
    );
  }
}

/** Add static guidance and optional request time without changing caller messages. */
export function withRequestTime(
  input: Message[],
  requestStartedAt?: number,
  timeZone = 'UTC',
  fallbackText = '',
): Message[] {
  const messages = [...input];
  const systemIndex = messages.findIndex(
    (message) => message.role === 'system',
  );
  if (systemIndex < 0) {
    messages.unshift({ role: 'system', content: REQUEST_TIME_GUIDANCE });
  } else if (!messages[systemIndex].content?.includes(REQUEST_TIME_GUIDANCE)) {
    messages[systemIndex] = {
      ...messages[systemIndex],
      content: `${messages[systemIndex].content ?? ''}\n\n${REQUEST_TIME_GUIDANCE}`,
    };
  }
  if (requestStartedAt !== undefined) {
    const line = formatRequestTime(requestStartedAt, timeZone);
    let index = messages.length - 1;
    while (index >= 0 && messages[index].role !== 'user') index--;
    if (index >= 0) {
      messages[index] = {
        ...messages[index],
        content: `${line}\n\n${messages[index].content ?? ''}`,
      };
    } else {
      messages.push({ role: 'user', content: `${line}\n\n${fallbackText}` });
    }
  }
  return messages;
}
