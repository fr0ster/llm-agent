import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ILlm,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  Message,
  Result,
  Subprompt,
  SubpromptType,
} from '@mcp-abap-adt/llm-agent';
import { LlmClassifier } from '../llm-classifier.js';

// ---------------------------------------------------------------------------
// Golden corpus types
// ---------------------------------------------------------------------------

interface ClassifierCorpusEntry {
  /** User message input. */
  input: string;
  /** Expected subprompts from the classifier. */
  expected: { type: SubpromptType; text: string }[];
  /** Edge case tags for categorization. */
  tags: string[];
}

// ---------------------------------------------------------------------------
// Golden corpus
// ---------------------------------------------------------------------------

const GOLDEN_CORPUS: ClassifierCorpusEntry[] = [
  // --- Single-intent: action (2) ---
  {
    input: 'Read the source code of class ZCL_MY_CLASS',
    expected: [
      { type: 'action', text: 'Read the source code of class ZCL_MY_CLASS' },
    ],
    tags: ['single-intent', 'domain-specific'],
  },
  {
    input: 'Create a transport request for package ZDEV',
    expected: [
      { type: 'action', text: 'Create a transport request for package ZDEV' },
    ],
    tags: ['single-intent', 'domain-specific'],
  },

  // --- Single-intent: fact (2) ---
  {
    input: 'What is a CDS view in S/4HANA?',
    expected: [{ type: 'fact', text: 'What is a CDS view in S/4HANA?' }],
    tags: ['single-intent', 'domain-specific'],
  },
  {
    input: 'Explain the difference between BAdI and enhancement spots',
    expected: [
      {
        type: 'fact',
        text: 'Explain the difference between BAdI and enhancement spots',
      },
    ],
    tags: ['single-intent', 'domain-specific'],
  },

  // --- Single-intent: chat (2) ---
  {
    input: 'Hello, how are you today?',
    expected: [{ type: 'chat', text: 'Hello, how are you today?' }],
    tags: ['single-intent'],
  },
  {
    input: 'What is 25 times 4?',
    expected: [{ type: 'chat', text: 'What is 25 times 4?' }],
    tags: ['single-intent'],
  },

  // --- Single-intent: state (2) ---
  {
    input: 'I am working on system S4H client 100',
    expected: [
      { type: 'state', text: 'I am working on system S4H client 100' },
    ],
    tags: ['single-intent'],
  },
  {
    input: 'My current transport is S4HK900042',
    expected: [{ type: 'state', text: 'My current transport is S4HK900042' }],
    tags: ['single-intent'],
  },

  // --- Single-intent: feedback (2) ---
  {
    input: 'The last search returned wrong results, use exact name next time',
    expected: [
      {
        type: 'feedback',
        text: 'The last search returned wrong results, use exact name next time',
      },
    ],
    tags: ['single-intent'],
  },
  {
    input: 'That answer was incorrect, the table is T001 not T100',
    expected: [
      {
        type: 'feedback',
        text: 'That answer was incorrect, the table is T001 not T100',
      },
    ],
    tags: ['single-intent'],
  },

  // --- Multi-intent (5) ---
  {
    input: 'Read class ZCL_UTILS and then run ATC checks on it',
    expected: [
      { type: 'action', text: 'Read class ZCL_UTILS' },
      { type: 'action', text: 'Run ATC checks on ZCL_UTILS' },
    ],
    tags: ['multi-intent'],
  },
  {
    input: 'What is RFC? Also create a transport for ZPACKAGE.',
    expected: [
      { type: 'fact', text: 'What is RFC?' },
      { type: 'action', text: 'Create a transport for ZPACKAGE' },
    ],
    tags: ['multi-intent'],
  },
  {
    input: 'Hi! Can you search for class ZCL_DEMO?',
    expected: [
      { type: 'chat', text: 'Hi!' },
      { type: 'action', text: 'Search for class ZCL_DEMO' },
    ],
    tags: ['multi-intent'],
  },
  {
    input: 'I am on client 200. Please release transport S4HK900001.',
    expected: [
      { type: 'state', text: 'I am on client 200' },
      { type: 'action', text: 'Release transport S4HK900001' },
    ],
    tags: ['multi-intent'],
  },
  {
    input:
      'The previous result was wrong. Now get the source of ZCL_FIXED and explain what ABAP packages are.',
    expected: [
      { type: 'feedback', text: 'The previous result was wrong' },
      { type: 'action', text: 'Get the source of ZCL_FIXED' },
      { type: 'fact', text: 'Explain what ABAP packages are' },
    ],
    tags: ['multi-intent'],
  },

  // --- Edge cases (5+) ---
  {
    input: 'Show me the transport status, if it is modifiable then release it',
    expected: [
      {
        type: 'action',
        text: 'Show the transport status, if it is modifiable then release it',
      },
    ],
    tags: ['edge-case', 'conditional-fallback'],
  },
  {
    input: 'Run SE16 on T001 and compare with T001W data',
    expected: [
      { type: 'action', text: 'Run SE16 on T001' },
      { type: 'action', text: 'Compare with T001W data' },
    ],
    tags: ['edge-case', 'domain-specific'],
  },
  {
    input: '',
    expected: [],
    tags: ['edge-case', 'empty-input'],
  },
  {
    input: 'Thanks for the help!',
    expected: [{ type: 'chat', text: 'Thanks for the help!' }],
    tags: ['edge-case', 'ambiguous'],
  },
  {
    input: 'Remember that I always use strict mode for ATC',
    expected: [
      { type: 'state', text: 'Remember that I always use strict mode for ATC' },
    ],
    tags: ['edge-case', 'ambiguous'],
  },
  {
    input:
      'Search for ZCL_HELPER, get its source, check it with ATC, and create a transport',
    expected: [
      { type: 'action', text: 'Search for ZCL_HELPER' },
      { type: 'action', text: 'Get source of ZCL_HELPER' },
      { type: 'action', text: 'Check ZCL_HELPER with ATC' },
      { type: 'action', text: 'Create a transport' },
    ],
    tags: ['edge-case', 'multi-intent', 'sequential'],
  },
];

