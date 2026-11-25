import { addAbortListener } from 'node:events';
import { LlmError } from '@mcp-abap-adt/llm-agent';

export const AWS_EVENT_STREAM = 'application/vnd.amazon.eventstream';
const PRELUDE_BYTES = 12;
const CRC_BYTES = 4;
const STRING_HEADER = 7;
const fixedHeaderSizes = [0, 0, 1, 2, 4, 8, undefined, undefined, 8, 16];
const utf8 = new TextDecoder('utf-8', { fatal: true });

// Node 22.0 predates the built-in CRC32 function.
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) {
    byte = (byte >>> 1) ^ (byte & 1 ? 0xedb88320 : 0);
  }
  return byte;
});

function crc32(bytes: Uint8Array, previous = 0) {
  let crc = previous ^ 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readHeaders(bytes: Buffer) {
  const headers = new Map<string, string | undefined>();
  let offset = 0;
  while (offset < bytes.length) {
    const nameLength = bytes[offset++];
    if (!nameLength || offset + nameLength >= bytes.length)
      throw new LlmError('Invalid AWS event stream header name');
    const name = utf8.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const type = bytes[offset++];
    let valueLength = fixedHeaderSizes[type];
    if (type === 6 || type === STRING_HEADER) {
      if (offset + 2 > bytes.length)
        throw new LlmError('Incomplete AWS event stream header length');
      valueLength = bytes.readUInt16BE(offset);
      offset += 2;
    }
    if (
      valueLength === undefined ||
      offset + valueLength > bytes.length ||
      headers.has(name)
    )
      throw new LlmError('Invalid AWS event stream header value');
    headers.set(
      name,
      type === STRING_HEADER
        ? utf8.decode(bytes.subarray(offset, offset + valueLength))
        : undefined,
    );
    offset += valueLength;
  }
  return headers;
}

/** Decode Bedrock JSON envelopes inside AWS Event Stream frames. */
export async function* readBedrockEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const onAbort =
    signal &&
    addAbortListener(signal, () => {
      void reader.cancel().catch(() => {});
    });
  let remaining: Buffer = Buffer.alloc(0);
  let completed = false;

  async function read(length: number): Promise<Buffer | undefined> {
    const parts: Buffer[] = [];
    let received = 0;
    while (received < length) {
      signal?.throwIfAborted();
      if (!remaining.length) {
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) {
          if (received === 0) return;
          throw new LlmError('Incomplete AWS event stream frame');
        }
        remaining = Buffer.from(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        );
        if (!remaining.length) continue;
      }
      const take = Math.min(length - received, remaining.length);
      parts.push(remaining.subarray(0, take));
      remaining = remaining.subarray(take);
      received += take;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
  }

  try {
    while (true) {
      const prelude = await read(PRELUDE_BYTES);
      if (!prelude) {
        completed = true;
        return;
      }
      if (crc32(prelude.subarray(0, 8)) !== prelude.readUInt32BE(8))
        throw new LlmError('Invalid AWS event stream prelude CRC');
      const dataLength = prelude.readUInt32BE(0) - PRELUDE_BYTES - CRC_BYTES;
      const headersLength = prelude.readUInt32BE(4);
      if (headersLength > dataLength)
        throw new LlmError('Invalid AWS event stream frame length');

      const frame = await read(dataLength + CRC_BYTES);
      if (!frame) throw new LlmError('Incomplete AWS event stream frame');
      const data = frame.subarray(0, dataLength);
      if (crc32(data, crc32(prelude)) !== frame.readUInt32BE(dataLength))
        throw new LlmError('Invalid AWS event stream message CRC');

      const headers = readHeaders(data.subarray(0, headersLength));
      const messageType = headers.get(':message-type');
      const payload = utf8.decode(data.subarray(headersLength));
      if (messageType === 'error' || messageType === 'exception') {
        const error: { message?: string } | null =
          messageType === 'exception' && payload ? JSON.parse(payload) : null;
        yield {
          type: 'error',
          data: JSON.stringify({
            error: { message: error?.message ?? headers.get(':error-message') },
          }),
        };
        continue;
      }
      if (messageType !== 'event' || headers.get(':event-type') !== 'chunk')
        throw new LlmError('Unexpected AWS event stream message');

      const envelope: { bytes?: string } | null = JSON.parse(payload);
      if (typeof envelope?.bytes !== 'string')
        throw new LlmError('AWS event stream chunk is missing bytes');
      const bytes = Buffer.from(envelope.bytes, 'base64');
      if (bytes.toString('base64') !== envelope.bytes)
        throw new LlmError('Invalid AWS event stream chunk encoding');
      yield { data: utf8.decode(bytes), type: undefined };
    }
  } finally {
    onAbort?.[Symbol.dispose]();
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
