import type {
  IApiKeyCredential,
  IBearerCredential,
} from '@mcp-abap-adt/interfaces-auth';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';
import { importPeer } from './import-peer.js';

/**
 * What a caller must state to get an embedder. One arm per built-in, each
 * carrying exactly what that embedder's own constructor demands, so a wrong
 * credential kind, a missing one, a missing `apiBaseUrl` or model, or a
 * credential for a target that sends none is a build error rather than
 * something a guard has to notice.
 *
 * Field sources, read from each embedder's own config (not invented):
 *   - openai: `OpenAiEmbedderConfig` — `credential: IApiKeyCredential`,
 *     `model: string`, `baseURL?` (this arm's `url`).
 *   - sap-ai-core / sap-aicore: `SapAiCoreEmbedderConfig` — `model`,
 *     `credential: IBearerCredential`, `apiBaseUrl: string`,
 *     `resourceGroup?`, `scenario?`.
 *   - ollama: `OllamaEmbedderConfig` — `model: string`, `ollamaUrl?` (this
 *     arm's `url`). No credential: it sends none on the wire.
 *   - factory: a consumer-registered `extraFactories` key. It receives the
 *     narrow `EmbedderFactoryConfig` (`url`, `model`, `timeoutMs`) and never
 *     a credential — a factory the consumer wrote closes over its own
 *     (spec §4.6.2).
 *
 * `maxBatchSize` is on every arm because `resolveEmbedder` composes chunking
 * and retry onto whatever it constructs.
 */
export type EmbedderResolution =
  | {
      provider: 'openai';
      model: string;
      credential: IApiKeyCredential;
      url?: string;
      maxBatchSize?: number;
      factory?: never;
    }
  | {
      provider: 'sap-ai-core' | 'sap-aicore';
      model: string;
      credential: IBearerCredential;
      apiBaseUrl: string;
      resourceGroup?: string;
      scenario?: 'orchestration' | 'foundation-models';
      /**
       * Which half of an asymmetric model this instance is: `document` embeds
       * stored text, `query` search text. Unset, no input type is sent.
       */
      inputType?: 'document' | 'query';
      maxBatchSize?: number;
      factory?: never;
    }
  | {
      /** Omitted means ollama — the default this function has always had. */
      provider?: 'ollama';
      model: string;
      url?: string;
      maxBatchSize?: number;
      credential?: never;
      factory?: never;
    }
  | {
      factory: string;
      url?: string;
      model?: string;
      timeoutMs?: number;
      maxBatchSize?: number;
      provider?: never;
      credential?: never;
    };

/** The arms this package constructs itself. */
export type BuiltInEmbedderResolution = Exclude<
  EmbedderResolution,
  { factory: string }
>;

const OPENAI = '@mcp-abap-adt/openai-embedder';
const OLLAMA = '@mcp-abap-adt/ollama-embedder';
const SAP_AI_CORE = '@mcp-abap-adt/sap-aicore-embedder';

/**
 * Modules loaded by `prefetchEmbedderFactories`, one typed slot per peer.
 * `resolveEmbedder` is synchronous — the SmartServer DI seam and the skill
 * host both type it `=> IEmbedder` — so the async import happens here, once,
 * and resolution reads a slot whose type came from a literal specifier.
 */
const loaded: {
  openai?: typeof import('@mcp-abap-adt/openai-embedder');
  ollama?: typeof import('@mcp-abap-adt/ollama-embedder');
  sapAiCore?: typeof import('@mcp-abap-adt/sap-aicore-embedder');
} = {};

/**
 * Load the peer packages for the names given. Call once at startup before
 * any `resolveEmbedder`; a missing peer throws `MissingProviderError` up
 * front. `names` arrive from configuration, so an unknown one is refused here.
 */
export async function prefetchEmbedderFactories(
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    switch (name) {
      case 'openai':
        loaded.openai ??= await importPeer(
          () => import('@mcp-abap-adt/openai-embedder'),
          OPENAI,
          name,
        );
        break;
      case 'ollama':
        loaded.ollama ??= await importPeer(
          () => import('@mcp-abap-adt/ollama-embedder'),
          OLLAMA,
          name,
        );
        break;
      case 'sap-ai-core':
      case 'sap-aicore':
        loaded.sapAiCore ??= await importPeer(
          () => import('@mcp-abap-adt/sap-aicore-embedder'),
          SAP_AI_CORE,
          name,
        );
        break;
      default:
        throw new MissingProviderError('(unknown)', name);
    }
  }
}

function prefetchedOrThrow<T>(
  mod: T | undefined,
  pkg: string,
  name: string,
): T {
  if (!mod) throw new MissingProviderError(pkg, name);
  return mod;
}

/**
 * Construct a built-in embedder. Every branch knows its class at compile time
 * and passes an object literal checked against that embedder's own config —
 * no name map, no cast constructor, and the `url` lands in the field each
 * embedder actually reads.
 */
export function constructBuiltInEmbedder(
  cfg: BuiltInEmbedderResolution,
): IEmbedder {
  switch (cfg.provider) {
    case 'openai': {
      const { OpenAiEmbedder } = prefetchedOrThrow(
        loaded.openai,
        OPENAI,
        'openai',
      );
      return new OpenAiEmbedder({
        credential: cfg.credential,
        model: cfg.model,
        ...(cfg.url !== undefined ? { baseURL: cfg.url } : {}),
      });
    }
    case 'sap-ai-core':
    case 'sap-aicore': {
      const { SapAiCoreEmbedder } = prefetchedOrThrow(
        loaded.sapAiCore,
        SAP_AI_CORE,
        cfg.provider,
      );
      return new SapAiCoreEmbedder({
        model: cfg.model,
        credential: cfg.credential,
        apiBaseUrl: cfg.apiBaseUrl,
        ...(cfg.resourceGroup !== undefined
          ? { resourceGroup: cfg.resourceGroup }
          : {}),
        ...(cfg.scenario !== undefined ? { scenario: cfg.scenario } : {}),
        ...(cfg.inputType !== undefined ? { inputType: cfg.inputType } : {}),
      });
    }
    case undefined:
    case 'ollama': {
      const { OllamaEmbedder } = prefetchedOrThrow(
        loaded.ollama,
        OLLAMA,
        'ollama',
      );
      return new OllamaEmbedder({
        model: cfg.model,
        ...(cfg.url !== undefined ? { ollamaUrl: cfg.url } : {}),
      });
    }
    default: {
      // Reachable only from an untyped source: the union is exhausted.
      const unreachable: never = cfg;
      throw new Error(
        `Unknown embedder provider "${String((unreachable as { provider?: unknown }).provider)}". ` +
          'Use one of: openai, ollama, sap-ai-core, sap-aicore — or register a factory ' +
          'and name it with `factory`.',
      );
    }
  }
}

/** Test-only: forget every prefetched module. */
export function _resetPrefetchedForTests(): void {
  loaded.openai = undefined;
  loaded.ollama = undefined;
  loaded.sapAiCore = undefined;
}
