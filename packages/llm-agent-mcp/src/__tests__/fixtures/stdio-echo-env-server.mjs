// Minimal real MCP stdio server used ONLY to pin
// `MCPClientWrapper.connect()`'s stdio branch (client.ts): it must actually
// deliver `config.env` to the spawned child, not just map it in a pure
// config object (that part is already covered by stdio-env.test.ts).
//
// The tool it registers is named `probe-<PROBE_ENV_VALUE>` — if the parent
// process's `env` reaches this child, the client's `listTools()` result
// carries that exact name back. No side channel needed: the MCP protocol
// itself is the proof.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const probe = process.env.PROBE_ENV_VALUE ?? 'missing';
const server = new McpServer({
  name: 'stdio-echo-env-probe',
  version: '0.0.1',
});
server.tool(`probe-${probe}`, async () => ({
  content: [{ type: 'text', text: probe }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
