/**
 * Gap tests for vectorizeSkills — RED until mcp/vectorize-mcp-tools.ts exists.
 *
 * These tests import directly from the new module path. They FAIL on the
 * missing module until step 2b creates it, confirming the surface is new.
 * After step 2b they turn GREEN, proving behavior preservation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ILogger,
  IRag,
  IRagBackendWriter,
  IRequestLogger,
  ISkillManager,
  LogEvent,
} from '@mcp-abap-adt/llm-agent';

// Import from the new module path (RED until 2b)
import { vectorizeSkills } from '../mcp/vectorize-mcp-tools.js';

// ---------------------------------------------------------------------------
// Helpers / stubs
// ---------------------------------------------------------------------------

interface LlmCallEntry {
  component: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  estimated: boolean;
  scope?: string;
  detail?: string;
}

class CapturingRequestLogger implements IRequestLogger {
  calls: LlmCallEntry[] = [];
  logLlmCall(entry: LlmCallEntry): void {
    this.calls.push(entry);
  }
}

class CapturingLogger implements ILogger {
  events: LogEvent[] = [];
  log(event: LogEvent): void {
    this.events.push(event);
  }
}

function makeSkillManager(
  skills: Array<{ name: string; description: string }>,
  ok = true,
): ISkillManager {
  return {
    listSkills: async () =>
      ok
        ? { ok: true as const, value: skills }
        : { ok: false as const, error: new Error('list failed') },
    getSkill: async () => ({
      ok: false as const,
      error: new Error('not impl'),
    }),
  } as unknown as ISkillManager;
}

function makeWriter(opts?: {
  failUpsert?: boolean;
}): IRagBackendWriter & { upsertCalls: Array<{ id: string; text: string }> } {
  const upsertCalls: Array<{ id: string; text: string }> = [];
  return {
    upsertCalls,
    async upsertRaw(id: string, text: string, _meta: object) {
      upsertCalls.push({ id, text });
      if (opts?.failUpsert)
        return { ok: false as const, error: new Error('write error') };
      return { ok: true as const, value: undefined };
    },
  } as unknown as IRagBackendWriter & {
    upsertCalls: Array<{ id: string; text: string }>;
  };
}

function makeRag(writer: IRagBackendWriter): IRag {
  return {
    query: async () => [],
    lookup: async () => undefined,
    writer: () => writer,
  } as unknown as IRag;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vectorizeSkills', () => {
  it('per-skill upsertRaw and estimated logLlmCall for each skill', async () => {
    const skills = [
      { name: 'skill-a', description: 'does a' },
      { name: 'skill-b', description: 'does b' },
    ];
    const writer = makeWriter();
    const rag = makeRag(writer);
    const reqLogger = new CapturingRequestLogger();
    const logger = new CapturingLogger();

    await vectorizeSkills(makeSkillManager(skills), rag, reqLogger, logger);

    // per-skill upsert with correct key and text
    assert.equal(writer.upsertCalls.length, 2);
    assert.ok(
      writer.upsertCalls.some(
        (c) => c.id === 'skill:skill-a' && c.text === 'Skill: skill-a\ndoes a',
      ),
    );
    assert.ok(
      writer.upsertCalls.some(
        (c) => c.id === 'skill:skill-b' && c.text === 'Skill: skill-b\ndoes b',
      ),
    );
    // per-skill logLlmCall
    assert.equal(reqLogger.calls.length, 2);
    assert.ok(reqLogger.calls.every((c) => c.estimated === true));
    assert.ok(reqLogger.calls.every((c) => c.detail === 'skills'));
    assert.ok(reqLogger.calls.every((c) => c.scope === 'initialization'));
    // no warnings
    assert.equal(logger.events.filter((e) => e.type === 'warning').length, 0);
  });

  it('!result.ok: upsertRaw returning {ok:false} emits Skill vectorization failed warning', async () => {
    const skills = [{ name: 'bad-skill', description: 'fails' }];
    const writer = makeWriter({ failUpsert: true });
    const rag = makeRag(writer);
    const reqLogger = new CapturingRequestLogger();
    const logger = new CapturingLogger();

    await vectorizeSkills(makeSkillManager(skills), rag, reqLogger, logger);

    const warnings = logger.events.filter((e) => e.type === 'warning');
    assert.ok(
      warnings.some((w) =>
        w.message.includes('Skill vectorization failed for "bad-skill"'),
      ),
      `expected failure warning, got: ${JSON.stringify(warnings)}`,
    );
    // no logLlmCall on failure
    assert.equal(reqLogger.calls.length, 0);
  });

  it('listSkills returning {ok:false} → no upserts', async () => {
    const writer = makeWriter();
    const rag = makeRag(writer);
    const reqLogger = new CapturingRequestLogger();
    const logger = new CapturingLogger();

    await vectorizeSkills(makeSkillManager([], false), rag, reqLogger, logger);

    assert.equal(writer.upsertCalls.length, 0);
    assert.equal(reqLogger.calls.length, 0);
  });
});
