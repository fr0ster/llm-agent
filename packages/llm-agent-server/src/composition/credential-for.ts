import type {
  IApiKeyCredential,
  IBearerCredential,
  ISecretLoginCredential,
} from '@mcp-abap-adt/interfaces-auth';
import { staticApiKey, staticLogin } from '@mcp-abap-adt/llm-agent';
import { serviceKeyCredential } from '@mcp-abap-adt/sap-aicore-auth';

export type AnyCredential =
  | IApiKeyCredential
  | IBearerCredential
  | ISecretLoginCredential;

export type CredentialEntry = {
  /** Absent means this target needs none. Any of the three kinds is admissible:
   *  a store entry holds a secret-login, an LLM entry an api key or a bearer. */
  credential?: AnyCredential;
  /** SAP AI Core only; it travels with the credential from the same service key. */
  apiBaseUrl?: string;
};

export type CredentialFor = (ref: string) => CredentialEntry | undefined;

/**
 * What a section with no `credentialRef` resolves to — one per ROLE, because an
 * entry holds one credential and a store's kind need not match an embedder's
 * (§8 item 4). The root's choice, not a provider's. A deployment where they are
 * one account names that account explicitly in each section.
 */
export const DEFAULT_LLM_REF = 'LLM';
export const DEFAULT_STORE_REF = 'RAG_STORE';
export const DEFAULT_EMBEDDER_REF = 'RAG_EMBEDDER';
export const DEFAULT_DECISION_REF = 'DECISION';

/**
 * A function, not a map literal, so nothing is read or parsed until a ref asks —
 * and memoized, so the same ref always hands back the SAME credential object.
 * That identity is load-bearing: the 429 gate keys a quota bucket on it
 * (§4.6.5), so a fresh object per lookup would quietly stop the gate gating.
 */
export function memoizeCredentials(
  buildEntry: (ref: string) => CredentialEntry | undefined,
): CredentialFor {
  const entries = new Map<string, CredentialEntry | undefined>();
  return (ref) => {
    if (entries.has(ref)) return entries.get(ref);
    const entry = buildEntry(ref);
    entries.set(ref, entry);
    return entry;
  };
}

/**
 * The shipped app's registry (§8 item 4): a ref names a family of environment
 * variables.
 *   <REF>_API_KEY                → an api-key credential
 *   <REF>_SERVICE_KEY            → a SAP AI Core service key: bearer + apiBaseUrl
 *   <REF>_USER + <REF>_PASSWORD  → a secret-login credential
 * None set → no entry. More than one set → refused: an entry holds ONE
 * credential. A rule rather than a switch, so it serves every deployment; a
 * consumer with its own composition root passes its own `buildEntry` to
 * `memoizeCredentials`.
 */
export function envCredentialEntries(
  env: NodeJS.ProcessEnv,
): (ref: string) => CredentialEntry | undefined {
  return (ref) => {
    const apiKey = env[`${ref}_API_KEY`];
    const serviceKey = env[`${ref}_SERVICE_KEY`];
    const user = env[`${ref}_USER`];
    const password = env[`${ref}_PASSWORD`];
    const set = [
      apiKey ? `${ref}_API_KEY` : undefined,
      serviceKey ? `${ref}_SERVICE_KEY` : undefined,
      user || password ? `${ref}_USER/${ref}_PASSWORD` : undefined,
    ].filter((s): s is string => s !== undefined);
    if (set.length > 1) {
      throw new Error(
        `credentialRef '${ref}' is ambiguous: ${set.join(' and ')} are all set, ` +
          'but an entry holds one credential',
      );
    }
    if (apiKey) return { credential: staticApiKey(apiKey) };
    if (serviceKey) {
      const k = serviceKeyCredential(serviceKey);
      let apiBaseUrl: string;
      try {
        apiBaseUrl = k.apiBaseUrl;
      } catch (err) {
        // The parser cannot know which variable held the key; this rule does.
        throw new Error(`${ref}_SERVICE_KEY: ${(err as Error).message}`);
      }
      return { credential: k.credential, apiBaseUrl };
    }
    if (user || password) {
      if (!user || !password) {
        throw new Error(
          `credentialRef '${ref}' needs both ${ref}_USER and ${ref}_PASSWORD`,
        );
      }
      return { credential: staticLogin(user, password) };
    }
    return undefined;
  };
}

/**
 * Before v27 the shipped app read one fixed variable, `AICORE_SERVICE_KEY`; now
 * a ref names the family (`LLM_SERVICE_KEY` for the default LLM). A deployment
 * that upgraded without renaming it fails with "got none", which does not say
 * why. Given only for THAT failure — the default LLM ref resolving to nothing —
 * because `AICORE_SERVICE_KEY` is still a valid variable for `credentialRef:
 * AICORE`, and a hint beside any other failure would be false.
 */
export function legacyEnvHint(
  env: NodeJS.ProcessEnv,
  failure: unknown,
): string | undefined {
  const message = failure instanceof Error ? failure.message : String(failure);
  const llmRefMissing =
    message.startsWith(`credentialRef '${DEFAULT_LLM_REF}' must hold`) &&
    message.endsWith('got none');
  if (!llmRefMissing || !env.AICORE_SERVICE_KEY) return undefined;
  return (
    `AICORE_SERVICE_KEY is set, but the default LLM reads ${DEFAULT_LLM_REF}_SERVICE_KEY ` +
    `since v27 — rename it, or name it with credentialRef: AICORE ` +
    '(see docs/MIGRATION-v27.md, item 4).'
  );
}
