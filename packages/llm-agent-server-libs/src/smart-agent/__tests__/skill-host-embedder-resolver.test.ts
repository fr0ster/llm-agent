import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IEmbedder } from '@mcp-abap-adt/llm-agent';
import type { SmartServerEmbedderConfig } from '../rag-config.js';
import { skillHostEmbedderResolver } from '../skill-host-embedder-resolver.js';

const embedder = (): IEmbedder => ({ embed: async () => ({ vector: [1] }) });

describe('skillHostEmbedderResolver', () => {
  it("reusing the agent's embedders, each role gets its own half", () => {
    const reuse = { document: embedder(), query: embedder() };
    const resolve = skillHostEmbedderResolver({
      reuse,
      resolve: () => assert.fail('nothing is built when reusing'),
    });
    assert.equal(resolve({ inputType: 'document' }), reuse.document);
    assert.equal(resolve({ inputType: 'query' }), reuse.query);
  });

  it('a dedicated symmetric embedder is ONE instance for both roles', () => {
    let built = 0;
    const resolve = skillHostEmbedderResolver({
      resolve: () => {
        built++;
        return embedder();
      },
    });
    const a = resolve({ embedder: 'ollama', model: 'm', inputType: 'query' });
    const b = resolve({
      embedder: 'ollama',
      model: 'm',
      inputType: 'document',
    });
    assert.equal(a, b);
    assert.equal(built, 1);
  });

  it('a dedicated asymmetric embedder is built per half with its input type', () => {
    const asked: SmartServerEmbedderConfig[] = [];
    const resolve = skillHostEmbedderResolver({
      resolve: (section) => {
        asked.push(section);
        return embedder();
      },
    });
    for (const inputType of ['query', 'document'] as const) {
      resolve({
        embedder: 'sap-ai-core',
        model: 'nv',
        asymmetric: true,
        inputType,
      });
    }
    assert.deepEqual(
      asked.map((s) => (s.factory === undefined ? s.inputType : 'factory')),
      ['query', 'document'],
    );
  });
});