// ---------------------------------------------------------------------------
// Stub LLM — maps corpus input → pre-determined classifier output
// ---------------------------------------------------------------------------

function buildStubResponses(): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of GOLDEN_CORPUS) {
    const subprompts = entry.expected.map((e) => ({
      type: e.type,
      text: e.text,
      context: 'general',
      dependency: 'independent',
    }));
    map.set(entry.input, JSON.stringify(subprompts));
  }
  return map;
}

function makeStubLlm(responses: Map<string, string>): ILlm {
  return {
    async chat(messages: Message[]): Promise<Result<LlmResponse, LlmError>> {
      // The user message is the last one
      const userMsg = messages.find((m) => m.role === 'user');
      const input = userMsg?.content ?? '';
      const response = responses.get(input);
      if (response !== undefined) {
        return {
          ok: true,
          value: { content: response, finishReason: 'stop' },
        };
      }
      // Fallback: return empty array for unknown inputs
      return {
        ok: true,
        value: { content: '[]', finishReason: 'stop' },
      };
    },
    async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
      yield {
        ok: true,
        value: { content: '[]', finishReason: 'stop' },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

function typeAccuracy(
  results: Array<{
    actual: Subprompt[];
    expected: ClassifierCorpusEntry['expected'];
  }>,
): number {
  if (results.length === 0) return 1;
  let correct = 0;
  for (const { actual, expected } of results) {
    const actualTypes = actual.map((s) => s.type).sort();
    const expectedTypes = expected.map((e) => e.type).sort();
    if (
      actualTypes.length === expectedTypes.length &&
      actualTypes.every((t, i) => t === expectedTypes[i])
    ) {
      correct++;
    }
  }
  return correct / results.length;
}

function countAccuracy(
  results: Array<{
    actual: Subprompt[];
    expected: ClassifierCorpusEntry['expected'];
  }>,
): number {
  if (results.length === 0) return 1;
  let correct = 0;
  for (const { actual, expected } of results) {
    if (actual.length === expected.length) correct++;
  }
  return correct / results.length;
}

function perTypePrecisionRecall(
  results: Array<{
    actual: Subprompt[];
    expected: ClassifierCorpusEntry['expected'];
  }>,
  type: SubpromptType,
): { precision: number; recall: number } {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const { actual, expected } of results) {
    const actualCount = actual.filter((s) => s.type === type).length;
    const expectedCount = expected.filter((e) => e.type === type).length;
    const matched = Math.min(actualCount, expectedCount);

    truePositives += matched;
    falsePositives += Math.max(0, actualCount - expectedCount);
    falseNegatives += Math.max(0, expectedCount - actualCount);
  }

  const precision =
    truePositives + falsePositives > 0
      ? truePositives / (truePositives + falsePositives)
      : 1;
  const recall =
    truePositives + falseNegatives > 0
      ? truePositives / (truePositives + falseNegatives)
      : 1;

  return { precision, recall };
}

function multiIntentAccuracy(
  results: Array<{
    actual: Subprompt[];
    expected: ClassifierCorpusEntry['expected'];
  }>,
): number {
  if (results.length === 0) return 1;
  let correct = 0;
  for (const { actual, expected } of results) {
    if (expected.length <= 1) continue;
    const actualTypes = actual.map((s) => s.type).sort();
    const expectedTypes = expected.map((e) => e.type).sort();
    if (
      actualTypes.length === expectedTypes.length &&
      actualTypes.every((t, i) => t === expectedTypes[i])
    ) {
      correct++;
    }
  }
  const multiEntries = results.filter((r) => r.expected.length > 1);
  return multiEntries.length > 0 ? correct / multiEntries.length : 1;
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

async function runBenchmark(): Promise<
  Array<{ actual: Subprompt[]; expected: ClassifierCorpusEntry['expected'] }>
> {
  const stubResponses = buildStubResponses();
  const llm = makeStubLlm(stubResponses);
  const classifier = new LlmClassifier(llm, { enableCache: false });

  const results: Array<{
    actual: Subprompt[];
    expected: ClassifierCorpusEntry['expected'];
  }> = [];

  for (const entry of GOLDEN_CORPUS) {
    const r = await classifier.classify(entry.input);
    if (r.ok) {
      results.push({ actual: r.value, expected: entry.expected });
    } else {
      // Classification failed — treat as empty result
      results.push({ actual: [], expected: entry.expected });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Classifier Benchmark', () => {
  it('type accuracy >= 90% across golden corpus', async () => {
    const results = await runBenchmark();
    const accuracy = typeAccuracy(results);
    assert.ok(
      accuracy >= 0.9,
      `Type accuracy = ${(accuracy * 100).toFixed(1)}%, expected >= 90%`,
    );
  });

  it('count accuracy >= 85% across golden corpus', async () => {
    const results = await runBenchmark();
    const accuracy = countAccuracy(results);
    assert.ok(
      accuracy >= 0.85,
      `Count accuracy = ${(accuracy * 100).toFixed(1)}%, expected >= 85%`,
    );
  });

  it('per-type precision >= 80% for each SubpromptType', async () => {
    const results = await runBenchmark();
    const types: SubpromptType[] = [
      'action',
      'fact',
      'chat',
      'state',
      'feedback',
    ];

    for (const type of types) {
      const { precision } = perTypePrecisionRecall(results, type);
      assert.ok(
        precision >= 0.8,
        `Precision for "${type}" = ${(precision * 100).toFixed(1)}%, expected >= 80%`,
      );
    }
  });

  it('per-type recall >= 80% for each SubpromptType', async () => {
    const results = await runBenchmark();
    const types: SubpromptType[] = [
      'action',
      'fact',
      'chat',
      'state',
      'feedback',
    ];

    for (const type of types) {
      const { recall } = perTypePrecisionRecall(results, type);
      assert.ok(
        recall >= 0.8,
        `Recall for "${type}" = ${(recall * 100).toFixed(1)}%, expected >= 80%`,
      );
    }
  });

  it('multi-intent entries fully decomposed >= 80%', async () => {
    const results = await runBenchmark();
    const accuracy = multiIntentAccuracy(results);
    assert.ok(
      accuracy >= 0.8,
      `Multi-intent accuracy = ${(accuracy * 100).toFixed(1)}%, expected >= 80%`,
    );
  });

  it('empty input produces empty subprompts', async () => {
    const stubResponses = buildStubResponses();
    const llm = makeStubLlm(stubResponses);
    const classifier = new LlmClassifier(llm, { enableCache: false });
    const r = await classifier.classify('');
    assert.ok(r.ok);
    assert.deepEqual(r.value, []);
  });

  it('all single-intent entries produce exactly 1 subprompt', async () => {
    const results = await runBenchmark();
    const singleEntries = GOLDEN_CORPUS.map((entry, i) => ({
      entry,
      result: results[i],
    })).filter(({ entry }) => entry.tags.includes('single-intent'));

    for (const { entry, result } of singleEntries) {
      assert.equal(
        result.actual.length,
        1,
        `Single-intent "${entry.input}" produced ${result.actual.length} subprompts, expected 1`,
      );
    }
  });
});
