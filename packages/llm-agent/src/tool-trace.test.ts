import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolTraceEntry } from './interfaces/tool-trace.js';
import {
  normalizeToolTrace,
  recordToolInvocation,
  sanitizeTraceValue,
  ToolTraceCollector,
} from './tool-trace.js';

const entry = (
  sequence: number,
): Extract<ToolTraceEntry, { outcome: 'ok' }> => ({
  sequence,
  toolName: 'write',
  arguments: '{}',
  resultExcerpt: 'done',
  outcome: 'ok',
});

test('overlapping credentials are replaced longest first across fields', () => {
  const trace = normalizeToolTrace({
    entries: [
      {
        ...entry(1),
        arguments: '{"token":"ABCD","password":"ABCDEFGH"}',
        resultExcerpt: 'echo ABCDEFGH',
      },
    ],
    omittedCount: 0,
    complete: true,
  });
  assert.equal(trace.entries[0].resultExcerpt, 'echo [redacted]');
  assert.equal(
    sanitizeTraceValue(
      { token: 'ABCD', password: 'ABCDEFGH', echo: 'ABCDEFGH' },
      400,
    ),
    '{"token":"[redacted]","password":"[redacted]","echo":"[redacted]"}',
  );
});

test('JSON credentials embedded in text share their decoded string values', () => {
  for (const secret of [
    'A_B',
    'A_BC',
    'line\nbreak',
    'quote"value',
    'slash\\value',
  ]) {
    const trace = normalizeToolTrace({
      entries: [
        {
          ...entry(1),
          arguments: `Response: ${JSON.stringify({ token: secret }).replace('_', '\\u005f')}`,
          resultExcerpt: `echo ${secret}`,
        },
      ],
      omittedCount: 0,
      complete: true,
    });
    assert.equal(
      trace.entries[0].resultExcerpt,
      secret.length >= 4 ? 'echo [redacted]' : `echo ${secret}`,
    );
  }
});

test('removed header lines share values with other fields', () => {
  for (const header of [
    'Authorization',
    'Cookie',
    'Set-Cookie',
    'X-Api-Key',
    'X-Auth-Token',
    'X-Custom',
    'Host',
    'Accept',
    'Headers',
  ]) {
    for (const secret of ['HEADER_PRIVATE', 'cat']) {
      const trace = normalizeToolTrace({
        entries: [
          {
            ...entry(1),
            arguments: JSON.stringify({ command: `${header}: ${secret}` }),
            resultExcerpt: `echo ${secret}`,
            outcome: 'error',
            error: `rejected ${secret}`,
          },
        ],
        omittedCount: 0,
        complete: true,
      });
      const expected = secret.length >= 4 ? '[redacted]' : secret;
      assert.equal(trace.entries[0].resultExcerpt, `echo ${expected}`);
      assert.equal(trace.entries[0].error, `rejected ${expected}`);
      assert.deepEqual(normalizeToolTrace(trace), trace);
    }
  }
});

test('sanitization removes nested credentials, headers, known values and free text assignments', () => {
  const text = sanitizeTraceValue(
    {
      token: 'VERY_PRIVATE',
      echo: 'VERY_PRIVATE',
      nested: [
        { api_key: 'KEY', password: 'PW', headers: { other: 'HEADER' } },
      ],
      content: 'password=HIDDEN\nAuthorization: Bearer PRIVATE\nsecret: TOP',
    },
    2000,
  );
  assert.doesNotMatch(
    text,
    /VERY_PRIVATE|KEY|PW|HEADER|HIDDEN|PRIVATE|TOP|headers/,
  );
  assert.match(text, /redacted/);
  assert.equal(sanitizeTraceValue(text, 2000), text);
});

test('field bounds, serialization fallback and repeated normalization', () => {
  const cycle: { self?: object } = {};
  cycle.self = cycle;
  assert.equal(sanitizeTraceValue(cycle, 400), '[redacted]');
  assert.equal(sanitizeTraceValue({ value: BigInt(2) }, 400), '[redacted]');
  const trace = normalizeToolTrace({
    entries: [
      {
        ...entry(1),
        toolName: 'n'.repeat(500),
        arguments: JSON.stringify({ token: 'SECRET', text: 'a'.repeat(600) }),
        resultExcerpt: 'r'.repeat(600),
        outcome: 'error',
        error: 'e'.repeat(600),
      },
    ],
    omittedCount: 3,
    complete: true,
  });
  const first = trace.entries[0];
  assert.equal(first.toolName.length, 200);
  assert.equal(first.arguments.length, 400);
  assert.equal(first.resultExcerpt.length, 300);
  assert.equal(first.error?.length, 300);
  assert.doesNotMatch(JSON.stringify(trace), /SECRET/);
  assert.deepEqual(normalizeToolTrace(trace), trace);
});

