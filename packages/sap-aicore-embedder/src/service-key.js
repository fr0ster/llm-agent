export function parseServiceKey(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`AICORE_SERVICE_KEY is not valid JSON: ${err.message}`);
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
//# sourceMappingURL=service-key.js.map
