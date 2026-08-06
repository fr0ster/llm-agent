/**
 * Convert an MCP `CallToolResult.content` into the text an executor / a surfaced
 * error should see.
 *
 * A standard MCP tool result is an array of content blocks
 * (`[{ type: 'text', text: '…' }, …]`), never a bare string — so the historical
 * `typeof content === 'string' ? content : JSON.stringify(content)` in the
 * bridges fell through to `JSON.stringify` and handed the executor (and any
 * downstream surfacing, e.g. the #264 control-failure text) the raw envelope
 * `[{"type":"text","text":"…"}]` instead of the text (#267).
 *
 * This unwraps the CANONICAL text envelope — an array whose blocks are ALL
 * `{ type:'text', text }` — and joins the parts. Anything else (a bare string is
 * returned as-is; a structured object, or a mixed array with image/resource
 * blocks) keeps today's `JSON.stringify` behavior, so no information is lost for
 * non-text payloads. Mirrors `extractText` in `http/chat-route-handler.ts`.
 */
export function mcpContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (b): b is { type: 'text'; text: string } =>
        typeof b === 'object' &&
        b !== null &&
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
  ) {
    return content.map((b) => b.text).join('\n');
  }
  return JSON.stringify(content);
}
