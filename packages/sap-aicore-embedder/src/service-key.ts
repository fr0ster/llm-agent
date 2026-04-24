export interface ParsedServiceKey {
  clientId: string;
  clientSecret: string;
  /** Fully qualified token endpoint incl. `/oauth/token`. */
  tokenUrl: string;
  /** AI Core REST API base URL (no trailing slash). */
  apiBaseUrl: string;
}

interface RawServiceKey {
  clientid?: string;
  clientsecret?: string;
  url?: string;
  serviceurls?: { AI_API_URL?: string };
}

export function parseServiceKey(raw: string): ParsedServiceKey {
  let obj: RawServiceKey;
  try {
    obj = JSON.parse(raw) as RawServiceKey;
  } catch (err) {
    throw new Error(
      `AICORE_SERVICE_KEY is not valid JSON: ${(err as Error).message}`,
    );
  }

  const clientId = obj.clientid;
  const clientSecret = obj.clientsecret;
  const authUrl = obj.url;
  const apiBaseUrl = obj.serviceurls?.AI_API_URL;

  if (!clientId || !clientSecret || !authUrl || !apiBaseUrl) {
    throw new Error(
      'AICORE_SERVICE_KEY is missing required fields (clientid, clientsecret, url, serviceurls.AI_API_URL)',
    );
  }

  const trimmedAuth = authUrl.replace(/\/+$/, '');
  const tokenUrl = trimmedAuth.endsWith('/oauth/token')
    ? trimmedAuth
    : `${trimmedAuth}/oauth/token`;

  return {
    clientId,
    clientSecret,
    tokenUrl,
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
  };
}
