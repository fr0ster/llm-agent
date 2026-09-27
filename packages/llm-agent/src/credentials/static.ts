import type {
  IApiKeyCredential,
  ISecretLoginCredential,
} from '@mcp-abap-adt/interfaces-auth';

/**
 * A key that does not rotate is still a credential. This exists so no config needs
 * a second way to carry a secret: it is the one-line conversion that makes removing
 * the plain fields cheap for a consumer (§4.6.2).
 */
export function staticApiKey(secret: string): IApiKeyCredential {
  return { kind: 'api-key', secret: async () => secret };
}

export function staticLogin(
  principal: string,
  secret: string,
): ISecretLoginCredential {
  return { kind: 'secret-login', principal, secret: async () => secret };
}
