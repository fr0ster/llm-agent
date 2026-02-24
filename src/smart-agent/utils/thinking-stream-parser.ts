/**
 * ThinkingStreamParser — incremental parser for <thinking>/<reasoning> blocks.
 *
 * Consumes streamed text deltas and re-emits them as either 'text' or
 * 'reasoning' chunks. Correctly handles tags that span multiple delta chunks.
 *
 * Supported tags: <thinking>...</thinking>  and  <reasoning>...</reasoning>
 */

const OPEN_TAGS = ['<thinking>', '<reasoning>'] as const;
const CLOSE_TAGS = ['</thinking>', '</reasoning>'] as const;

// Longest possible open/close tag length — used to determine the safe-emit window.
const MAX_OPEN_LEN = Math.max(...OPEN_TAGS.map((t) => t.length)); // 10
const MAX_CLOSE_LEN = Math.max(...CLOSE_TAGS.map((t) => t.length)); // 11

export type ParsedChunk = { type: 'text' | 'reasoning'; delta: string };

/** Find the earliest occurrence of any tag in `s`. Returns { idx: -1 } if none found. */
function findFirst(tags: readonly string[], s: string): { idx: number; len: number } {
  let best = { idx: -1, len: 0 };
  for (const tag of tags) {
    const idx = s.indexOf(tag);
    if (idx !== -1 && (best.idx === -1 || idx < best.idx)) {
      best = { idx, len: tag.length };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// ThinkingStreamParser
// ---------------------------------------------------------------------------

export class ThinkingStreamParser {
  private mode: 'normal' | 'thinking' = 'normal';
  private buffer = '';

  /**
   * Feed the next text delta. Returns zero or more parsed chunks.
   * Holds back up to (maxTagLen - 1) characters at the tail to handle
   * tags that arrive split across multiple delta calls.
   */
  push(delta: string): ParsedChunk[] {
    this.buffer += delta;
    const chunks: ParsedChunk[] = [];

    while (this.buffer.length > 0) {
      if (this.mode === 'normal') {
        const found = findFirst(OPEN_TAGS, this.buffer);

        if (found.idx !== -1) {
          // Emit text before the opening tag, then enter thinking mode.
          if (found.idx > 0) {
            chunks.push({ type: 'text', delta: this.buffer.slice(0, found.idx) });
          }
          this.buffer = this.buffer.slice(found.idx + found.len);
          this.mode = 'thinking';
          // Continue the while loop — process remaining buffer in thinking mode.
        } else {
          // No complete open tag yet. Safely emit everything except the last
          // (MAX_OPEN_LEN - 1) bytes, which might be the start of a partial tag.
          const safeLen = this.buffer.length - MAX_OPEN_LEN + 1;
          if (safeLen > 0) {
            chunks.push({ type: 'text', delta: this.buffer.slice(0, safeLen) });
            this.buffer = this.buffer.slice(safeLen);
          }
          break; // wait for more data
        }
      } else {
        // thinking mode — accumulate until we see the closing tag.
        const found = findFirst(CLOSE_TAGS, this.buffer);

        if (found.idx !== -1) {
          // Emit reasoning content before the closing tag, then return to normal.
          if (found.idx > 0) {
            chunks.push({ type: 'reasoning', delta: this.buffer.slice(0, found.idx) });
          }
          this.buffer = this.buffer.slice(found.idx + found.len);
          this.mode = 'normal';
          // Continue the while loop — process remaining buffer in normal mode.
        } else {
          const safeLen = this.buffer.length - MAX_CLOSE_LEN + 1;
          if (safeLen > 0) {
            chunks.push({ type: 'reasoning', delta: this.buffer.slice(0, safeLen) });
            this.buffer = this.buffer.slice(safeLen);
          }
          break;
        }
      }
    }

    return chunks;
  }

  /**
   * Flush any remaining buffered text at end-of-stream.
   * Emits the buffer content under the current mode and resets state.
   */
  flush(): ParsedChunk[] {
    if (this.buffer.length === 0) return [];
    const type: 'text' | 'reasoning' = this.mode === 'thinking' ? 'reasoning' : 'text';
    const result: ParsedChunk[] = [{ type, delta: this.buffer }];
    this.buffer = '';
    this.mode = 'normal';
    return result;
  }
}
