import { readFile } from 'node:fs/promises';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  process.stdout.write(`${String(response.status)}\n`);
  return response;
};

try {
  const keyPath = process.env.AICORE_SERVICE_KEY_PATH;
  if (!keyPath) throw new Error();
  const { serviceKeyCredential } = await import(
    '@mcp-abap-adt/sap-aicore-auth'
  );
  const { SapAiCoreFoundationProvider } = await import(
    '@mcp-abap-adt/sap-aicore-llm/foundation'
  );
  const connection = serviceKeyCredential(await readFile(keyPath, 'utf8'));
  for (const model of ['anthropic--claude-4.6-sonnet', 'gpt-6.1-sol']) {
    const provider = new SapAiCoreFoundationProvider({
      ...connection,
      model,
      resourceGroup: process.env.LLM_AGENT_RESOURCE_GROUP ?? 'cloud-llm-hub',
      maxTokens: 32,
    });
    let receivedText = false;
    for await (const chunk of provider.streamChat([
      { role: 'user', content: 'Reply OK.' },
    ])) {
      receivedText ||= Boolean(chunk.content);
    }
    if (!receivedText) throw new Error();
  }
} catch {
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
}