test('quoted credential assignments redact multiline and unterminated values', () => {
  for (const quote of ['"', "'"]) {
    assert.equal(
      sanitizeTraceValue(`password=${quote}line1\nline2${quote} done`, 300),
      'password=[redacted] done',
    );
    assert.equal(
      sanitizeTraceValue(`password=${quote}line1\nline2`, 300),
      'password=[redacted]',
    );
  }
});

test('embedded argument JSON credentials are shared with results and errors', async () => {
  const args = { payload: '{"token":"NESTED_PRIVATE"}' };
  const collector = new ToolTraceCollector();
  await recordToolInvocation(
    (item: ToolTraceEntry): void => collector.observe(item),
    'write',
    args,
    async () => ({ ok: false }),
    () => ({
      failed: true,
      value: 'echo NESTED_PRIVATE',
      error: 'rejected NESTED_PRIVATE',
    }),
  );
  const recorded = collector.finalize().entries[0];
  assert.match(recorded.arguments, /redacted/);
  assert.equal(recorded.resultExcerpt, 'echo [redacted]');
  assert.equal(recorded.error, 'rejected [redacted]');
  assert.doesNotMatch(JSON.stringify(recorded), /NESTED_PRIVATE/);

  const normalized = normalizeToolTrace({
    entries: [
      {
        ...entry(1),
        arguments: JSON.stringify({
          payload: JSON.stringify([{ payload: JSON.stringify(args) }]),
        }),
        resultExcerpt: 'echo NESTED_PRIVATE',
        outcome: 'error',
        error: 'rejected NESTED_PRIVATE',
      },
    ],
    omittedCount: 0,
    complete: true,
  });
  assert.doesNotMatch(JSON.stringify(normalized), /NESTED_PRIVATE/);
  assert.equal(normalized.entries[0].resultExcerpt, 'echo [redacted]');
  assert.equal(normalized.entries[0].error, 'rejected [redacted]');
  assert.deepEqual(normalizeToolTrace(normalized), normalized);
});

test('bounded collector retains first and last calls, replaces settlement and ignores late changes', () => {
  const collector = new ToolTraceCollector();
  for (let sequence = 1; sequence <= 100; sequence++)
    collector.observe({ ...entry(sequence), outcome: 'unsettled' });
  for (let sequence = 100; sequence >= 1; sequence--)
    collector.observe(entry(sequence));
  const trace = collector.finalize();
  assert.deepEqual(
    trace.entries.map((item) => item.sequence),
    [
      ...Array.from({ length: 25 }, (_, i) => i + 1),
      ...Array.from({ length: 25 }, (_, i) => i + 76),
    ],
  );
  assert.equal(trace.omittedCount, 50);
  assert.equal(trace.complete, true);
  collector.observe(entry(101));
  assert.deepEqual(collector.snapshot(), trace);
  trace.entries[0].toolName = 'changed';
  assert.equal(collector.snapshot().entries[0].toolName, 'write');
});

test('an omitted pending call still makes the trace incomplete', () => {
  const collector = new ToolTraceCollector();
  for (let sequence = 1; sequence <= 60; sequence++)
    collector.observe({ ...entry(sequence), outcome: 'unsettled' });
  for (let sequence = 1; sequence <= 60; sequence++)
    if (sequence !== 30) collector.observe(entry(sequence));
  assert.equal(collector.finalize().complete, false);
});

test('dispatch order, observer isolation, error scrubbing and unsettled finalization', async () => {
  const collector = new ToolTraceCollector();
  const observed: ToolTraceEntry[] = [];
  const observer = (item: ToolTraceEntry): void => {
    observed.push(item);
    collector.observe(item);
  };
  let release = (): void => {};
  const first = recordToolInvocation(
    observer,
    'slow',
    { token: 'CREDENTIAL_VALUE' },
    () =>
      new Promise<{ ok: true }>((resolve) => {
        release = () => resolve({ ok: true });
      }),
    () => ({ failed: false, value: 'CREDENTIAL_VALUE', error: '' }),
  );
  await recordToolInvocation(
    observer,
    'fast',
    {},
    async () => ({ ok: true }),
    () => ({ failed: false, value: 'done', error: '' }),
  );
  const trace = collector.finalize();
  assert.equal(trace.complete, false);
  assert.deepEqual(
    trace.entries.map((item) => item.outcome),
    ['unsettled', 'ok'],
  );
  release();
  await first;
  assert.equal(trace.entries[0].outcome, 'unsettled');
  assert.equal(observed[3].resultExcerpt, '[redacted]');
  await assert.rejects(
    recordToolInvocation(
      observer,
      'throw',
      { secret: 'SECRET_VALUE' },
      async () => {
        throw new Error('SECRET_VALUE');
      },
      () => ({ failed: false, value: '', error: '' }),
    ),
  );
  assert.doesNotMatch(observed.at(-1)?.error ?? '', /SECRET_VALUE/);
  await recordToolInvocation(
    () => {
      throw new Error('observer');
    },
    'ok',
    {},
    async () => ({ ok: true }),
    () => ({ failed: false, value: 'ok', error: '' }),
  );
});

