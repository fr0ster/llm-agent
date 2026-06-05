// A fake external plugin package: exports both a pipelinePlugin and an
// embedderFactory. Used by plugins-loader.test.ts to prove a module's FULL
// PluginExports register via mergePluginExports.
export const pipelinePlugins = {
  'demo-ext': {
    name: 'demo-ext',
    parseConfig: (r) => r ?? {},
    build: async () => ({
      agent: {
        process: async () => ({}),
        streamProcess: async function* () {},
      },
      close: async () => {},
    }),
  },
};

export const embedderFactories = {
  'demo-embedder': () => ({ embed: async () => [] }),
};
