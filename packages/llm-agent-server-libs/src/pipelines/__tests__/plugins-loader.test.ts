import assert from 'node:assert/strict';
import { resolve as pathResolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PluginExports } from '@mcp-abap-adt/llm-agent';
import {
  emptyLoadedPlugins,
  mergePluginExports,
} from '@mcp-abap-adt/llm-agent-libs';

const here = fileURLToPath(new URL('.', import.meta.url));

describe('plugins: [specifier] dynamic-load merge path', () => {
  it('merges a module FULL PluginExports (pipelinePlugins AND embedderFactories)', async () => {
    // Resolve the fixture the same way smart-server.ts resolves a relative
    // `plugins:` specifier: absolute path against cwd → file URL → import.
    const abs = pathResolve(here, 'loader-fixture.mjs');
    const mod = (await import(pathToFileURL(abs).href)) as PluginExports;

    const plugins = emptyLoadedPlugins();
    const registered = mergePluginExports(plugins, mod, abs);

    assert.equal(registered, true, 'merge should report registrations');

    // pipelinePlugins from the module register…
    const pipeline = plugins.pipelinePlugins.get('demo-ext');
    assert.ok(pipeline, "pipelinePlugins must contain 'demo-ext'");
    assert.equal(pipeline?.name, 'demo-ext');

    // …AND embedderFactories from the SAME module register.
    assert.equal(
      typeof plugins.embedderFactories['demo-embedder'],
      'function',
      "embedderFactories must contain 'demo-embedder'",
    );
  });
});