test('host normalization scrubs known argument credentials from results and errors', () => {
  const normalized = normalizeToolTrace({
    entries: [
      {
        ...entry(1),
        arguments: '{"api_key":"PRIVATE_VALUE"}',
        resultExcerpt: 'echo PRIVATE_VALUE',
        outcome: 'error',
        error: 'rejected PRIVATE_VALUE',
      },
    ],
    omittedCount: 0,
    complete: true,
  });
  assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE_VALUE/);
  assert.deepEqual(normalizeToolTrace(normalized), normalized);
});

test('structured results sanitize JSON embedded inside MCP text content', () => {
  const result = sanitizeTraceValue(
    {
      content: [
        {
          type: 'text',
          text: '{"headers":{"X-Key":"HEADER_VALUE"},"token":"TOKEN_VALUE","nested":[{"secret":"NESTED_VALUE"}]}',
        },
      ],
    },
    2000,
  );
  assert.doesNotMatch(result, /HEADER_VALUE|TOKEN_VALUE|NESTED_VALUE|headers/);
  assert.equal(sanitizeTraceValue(result, 2000), result);
});

test('authorization header values are scrubbed even when echoed without the scheme', () => {
  const normalized = normalizeToolTrace({
    entries: [
      {
        ...entry(1),
        arguments: '{"headers":{"Authorization":"Bearer PRIVATE_VALUE"}}',
        resultExcerpt: 'echo PRIVATE_VALUE',
      },
    ],
    complete: true,
    omittedCount: 0,
  });
  assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE_VALUE/);
  assert.equal(
    sanitizeTraceValue(
      'X-Custom: PRIVATE_VALUE\nContent-Type: PRIVATE_TYPE\ndone',
      300,
    ),
    '[redacted]\n[redacted]\ndone',
  );
});

test('free text credentials are shared across arguments, results and errors', async () => {
  const secret = 'FREE_TEXT_PRIVATE';
  const credentials = [
    `password=${secret}`,
    `api_key="${secret}"`,
    `secret='${secret}'`,
    `password="${secret}\ncontinued"`,
    `password='${secret}\ncontinued`,
    `Authorization: Bearer ${secret}`,
    `authorization=${secret}`,
    `Bearer ${secret}`,
    `Basic ${secret}`,
  ];
  for (const credential of credentials) {
    const value = credential.includes('continued')
      ? `${secret}\ncontinued`
      : secret;
    for (const source of ['arguments', 'result', 'error']) {
      const args = {
        command: source === 'arguments' ? credential : `echo ${value}`,
      };
      const result = source === 'result' ? credential : `echo ${value}`;
      const error = source === 'error' ? credential : `rejected ${value}`;
      const collector = new ToolTraceCollector();
      await recordToolInvocation(
        (item: ToolTraceEntry): void => collector.observe(item),
        'write',
        args,
        async () => ({ ok: false }),
        () => ({ failed: true, value: { content: [result] }, error }),
      );
      const recorded = collector.finalize().entries[0];
      assert.doesNotMatch(JSON.stringify(recorded), /FREE_TEXT_PRIVATE/);
      assert.match(recorded.arguments, /redacted/);
      assert.match(recorded.resultExcerpt, /redacted/);
      assert.match(recorded.error ?? '', /redacted/);

      const normalized = normalizeToolTrace({
        entries: [
          {
            ...entry(1),
            arguments: JSON.stringify(args),
            resultExcerpt: result,
            outcome: 'error',
            error,
          },
        ],
        omittedCount: 0,
        complete: true,
      });
      assert.doesNotMatch(JSON.stringify(normalized), /FREE_TEXT_PRIVATE/);
      assert.deepEqual(normalizeToolTrace(normalized), normalized);
    }
  }
});

test('short credentials do not redact common text in other fields', () => {
  const normalized = normalizeToolTrace({
    entries: [
      {
        ...entry(1),
        arguments: JSON.stringify({ command: 'password=cat', token: 'dog' }),
        resultExcerpt: 'cat dog',
        outcome: 'error',
        error: 'rejected cat dog',
      },
    ],
    omittedCount: 0,
    complete: true,
  });
  assert.match(normalized.entries[0].arguments, /redacted/);
  assert.equal(normalized.entries[0].resultExcerpt, 'cat dog');
  assert.equal(normalized.entries[0].error, 'rejected cat dog');
});
