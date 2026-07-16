import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefaultAuxiliaryMcpTools } from '../default-auxiliary-mcp-tools.js';
import { makeWaitTool } from '../wait-tool.js';

test('listTools returns the entry defs', async () => {
  const aux = new DefaultAuxiliaryMcpTools([makeWaitTool()]);
  const listed = await aux.listTools();
  assert.ok(listed.ok);
  assert.deepEqual(
    listed.value.map((d) => d.name),
    ['wait'],
  );
});

test('callTool routes by name to the entry handler', async () => {
  const aux = new DefaultAuxiliaryMcpTools([makeWaitTool()]);
  const r = await aux.callTool('wait', { seconds: 0 });
  assert.ok(r.ok);
  assert.equal(r.value.content, 'Waited 0s');
});

test('callTool on an unknown name returns a tool-level error (not thrown)', async () => {
  const aux = new DefaultAuxiliaryMcpTools([makeWaitTool()]);
  const r = await aux.callTool('nope', {});
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error.message, /unknown auxiliary tool/);
});

test('empty provider lists nothing and every name is unknown', async () => {
  const aux = new DefaultAuxiliaryMcpTools([]);
  const listed = await aux.listTools();
  assert.ok(listed.ok);
  assert.deepEqual(listed.value, []);
  const r = await aux.callTool('wait', { seconds: 0 });
  assert.equal(r.ok, false);
});
