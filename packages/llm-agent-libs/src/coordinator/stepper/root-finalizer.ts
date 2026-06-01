import {
  type IKnowledgeRagHandle,
  type ILlm,
  InsufficientSignal,
  type LlmUsage,
  type StreamChunk,
} from '@mcp-abap-adt/llm-agent';

const FINALIZER_SYSTEM = `You compose the final answer for the consumer from the provided knowledge entries.
If the entries contain enough information, write the answer directly in clean Markdown.
If a REQUIRED fact is missing, respond with ONLY JSON: {"insufficient":["<missing item>", ...]} and nothing else.`;

export class RootFinalizer {
  constructor(private readonly llm: ILlm) {}

  async finalize(input: {
    prompt: string;
    knowledgeRag: IKnowledgeRagHandle;
    turnId: string;
    scope?: 'turn' | 'session';
    signal?: AbortSignal;
    onProgress?: (event: StreamChunk) => void;
  }): Promise<{ output: string; usage?: LlmUsage }> {
    const filter = input.scope === 'session' ? {} : { turnId: input.turnId };
    const entries = await input.knowledgeRag.list(filter);
    const knowledge = entries
      .map((e, i) => `[${i + 1}] (${e.metadata.artifactType}) ${e.content}`)
      .join('\n\n');
    const user = `Consumer request:\n${input.prompt}\n\nKnowledge entries:\n${knowledge || '(none)'}`;

    let buf = '';
    let usage: LlmUsage | undefined;
    for await (const chunk of this.llm.streamChat(
      [
        { role: 'system', content: FINALIZER_SYSTEM },
        { role: 'user', content: user },
      ] as never,
      [] as never,
      { signal: input.signal },
    )) {
      if (chunk.ok === false)
        throw new Error(chunk.error?.message ?? 'finalizer stream error');
      const delta = chunk.value.content ?? '';
      if (delta) {
        buf += delta;
        input.onProgress?.({ kind: 'content', delta });
      }
      if (chunk.value.usage) usage = chunk.value.usage;
    }

    const insufficient = tryParseInsufficient(buf);
    if (insufficient) throw new InsufficientSignal(insufficient, usage);
    return { output: buf, usage };
  }
}

function tryParseInsufficient(text: string): string[] | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { insufficient?: unknown };
    if (Array.isArray(parsed.insufficient))
      return parsed.insufficient.map(String);
  } catch {
    // not the insufficient marker → treat as a normal answer
  }
  return undefined;
}
