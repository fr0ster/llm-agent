import type {
  IApiKeyCredential,
  IBearerCredential,
} from '@mcp-abap-adt/interfaces-auth';
import type { EmbedderResolution } from '../embedder-factories.js';

declare const apiKey: IApiKeyCredential;
declare const bearer: IBearerCredential;

// Each literal stays on ONE line: @ts-expect-error covers only the next line,
// and a union's error lands on whichever property is wrong (see rag-resolution.ts).

// biome-ignore format: one line — see the note above
// @ts-expect-error — openai takes an api-key credential, not a bearer one
const _wrongKind: EmbedderResolution = { provider: 'openai', model: 'm', credential: bearer };

// biome-ignore format: one line — see the note above
// @ts-expect-error — openai cannot work without a credential, so omitting it is a build error
const _missing: EmbedderResolution = { provider: 'openai', model: 'm' };

// biome-ignore format: one line — see the note above
// @ts-expect-error — sap-ai-core needs the address its credential is valid at
const _noAddress: EmbedderResolution = { provider: 'sap-ai-core', model: 'm', credential: bearer };

// biome-ignore format: one line — see the note above
// @ts-expect-error — ollama sends nothing on the wire, so a credential is a member nobody calls
const _pointless: EmbedderResolution = { provider: 'ollama', model: 'm', credential: apiKey };

// biome-ignore format: one line — see the note above
// @ts-expect-error — every built-in constructor requires a model; omitting it was a runtime throw
const _noModel: EmbedderResolution = { provider: 'ollama' };

// biome-ignore format: one line — see the note above
// @ts-expect-error — a consumer factory closes over its own credential; the framework carries none for it
const _carried: EmbedderResolution = { factory: 'mine', model: 'm', credential: apiKey };

// biome-ignore format: one line — see the note above
// @ts-expect-error — apiKey is not a member of any arm
const _legacy: EmbedderResolution = { provider: 'openai', model: 'm', credential: apiKey, apiKey: 'k' };

// and the good cases must compile
const _ok: readonly EmbedderResolution[] = [
  { provider: 'openai', model: 'text-embedding-3-small', credential: apiKey },
  {
    provider: 'openai',
    model: 'm',
    credential: apiKey,
    url: 'https://gw.example/v1',
  },
  {
    provider: 'sap-ai-core',
    model: 'text-embedding-3-small',
    credential: bearer,
    apiBaseUrl: 'https://api.ai.example',
    scenario: 'foundation-models',
  },
  {
    provider: 'sap-aicore',
    model: 'm',
    credential: bearer,
    apiBaseUrl: 'https://x',
  },
  { provider: 'ollama', model: 'bge-m3', url: 'http://localhost:11434' },
  { model: 'bge-m3' }, // provider omitted = ollama, the default this function always had
  { factory: 'mine', model: 'm', url: 'http://u', timeoutMs: 5 },
];

void _wrongKind;
void _missing;
void _noAddress;
void _pointless;
void _noModel;
void _carried;
void _legacy;
void _ok;
