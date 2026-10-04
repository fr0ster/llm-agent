import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyLoadedPlugins } from '@mcp-abap-adt/llm-agent-libs';
import { parse } from 'yaml';
import { resolveSmartServerConfig } from '../config.js';
import { unknownRetrievalKeyWarnings } from '../resolve-retrieval.js';
import {
  type BuildAgentDeps,
  SmartServer,
  type SmartServerConfig,
} from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

const YAML = `
llm:
  provider: openai
  model: gpt-4o
rag:
  store:
    type: in-memory
  retrieval:
    tool:
      strategy: embedding
    tools:
      strategy: embedding
    history:
      strategy: embedding
    session/x:
      strategy: embedding
    user/y:
      strategy: embedding
`;

const noPlugins = { load: async () => emptyLoadedPlugins() };

function configFrom(text: string, events: Array<Record<string, unknown>>) {
  return {
    ...resolveSmartServerConfig(
      {},
      parse(text),
      {},
      { skipProviderRuntimeChecks: true },
    ),
    port: 0,
    skipModelValidation: true,
    log: (e: Record<string, unknown>) => events.push(e),
  } as SmartServerConfig;
}

function keyWarningsOf(events: Array<Record<string, unknown>>): string[] {
  return events
    .filter((e) => e.event === 'config_warning')
    .map((e) => String(e.message))
    .filter((m) => m.includes('rag.retrieval.'));
}

describe('rag.retrieval key warning (§14.5)', () => {
  it('startup: warns once, for the key that names no store', async () => {
    const events: Array<Record<string, unknown>> = [];
    const server = new SmartServer(
      { ...configFrom(YAML, events), pluginLoader: noPlugins },
      { ...constructionSeams } as BuildAgentDeps,
    );
    const handle = await server.start();
    await handle.close();
    const warnings = keyWarningsOf(events);
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0], /rag\.retrieval\.tool /);
    assert.match(warnings[0], /known stores: history, tools\./);
  });

  it('a registered collection key is known; user/ and session/ are skipped', () => {
    const retrieval = {
      tool: {},
      tools: {},
      history: {},
      'session/x': {},
      'user/y': {},
      notes: {},
    };
    const warnings = unknownRetrievalKeyWarnings(retrieval, [
      'notes',
      'tools',
      'notes',
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /rag\.retrieval\.tool /);
    assert.match(warnings[0], /known stores: history, notes, tools\./);
    assert.deepEqual(unknownRetrievalKeyWarnings(undefined, []), []);
  });
});
