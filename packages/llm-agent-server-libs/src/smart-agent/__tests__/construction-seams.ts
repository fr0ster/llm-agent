/**
 * The construction seams every SmartServer in this suite must now name (spec §4.6.3
 * item 3; Task B10 adds makeRag here). The library defaults none of them, so each test says what builds its LLMs
 * and embedders; this module is the answer for tests that do not care. A test that
 * does care overrides one member: `{ ...constructionSeams, makeLlm: mine }`.
 *
 * Not a *.test.ts file, so the runner does not execute it; under __tests__, so the
 * package build does not emit it.
 */
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { resolveEmbedder } from '@mcp-abap-adt/llm-agent-rag';
import type { BuildAgentDeps, SmartServerLlmConfig } from '../smart-server.js';

/** An ILlm that answers "ok" and reports the model it was built for. */
export function stubLlm(model = 'stub'): ILlm {
  return {
    model,
    chat: async () =>
      ({ ok: true, value: { content: 'ok', toolCalls: [] } }) as never,
    streamChat: async function* () {},
  } as unknown as ILlm;
}

export const constructionSeams: Pick<
  BuildAgentDeps,
  'makeLlm' | 'resolveEmbedder'
> = {
  makeLlm: async (cfg: SmartServerLlmConfig) => stubLlm(cfg.model),
  // The library's own resolver: a test that configures an embedder by name keeps
  // exactly the behaviour it had while this was the server's default.
  resolveEmbedder,
};
