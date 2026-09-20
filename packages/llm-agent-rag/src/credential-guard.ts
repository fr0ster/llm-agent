import type {
  IApiKeyCredential,
  IBearerCredential,
  ISecretLoginCredential,
} from '@mcp-abap-adt/interfaces-auth';

type AnyCredential =
  | IApiKeyCredential
  | IBearerCredential
  | ISecretLoginCredential;
type Kind = AnyCredential['kind'];

/** What each named target accepts. `kinds: []` means it authenticates with nothing. */
export interface CredentialRule {
  kinds: readonly Kind[];
  required: boolean;
}

/**
 * Embedder targets only. B6b adds `RAG_CREDENTIALS` to this same file for the
 * store side, once Task B6 gives the three stores their `credential`.
 */
export const EMBEDDER_CREDENTIALS: Record<string, CredentialRule> = {
  openai: { kinds: ['api-key'], required: true },
  ollama: { kinds: [], required: false },
  'sap-ai-core': { kinds: ['bearer'], required: true },
  'sap-aicore': { kinds: ['bearer'], required: true },
};

export function assertCredentialKind(
  target: string,
  credential: AnyCredential | undefined,
  rule: CredentialRule | undefined,
): void {
  if (!rule) return; // an unknown name is the caller's error to report, not ours
  if (!credential) {
    if (rule.required) {
      throw new Error(
        `${target} needs a credential: pass credential (${rule.kinds.join(' or ')}). ` +
          'Build one with staticApiKey / staticLogin, or resolve it in your composition root.',
      );
    }
    return;
  }
  if (rule.kinds.length === 0) {
    throw new Error(
      `${target} takes no credential — it sends none on the wire. Remove credential from its configuration.`,
    );
  }
  if (!rule.kinds.includes(credential.kind)) {
    throw new Error(
      `${target} needs a ${rule.kinds.join(' or ')} credential, got ${credential.kind}.`,
    );
  }
}
