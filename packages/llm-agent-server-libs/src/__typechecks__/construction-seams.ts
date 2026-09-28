import type { IEmbedder, ILlm, IRag } from '@mcp-abap-adt/llm-agent';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import type {
  MakeRagInput,
  SmartServerEmbedderConfig,
  SmartServerRagConfig,
} from '../smart-agent/rag-config.js';
import type {
  BuildAgentDeps,
  SmartServerLlmConfig,
} from '../smart-agent/smart-server.js';

declare const embedder: IEmbedder;
declare const llm: ILlm;
declare const rag: IRag;

// The three construction seams are required (§4.6.3 item 3, §4.6.4).
// @ts-expect-error — makeLlm, resolveEmbedder and makeRag are all missing
const _noSeams: BuildAgentDeps = {};

// biome-ignore format: one line — @ts-expect-error covers only the line below it
// @ts-expect-error — makeRag alone missing is still a build error
const _noMakeRag: BuildAgentDeps = { makeLlm: async () => llm, resolveEmbedder: () => embedder };

const _allSeams: BuildAgentDeps = {
  makeLlm: async () => llm,
  resolveEmbedder: () => embedder,
  makeRag: async () => rag,
};

// A secret has no place in serializable config; its account is named instead.
// biome-ignore format: one line — the error lands on the offending property
// @ts-expect-error — apiKey is not a member of SmartServerLlmConfig
const _llmSecret: SmartServerLlmConfig = { provider: 'openai', model: 'gpt-4o', apiKey: 'sk' };
const _llmRef: SmartServerLlmConfig = {
  provider: 'openai',
  credentialRef: 'OPENAI',
};

// The embedder sits on the arms that need one, so a vector store without it fails here.
// biome-ignore format: one line — the error lands on the offending property
// @ts-expect-error — a qdrant store needs an embedder
const _qdrantNoEmbedder: MakeRagInput = { store: { type: 'qdrant', url: 'http://q', collectionName: 'c' } };
const _keywordOnly: MakeRagInput = { store: { type: 'in-memory' } };
const _qdrant: MakeRagInput = {
  store: {
    type: 'qdrant',
    url: 'http://q',
    collectionName: 'c',
    credentialRef: 'QDRANT',
  },
  embedder: symmetricEmbedder(embedder),
};

// biome-ignore format: one line — the error lands on the offending property
// @ts-expect-error — password is not a store member; the account is named by credentialRef
const _pgSecret: SmartServerRagConfig = { store: { type: 'pg-vector', collectionName: 'c', password: 'pw' } };

// biome-ignore format: one line — the error lands on the offending property
// @ts-expect-error — the flat shape is gone: type belongs under store
const _flat: SmartServerRagConfig = { type: 'in-memory' };

// biome-ignore format: one line — the error lands on the offending property
// @ts-expect-error — the search knobs belong to the in-memory arm alone
const _qdrantWeights: SmartServerRagConfig = { store: { type: 'qdrant', url: 'http://q', collectionName: 'c', vectorWeight: 0.5 } };

// SAP AI Core's address travels with its credential entry, never in the section.
// biome-ignore format: one line — the error lands on the offending property
// @ts-expect-error — apiBaseUrl is not a member of either embedder arm
const _embedderAddress: SmartServerEmbedderConfig = { provider: 'sap-ai-core', model: 'm', apiBaseUrl: 'https://x' };

// A consumer factory closes over its own credential, so a ref on it is a build error.
// biome-ignore format: one line — the error lands on the offending property
// @ts-expect-error — the factory arm carries no credentialRef
const _factoryRef: SmartServerEmbedderConfig = { factory: 'mine', credentialRef: 'MINE' };

// biome-ignore format: one line — the error lands on the offending property
// @ts-expect-error — deepseek is no embedder; a custom one is named with factory
const _unknownProvider: SmartServerEmbedderConfig = { provider: 'deepseek', model: 'm' };

const _embedders: readonly SmartServerEmbedderConfig[] = [
  {
    provider: 'openai',
    model: 'text-embedding-3-small',
    credentialRef: 'OPENAI',
  },
  {
    provider: 'sap-ai-core',
    model: 'm',
    resourceGroup: 'default',
    scenario: 'foundation-models',
  },
  { provider: 'ollama', model: 'bge-m3', url: 'http://localhost:11434' },
  { factory: 'mine', model: 'm', maxBatchSize: 10 },
];

// referenced so noUnusedLocals stays quiet about the compile-time-only fixtures above
void _noSeams;
void _noMakeRag;
void _allSeams;
void _llmSecret;
void _llmRef;
void _qdrantNoEmbedder;
void _keywordOnly;
void _qdrant;
void _pgSecret;
void _flat;
void _qdrantWeights;
void _embedderAddress;
void _factoryRef;
void _unknownProvider;
void _embedders;
