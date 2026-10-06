import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ConfigWatcher,
  type HotReloadableConfig,
  type HotReloadableInput,
} from '../config-watcher.js';

function tmpFile(content: string): { filePath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
  const filePath = path.join(dir, 'config.yaml');
  fs.writeFileSync(filePath, content, 'utf8');
  return {
    filePath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ConfigWatcher', () => {
  it('emits reload event when file changes', async () => {
    const { filePath, cleanup } = tmpFile(
      'agent:\n  maxIterations: 5\n  ragQueryK: 8\n',
    );
    try {
      const watcher = new ConfigWatcher(filePath, { debounceMs: 50 });
      const reloads: HotReloadableConfig[] = [];
      watcher.on('reload', (cfg: HotReloadableConfig) => reloads.push(cfg));
      watcher.start();

      // Modify the file
      await wait(100);
      fs.writeFileSync(
        filePath,
        'agent:\n  maxIterations: 20\n  ragQueryK: 15\n',
        'utf8',
      );

      // Wait for debounce + processing
      await wait(200);
      watcher.stop();

      assert.ok(reloads.length >= 1, 'Expected at least 1 reload event');
      const last = reloads[reloads.length - 1];
      assert.equal(last.maxIterations, 20);
      assert.equal(last.ragQueryK, 15);
    } finally {
      cleanup();
    }
  });

  it('extracts RAG weight config', async () => {
    const { filePath, cleanup } = tmpFile(
      'rag:\n  store:\n    type: in-memory\n    vectorWeight: 0.8\n    keywordWeight: 0.2\n',
    );
    try {
      const watcher = new ConfigWatcher(filePath, { debounceMs: 50 });
      const reloads: HotReloadableConfig[] = [];
      watcher.on('reload', (cfg: HotReloadableConfig) => reloads.push(cfg));
      watcher.start();

      await wait(100);
      fs.writeFileSync(
        filePath,
        'rag:\n  store:\n    type: in-memory\n    vectorWeight: 0.6\n    keywordWeight: 0.4\n',
        'utf8',
      );
      await wait(200);
      watcher.stop();

      assert.ok(reloads.length >= 1);
      const last = reloads[reloads.length - 1];
      assert.equal(last.vectorWeight, 0.6);
      assert.equal(last.keywordWeight, 0.4);
    } finally {
      cleanup();
    }
  });

  it('reads the weights only from an in-memory store, the one that applies them', async () => {
    const { filePath, cleanup } = tmpFile('agent:\n  maxIterations: 1\n');
    try {
      const watcher = new ConfigWatcher(filePath, { debounceMs: 50 });
      const reloads: HotReloadableConfig[] = [];
      watcher.on('reload', (cfg: HotReloadableConfig) => reloads.push(cfg));
      watcher.start();
      await wait(100);
      fs.writeFileSync(
        filePath,
        'rag:\n  store:\n    type: qdrant\n    vectorWeight: 0.6\n  vectorWeight: 0.5\n',
        'utf8',
      );
      await wait(200);
      watcher.stop();
      const last = reloads[reloads.length - 1];
      assert.ok(last);
      assert.equal(last.vectorWeight, undefined);
    } finally {
      cleanup();
    }
  });

  it('emits error on invalid YAML', async () => {
    const { filePath, cleanup } = tmpFile('valid: true\n');
    try {
      const watcher = new ConfigWatcher(filePath, { debounceMs: 50 });
      const errors: unknown[] = [];
      watcher.on('error', (err: unknown) => errors.push(err));
      watcher.start();

      await wait(100);
      fs.writeFileSync(filePath, '{{invalid yaml', 'utf8');
      await wait(200);
      watcher.stop();

      assert.ok(errors.length >= 1, 'Expected at least 1 error event');
    } finally {
      cleanup();
    }
  });

  it('debounces rapid changes into a single reload', async () => {
    const { filePath, cleanup } = tmpFile('agent:\n  maxIterations: 1\n');
    try {
      const watcher = new ConfigWatcher(filePath, { debounceMs: 100 });
      const reloads: HotReloadableConfig[] = [];
      watcher.on('reload', (cfg: HotReloadableConfig) => reloads.push(cfg));
      watcher.start();

      await wait(50);
      // Rapid-fire writes
      for (let i = 2; i <= 5; i++) {
        fs.writeFileSync(filePath, `agent:\n  maxIterations: ${i}\n`, 'utf8');
      }

      await wait(300);
      watcher.stop();

      // Should have debounced into 1-2 events (not 4)
      assert.ok(
        reloads.length <= 2,
        `Expected ≤ 2 reloads, got ${reloads.length}`,
      );
      // The last reload should have the final value
      if (reloads.length > 0) {
        const last = reloads[reloads.length - 1];
        assert.equal(last.maxIterations, 5);
      }
    } finally {
      cleanup();
    }
  });

  it('stop() prevents further events', async () => {
    const { filePath, cleanup } = tmpFile('agent:\n  maxIterations: 1\n');
    try {
      const watcher = new ConfigWatcher(filePath, { debounceMs: 50 });
      const reloads: HotReloadableConfig[] = [];
      watcher.on('reload', (cfg: HotReloadableConfig) => reloads.push(cfg));
      watcher.start();
      watcher.stop();

      await wait(100);
      fs.writeFileSync(filePath, 'agent:\n  maxIterations: 99\n', 'utf8');
      await wait(200);

      assert.equal(reloads.length, 0, 'No reloads after stop');
    } finally {
      cleanup();
    }
  });

  it('extracts prompts and circuitBreaker config', async () => {
    const yaml = [
      'prompts:',
      '  system: "You are helpful"',
      '  ragTranslate: "Translate query"',
      'circuitBreaker:',
      '  failureThreshold: 10',
      '  recoveryWindowMs: 60000',
      '',
    ].join('\n');
    const { filePath, cleanup } = tmpFile(yaml);
    try {
      const watcher = new ConfigWatcher(filePath, { debounceMs: 50 });
      const reloads: HotReloadableConfig[] = [];
      watcher.on('reload', (cfg: HotReloadableConfig) => reloads.push(cfg));
      watcher.start();

      await wait(100);
      fs.writeFileSync(filePath, yaml, 'utf8');
      await wait(200);
      watcher.stop();

      assert.ok(reloads.length >= 1);
      const last = reloads[reloads.length - 1];
      assert.equal(last.prompts?.system, 'You are helpful');
      assert.equal(last.prompts?.ragTranslate, 'Translate query');
      assert.equal(last.circuitBreaker?.failureThreshold, 10);
      assert.equal(last.circuitBreaker?.recoveryWindowMs, 60000);
    } finally {
      cleanup();
    }
  });
  it('passes the values as the file holds them — never coerced (spec D83)', async () => {
    const { filePath, cleanup } = tmpFile('agent:\n  maxIterations: 5\n');
    try {
      const watcher = new ConfigWatcher(filePath, { debounceMs: 50 });
      const reloads: HotReloadableInput[] = [];
      watcher.on('reload', (cfg: HotReloadableInput) => reloads.push(cfg));
      watcher.start();
      await wait(100);
      fs.writeFileSync(
        filePath,
        'agent:\n  maxIterations: oops\n  showReasoning: "no"\nlogDir: 7\n',
        'utf8',
      );
      await wait(200);
      watcher.stop();
      const last = reloads[reloads.length - 1];
      // 30.1.0: NaN, true and '7' — an invalid value made valid-looking.
      assert.equal(last.maxIterations, 'oops');
      assert.equal(last.showReasoning, 'no');
      assert.equal(last.logDir, 7);
    } finally {
      cleanup();
    }
  });

  it('applies the injected resolveDocument to the whole file before reading a field (spec D83 (8))', async () => {
    const { filePath, cleanup } = tmpFile('agent:\n  maxIterations: 5\n');
    try {
      const seen: unknown[] = [];
      const watcher = new ConfigWatcher(filePath, {
        debounceMs: 50,
        // The consumer's policy — here: every "${MAX}" becomes "7", and the store type is set.
        resolveDocument: (doc) => {
          seen.push(doc);
          return {
            agent: { maxIterations: '7' },
            rag: { store: { type: 'in-memory', vectorWeight: 0.4 } },
          };
        },
      });
      const reloads: HotReloadableInput[] = [];
      const errors: unknown[] = [];
      watcher.on('reload', (cfg: HotReloadableInput) => reloads.push(cfg));
      watcher.on('error', (err: unknown) => errors.push(err));
      watcher.start();
      await wait(100);
      fs.writeFileSync(filePath, 'agent:\n  maxIterations: ${MAX}\n', 'utf8');
      await wait(200);
      watcher.stop();
      // The resolver got the parsed file; the fields were read from what it returned.
      assert.deepEqual(seen[seen.length - 1], {
        agent: { maxIterations: '${MAX}' },
      });
      assert.deepEqual(reloads[reloads.length - 1], {
        maxIterations: '7',
        vectorWeight: 0.4,
      });
      assert.deepEqual(errors, []);
    } finally {
      cleanup();
    }
  });

  it('emits error when resolveDocument throws (spec D83 (8))', async () => {
    const { filePath, cleanup } = tmpFile('agent:\n  maxIterations: 5\n');
    try {
      const watcher = new ConfigWatcher(filePath, {
        debounceMs: 50,
        resolveDocument: () => {
          throw new Error('cannot resolve');
        },
      });
      const reloads: unknown[] = [];
      const errors: unknown[] = [];
      watcher.on('reload', (cfg: unknown) => reloads.push(cfg));
      watcher.on('error', (err: unknown) => errors.push(err));
      watcher.start();
      await wait(100);
      fs.writeFileSync(filePath, 'agent:\n  maxIterations: 6\n', 'utf8');
      await wait(200);
      watcher.stop();
      assert.deepEqual(reloads, []);
      assert.match(String(errors[errors.length - 1]), /cannot resolve/);
    } finally {
      cleanup();
    }
  });

  it('passes the whole resolved document as the second argument of reload (spec D83 (10))', async () => {
    const { filePath, cleanup } = tmpFile('agent:\n  maxIterations: 5\n');
    try {
      const watcher = new ConfigWatcher(filePath, {
        debounceMs: 50,
        resolveDocument: (doc) => ({
          ...(doc as Record<string, unknown>),
          llm: { model: 'm' },
        }),
      });
      const documents: unknown[] = [];
      watcher.on('reload', (_values: HotReloadableInput, document: unknown) =>
        documents.push(document),
      );
      watcher.start();
      await wait(100);
      fs.writeFileSync(
        filePath,
        'agent: broken\nmcp:\n  timeout: 5x\n',
        'utf8',
      );
      await wait(200);
      watcher.stop();
      // The resolver's result, whole — the sections no value was read from included
      // (the values of this file are `{}`: `agent` is not a mapping).
      assert.deepEqual(documents[documents.length - 1], {
        agent: 'broken',
        mcp: { timeout: '5x' },
        llm: { model: 'm' },
      });
    } finally {
      cleanup();
    }
  });
});
