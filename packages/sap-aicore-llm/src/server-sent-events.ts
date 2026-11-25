import { addAbortListener } from 'node:events';

interface ServerSentEvent {
  type?: string;
  data: string;
}

/** Decode complete SSE events across byte chunks, including split UTF-8 and CRLF. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort =
    signal &&
    addAbortListener(signal, () => {
      void reader.cancel().catch(() => {});
    });
  let buffer = '';
  let data: string[] = [];
  let type: string | undefined;
  let completed = false;

  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      buffer += done
        ? `${decoder.decode()}\n\n`
        : decoder.decode(value, { stream: true });
      let consumed = 0;
      for (const delimiter of buffer.matchAll(/\r\n|\r|\n/g)) {
        const end = delimiter.index;
        if (!done && delimiter[0] === '\r' && end === buffer.length - 1) break;
        const line = buffer.slice(consumed, end);
        consumed = end + delimiter[0].length;
        if (!line) {
          if (data.length) yield { type, data: data.join('\n') };
          data = [];
          type = undefined;
        } else {
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value =
            colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') type = value;
          if (field === 'data') data.push(value);
        }
        signal?.throwIfAborted();
      }
      if (done) {
        completed = true;
        return;
      }
      buffer = buffer.slice(consumed);
    }
  } finally {
    onAbort?.[Symbol.dispose]();
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
