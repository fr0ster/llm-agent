import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  declaredModes,
  extractCheckError,
  isModelFailed,
  isUnexpectedFailure,
  oneLine,
  planProbes,
} from './catalog.js';

const entry = (capabilities?: string[], isLatest = true) => ({
  model: 'm',
  versions: [{ name: '1', isLatest, capabilities }],
});

describe('declaredModes', () => {
  it('maps catalog capabilities to the chat / embed modes', () => {
    assert.deepEqual(declaredModes(entry(['embedding'])), {
      chat: false,
      embed: true,
    });
    assert.deepEqual(declaredModes(entry(['text-generation', 'reasoning'])), {
      chat: true,
      embed: false,
    });
    assert.deepEqual(declaredModes(entry(undefined)), {
      chat: false,
      embed: false,
    });
  });

  it('reads capabilities from the latest version', () => {
    const e = {
      model: 'm',
      versions: [
        { name: '1', isLatest: false, capabilities: ['text-generation'] },
        { name: '2', isLatest: true, capabilities: ['embedding'] },
      ],
    };
    assert.deepEqual(declaredModes(e), { chat: false, embed: true });
  });
});

describe('planProbes', () => {
  it('probes every requested mode, declared or not', () => {
    assert.deepEqual(planProbes(entry(['embedding']), ['chat', 'embed']), [
      { mode: 'chat', expected: false },
      { mode: 'embed', expected: true },
    ]);
  });

  it('honours a single requested mode', () => {
    assert.deepEqual(planProbes(entry(['embedding']), ['chat']), [
      { mode: 'chat', expected: false },
    ]);
  });

  it('has no expectation for a model missing from the catalog', () => {
    assert.deepEqual(planProbes(undefined, ['chat', 'embed']), [
      { mode: 'chat', expected: undefined },
      { mode: 'embed', expected: undefined },
    ]);
  });
});

describe('failure judgement', () => {
  it('an undeclared mode failing is expected, not a failure', () => {
    const o = { mode: 'chat' as const, expected: false, ok: false };
    assert.equal(isUnexpectedFailure(o), false);
    assert.equal(
      isModelFailed([o, { mode: 'embed', expected: true, ok: true }]),
      false,
    );
  });

  it('a declared mode failing fails the model', () => {
    const o = { mode: 'embed' as const, expected: true, ok: false };
    assert.equal(isUnexpectedFailure(o), true);
    assert.equal(isModelFailed([o]), true);
  });

  it('an unknown model fails only when no mode worked', () => {
    const chat = { mode: 'chat' as const, expected: undefined };
    const embed = { mode: 'embed' as const, expected: undefined };
    assert.equal(
      isModelFailed([
        { ...chat, ok: true },
        { ...embed, ok: false },
      ]),
      false,
    );
    assert.equal(
      isModelFailed([
        { ...chat, ok: false },
        { ...embed, ok: false },
      ]),
      true,
    );
  });
});

describe('oneLine', () => {
  it('collapses a multi-line reply', () => {
    assert.equal(oneLine('OK\n\nIf you have', 30), 'OK If you have');
  });
});

describe('extractCheckError', () => {
  it('surfaces the provider message from an orchestration error body', () => {
    const err = Object.assign(
      new Error('Request failed with status code 400'),
      {
        cause: {
          response: {
            data: {
              error: {
                message:
                  "400 - LLM Module: gpt-5 models don't support temperature=0",
              },
            },
          },
        },
      },
    );
    assert.equal(
      extractCheckError(err),
      "HTTP 400: LLM Module: gpt-5 models don't support temperature=0",
    );
  });

  it('reads the AI Core message a provider folds into its own message', () => {
    const err = new Error(
      'SAP AI SDK API error: Request failed with status code 400. — {"error":{"code":400,"message":"400 - LLM Module: o3 \\"x\\" rejected"}}',
    );
    assert.equal(
      extractCheckError(err),
      'HTTP 400: LLM Module: o3 "x" rejected',
    );
  });

  it('falls back to the status code when there is no body', () => {
    assert.equal(
      extractCheckError(new Error('Request failed with status code 503')),
      'HTTP 503',
    );
  });
});

describe('models:check flags', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const CLI = path.resolve(here, 'cli.ts');
  const run = (args: string[]) =>
    spawnSync('node', ['--import', 'tsx/esm', CLI, ...args], {
      encoding: 'utf8',
    });

  it('--version prints the package version without checking models', () => {
    const r = run(['--version']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^@mcp-abap-adt\/llm-agent-server@\d+\.\d+\.\d+/);
    assert.doesNotMatch(r.stdout, /Checking/);
  });

  it('rejects an unknown flag instead of running the full check', () => {
    const r = run(['--bogus']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--bogus/);
    assert.doesNotMatch(r.stdout, /Checking/);
  });
});
