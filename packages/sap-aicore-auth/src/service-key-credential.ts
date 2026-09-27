import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import { parseServiceKey } from './service-key.js';
import { TokenProvider } from './token-provider.js';

/**
 * A service key holds OAuth client credentials AND an address. The credential is the
 * secret half; `apiBaseUrl` is not a credential (§4.6.3) and goes to the provider's
 * own config. Parsing is deferred so a deployment that never names this reference
 * does not need the key to be present or valid.
 */
export function serviceKeyCredential(raw: string): {
  credential: IBearerCredential;
  apiBaseUrl: string;
} {
  let provider: TokenProvider | undefined;
  const parsed = () => parseServiceKey(raw);
  return {
    credential: {
      kind: 'bearer',
      async token() {
        const { clientId, clientSecret, tokenUrl } = parsed();
        provider ??= new TokenProvider({ clientId, clientSecret, tokenUrl });
        return provider.getToken();
      },
    },
    get apiBaseUrl() {
      return parsed().apiBaseUrl;
    },
  };
}
