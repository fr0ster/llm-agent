/**
 * The construction seams every SmartServer in this suite must now name (spec §4.6.3
 * item 3; Task B10 adds makeRag here). The library defaults none of them, so each test says what builds its LLMs,
 * embedders and stores; this module is the answer for tests that do not care. A test
 * that does care overrides one member: `{ ...constructionSeams, makeLlm: mine }`.
 *
 * Not a *.test.ts file, so the runner does not execute it; under __tests__, so the
 * package build does not emit it.
 */
import {
  type IEmbedder,
  type ILlm,
  InMemoryRag,
  type IRag,
} from '@mcp-abap-adt/llm-agent';
import {
  type EmbedderResolutionOptions,
  makeRag,
  resolveEmbedder,
} from '@mcp-abap-adt/llm-agent-rag';
import {
  isInMemoryInput,
  type MakeRagInput,
  type SmartServerEmbedderConfig,
} from '../rag-config.js';
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

function refuseRef(ref: string | undefined, target: string): void {
  if (ref !== undefined) {
    throw new Error(
      `the test seams resolve no credentialRef, but ${target} named '${ref}' — inject a seam of your own for this test`,
    );
  }
}

export const constructionSeams: Pick<
  BuildAgentDeps,
  'makeLlm' | 'resolveEmbedder' | 'makeRag'
> = {
  makeLlm: async (cfg: SmartServerLlmConfig) => stubLlm(cfg.model),

  resolveEmbedder(
    cfg: SmartServerEmbedderConfig,
    options?: EmbedderResolutionOptions,
  ): IEmbedder {
    // Each EmbedderResolution arm is built from NAMED fields — the section is never
    // spread into the library, so nothing it does not declare can ride along.
    const common = {
      ...(cfg.url !== undefined ? { url: cfg.url } : {}),
      ...(cfg.maxBatchSize !== undefined
        ? { maxBatchSize: cfg.maxBatchSize }
        : {}),
    };
    if (cfg.factory !== undefined) {
      return resolveEmbedder(
        {
          factory: cfg.factory,
          ...(cfg.model !== undefined ? { model: cfg.model } : {}),
          ...common,
        },
        options,
      );
    }
    refuseRef(cfg.credentialRef, `embedder '${cfg.provider}'`);
    if (cfg.provider !== 'ollama') {
      throw new Error(
        `the test seams hold no credential, and embedder '${cfg.provider}' requires one — inject a resolveEmbedder of your own`,
      );
    }
    if (cfg.model === undefined) {
      throw new Error(
        'the test seams build ollama only with a model: set rag.embedder.model',
      );
    }
    return resolveEmbedder(
      { provider: 'ollama', model: cfg.model, ...common },
      options,
    );
  },

  async makeRag(input: MakeRagInput): Promise<IRag> {
    if (isInMemoryInput(input)) {
      const { credentialRef, ...address } = input.store;
      refuseRef(credentialRef, 'the in-memory store');
      return input.embedder
        ? makeRag({ ...address, embedder: input.embedder })
        : new InMemoryRag({ dedupThreshold: address.dedupThreshold });
    }
    const { credentialRef, ...address } = input.store;
    refuseRef(credentialRef, `the ${address.type} store`);
    switch (address.type) {
      case 'qdrant':
        return makeRag({ ...address, embedder: input.embedder });
      case 'pg-vector':
        return makeRag({ ...address, embedder: input.embedder });
      case 'hana-vector':
        throw new Error(
          'the test seams hold no credential, and hana-vector requires one — inject a makeRag of your own',
        );
      default: {
        const unreachable: never = address;
        throw new Error(`unknown store ${String(unreachable)}`);
      }
    }
  },
};
