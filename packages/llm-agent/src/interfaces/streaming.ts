/**
 * Per-event chunk type emitted by `onPartial` callbacks along the
 * worker → interpreter → coordinator path.
 *
 * `content` carries an LLM-output delta; `tool-call` flags a tool
 * invocation; `node-start` / `node-end` wrap a DAG node execution at
 * the interpreter layer. `nodeId` is supplied by the interpreter when
 * forwarding worker-emitted chunks (workers don't know their node id).
 */
export type StreamChunk =
  | { kind: 'content'; nodeId?: string; delta: string }
  | { kind: 'tool-call'; nodeId?: string; name: string; args?: unknown }
  | { kind: 'node-start'; nodeId: string; goal: string }
  | { kind: 'node-end'; nodeId: string; ok: boolean };

export type OnPartial = (chunk: StreamChunk) => void;
