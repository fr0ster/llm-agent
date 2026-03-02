import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ConfigWatcher, type HotReloadableConfig } from '../config-watcher.js';

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
      'rag:\n  vectorWeight: 0.8\n  keywordWeight: 0.2\n',
    );
    try {
      const watcher = new ConfigWatcher(filePath, { debounceMs: 50 });
      const reloads: HotReloadableConfig[] = [];
      watcher.on('reload', (cfg: HotReloadableConfig) => reloads.push(cfg));
      watcher.start();

      await wait(100);
      fs.writeFileSync(
        filePath,
        'rag:\n  vectorWeight: 0.6\n  keywordWeight: 0.4\n',
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
        fs.writeFileSync(
          filePath,
          `agent:\n  maxIterations: ${i}\n`,
          'utf8',
        );
      }

      await wait(300);
      watcher.stop();

      // Should have debounced into 1-2 events (not 4)
      assert.ok(reloads.length <= 2, `Expected ≤ 2 reloads, got ${reloads.length}`);
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
      fs.writeFileSync(
        filePath,
        'agent:\n  maxIterations: 99\n',
        'utf8',
      );
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
});
