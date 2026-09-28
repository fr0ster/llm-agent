import type {
  IApiKeyCredential,
  ISecretLoginCredential,
} from '@mcp-abap-adt/interfaces-auth';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import { symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import type { RagResolution } from '../rag-factories.js';

declare const embedder: IEmbedder;
declare const apiKey: IApiKeyCredential;
declare const login: ISecretLoginCredential;

// a login cannot authenticate Qdrant, and the compiler must be the one to say so.
// The whole literal must stay on one line: @ts-expect-error only covers the
// line immediately below it, and this union's error is reported on whichever
// property is wrong, not on the literal's opening brace.
// biome-ignore format: one line — see the @ts-expect-error note above
// @ts-expect-error — qdrant takes an api-key credential
const _wrongKind: RagResolution = { type: 'qdrant', embedder, collectionName: 'c', url: 'http://localhost:6333', credential: login };

// HANA has no anonymous login, so omitting it is a build error, not a connect-time throw
// biome-ignore format: one line — see the @ts-expect-error note above
// @ts-expect-error — hana-vector requires a credential
const _missing: RagResolution = { type: 'hana-vector', embedder, collectionName: 'c' };

// the fields Task B6 removed cannot come back through this door either
// biome-ignore format: one line — see the @ts-expect-error note above
// @ts-expect-error — apiKey is not a member of any arm
const _legacy: RagResolution = { type: 'qdrant', embedder, collectionName: 'c', url: 'http://localhost:6333', apiKey: 'k' };

// and the good cases must compile
const _ok: readonly RagResolution[] = [
  {
    type: 'qdrant',
    embedder: symmetricEmbedder(embedder),
    collectionName: 'c',
    url: 'http://localhost:6333',
    credential: apiKey,
  },
  {
    type: 'pg-vector',
    embedder: symmetricEmbedder(embedder),
    collectionName: 'c',
    host: 'db',
    credential: login,
  },
  {
    type: 'hana-vector',
    embedder: symmetricEmbedder(embedder),
    collectionName: 'c',
    host: 'h',
    credential: login,
  },
];

// referenced so noUnusedLocals stays quiet about the compile-time-only fixtures above
void _wrongKind;
void _missing;
void _legacy;
void _ok;
