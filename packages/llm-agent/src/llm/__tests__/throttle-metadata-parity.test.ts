import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RagError } from '../../interfaces/types.js';
import { httpStatusOf, retryAfterSecondsOf } from '../throttle.js';

// Oracle copied from BaseLLMProvider at origin/main
// aac747e9b15129951149e9566c26a8a49a44978c. Only parameter types and cause/header
// narrowing are adapted; lookup order, parsing and the five-object limit match
// the baseline. Keep this independent of the shared production helpers.
function baselineRetryAfterSeconds(
  error: object | undefined,
): number | undefined {
  const raw = baselineHeaderOf(error, 'retry-after')?.trim();
  if (raw === undefined || raw === '') return undefined;

  const seconds = Number(raw);
  if (!Number.isNaN(seconds)) {
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
  }

  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, (when - Date.now()) / 1000);
  return undefined;
}

function baselineHeaderOf(
  error: object | undefined,
  name: string,
): string | undefined {
  for (const current of baselineCauseChain(error)) {
    const response = 'response' in current ? current.response : undefined;
    const headers =
      response && typeof response === 'object' && 'headers' in response
        ? response.headers
        : undefined;
    if (headers === null || typeof headers !== 'object') continue;
    const get = 'get' in headers ? headers.get : undefined;
    if (typeof get === 'function') {
      const v = get.call(headers, name);
      if (v !== undefined && v !== null) return String(v);
      continue;
    }
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name && v !== undefined && v !== null)
        return String(v);
    }
  }
  return undefined;
}

function baselineHttpStatusOf(error: object | undefined): number | undefined {
  for (const current of baselineCauseChain(error)) {
    const response = 'response' in current ? current.response : undefined;
    const status =
      response && typeof response === 'object' && 'status' in response
        ? response.status
        : undefined;
    for (const candidate of [
      status,
      'status' in current ? current.status : undefined,
      'statusCode' in current ? current.statusCode : undefined,
    ]) {
      if (typeof candidate === 'number') return candidate;
    }
  }
  return undefined;
}

function* baselineCauseChain(error: object | undefined): Generator<object> {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object' || seen.has(current)) return;
    seen.add(current);
    yield current;
    current =
      'cause' in current &&
      typeof current.cause === 'object' &&
      current.cause !== null
        ? current.cause
        : undefined;
  }
}

interface ErrorRow {
  name: string;
  error: object | undefined;
}

const retryRows: ErrorRow[] = [];
const transportError = {
  response: { status: 429, headers: { 'retry-after': '60' } },
};
const headerValues = [
  '60',
  ' 1.25 ',
  '0',
  'Thu, 01 Jan 2026 00:00:03 GMT',
  'Wed, 31 Dec 2025 23:59:00 GMT',
  '',
  ' \t ',
  '-5',
  'Infinity',
  'NaN',
  'soon',
];
const topLevelFields = [
  { name: 'missing', fields: {} },
  { name: 'undefined', fields: { headers: undefined } },
  { name: 'null', fields: { headers: null } },
  { name: 'empty object', fields: { headers: {} } },
  { name: 'unrelated header', fields: { headers: { other: '90' } } },
  { name: 'empty Headers', fields: { headers: new Headers() } },
  { name: 'get misses', fields: { headers: { get: () => null } } },
  { name: 'blank header', fields: { headers: { 'retry-after': '' } } },
  { name: 'conflicting header', fields: { headers: { 'retry-after': '90' } } },
  { name: 'parsed zero', fields: { retryAfterSeconds: 0 } },
  { name: 'parsed seconds', fields: { retryAfterSeconds: 90 } },
  { name: 'invalid parsed seconds', fields: { retryAfterSeconds: -1 } },
];

for (const value of headerValues) {
  const collections = [
    { name: 'plain object', headers: { 'ReTrY-AfTeR': value } },
    { name: 'Headers', headers: new Headers({ 'retry-after': value }) },
    {
      name: 'get with receiver',
      headers: {
        value,
        get(name: string) {
          assert.equal(this.value, value);
          return name === 'retry-after' ? this.value : null;
        },
      },
    },
  ];
  for (const collection of collections) {
    for (const top of topLevelFields) {
      retryRows.push({
        name: `${collection.name}, value ${JSON.stringify(value)}, top ${top.name}, no cause`,
        error: {
          ...top.fields,
          response: { status: 429, headers: collection.headers },
        },
      });
      retryRows.push({
        name: `${collection.name}, value ${JSON.stringify(value)}, top ${top.name}`,
        error: {
          ...top.fields,
          response: { status: 429, headers: collection.headers },
          cause: transportError,
        },
      });
    }
  }
}

const absentResponseFields = [
  { name: 'missing response', fields: {} },
  { name: 'undefined response', fields: { response: undefined } },
  { name: 'null response', fields: { response: null } },
  { name: 'primitive response', fields: { response: '429' } },
  { name: 'missing headers', fields: { response: {} } },
  { name: 'undefined headers', fields: { response: { headers: undefined } } },
  { name: 'null headers', fields: { response: { headers: null } } },
  { name: 'primitive headers', fields: { response: { headers: '60' } } },
  { name: 'empty headers', fields: { response: { headers: {} } } },
  {
    name: 'unrelated header',
    fields: { response: { headers: { other: '60' } } },
  },
  {
    name: 'undefined header',
    fields: { response: { headers: { 'retry-after': undefined } } },
  },
  {
    name: 'null header',
    fields: { response: { headers: { 'retry-after': null } } },
  },
  { name: 'empty Headers', fields: { response: { headers: new Headers() } } },
  { name: 'get null', fields: { response: { headers: { get: () => null } } } },
  {
    name: 'get undefined',
    fields: { response: { headers: { get: () => undefined } } },
  },
  {
    name: 'get miss ignores own header',
    fields: { response: { headers: { get: () => null, 'retry-after': '90' } } },
  },
];
for (const row of absentResponseFields) {
  retryRows.push({ name: `${row.name}, no cause`, error: row.fields });
  retryRows.push({
    name: `${row.name}, cause fallback`,
    error: {
      ...row.fields,
      headers: {},
      retryAfterSeconds: 90,
      cause: transportError,
    },
  });
  retryRows.push({
    name: `${row.name}, two wrappers`,
    error: {
      ...row.fields,
      cause: { headers: undefined, cause: transportError },
    },
  });
}
for (const value of [0, 1.25, true, ['60']]) {
  retryRows.push({
    name: `plain header coercion ${JSON.stringify(value)}`,
    error: { response: { headers: { 'retry-after': value } } },
  });
  retryRows.push({
    name: `get header coercion ${JSON.stringify(value)}`,
    error: { response: { headers: { get: () => value } } },
  });
}
for (const cause of [undefined, null, '', 429, true]) {
  retryRows.push({
    name: `non-object cause ${String(cause)}`,
    error: { cause },
  });
}
retryRows.push({ name: 'undefined error', error: undefined });
retryRows.push({
  name: 'SDK Error wrapper',
  error: new Error('SDK', { cause: transportError }),
});
const cycle: { cause?: object } = {};
cycle.cause = { cause: cycle };
retryRows.push({ name: 'cycle', error: cycle });
retryRows.push({
  name: 'cycle with response',
  error: { response: transportError.response, cause: cycle },
});
let wrapped: object = transportError;
for (let depth = 1; depth <= 6; depth += 1) {
  retryRows.push({ name: `${depth} objects`, error: wrapped });
  wrapped = { cause: wrapped };
}

test('Retry-After differential table preserves origin/main response lookup and parsing', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-01-01T00:00:00Z'));
  for (const row of retryRows) {
    await t.test(row.name, () => {
      assert.equal(
        retryAfterSecondsOf(row.error),
        baselineRetryAfterSeconds(row.error),
      );
    });
  }
});

const statusRows: ErrorRow[] = [];
const statusValues = [
  undefined,
  null,
  '',
  '429',
  {},
  0,
  429,
  503,
  NaN,
  Infinity,
];
for (const responseStatus of statusValues) {
  for (const status of statusValues) {
    for (const statusCode of [undefined, '429', 429]) {
      statusRows.push({
        name: `response.status=${String(responseStatus)}, status=${String(status)}, statusCode=${String(statusCode)}`,
        error: {
          headers: undefined,
          response: { status: responseStatus, headers: {} },
          status,
          statusCode,
          cause: { response: { status: 502 }, status: 500, statusCode: 504 },
        },
      });
    }
  }
}
for (const row of absentResponseFields) {
  for (const fields of [{}, { status: 429 }, { statusCode: 429 }]) {
    statusRows.push({
      name: `${row.name}, fields ${JSON.stringify(fields)}`,
      error: { ...row.fields, ...fields, cause: { statusCode: 503 } },
    });
  }
}
test('status differential table preserves origin/main source and cause precedence', async (t) => {
  for (const row of [...retryRows, ...statusRows]) {
    await t.test(row.name, () => {
      assert.equal(httpStatusOf(row.error), baselineHttpStatusOf(row.error));
    });
  }
});

test('embedder RagError adds direct parsed metadata and headers without hiding transport headers', (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-01-01T00:00:00Z'));
  const rows = [
    { fields: { retryAfterSeconds: 0 }, expected: 0 },
    { fields: { retryAfterSeconds: 1.25 }, expected: 1.25 },
    { fields: { headers: { 'Retry-After': '60' } }, expected: 60 },
    { fields: { headers: new Headers({ 'Retry-After': '3' }) }, expected: 3 },
    { fields: { headers: { get: () => '4' } }, expected: 4 },
    {
      fields: {
        retryAfterSeconds: undefined,
        headers: new Headers({ 'Retry-After': '3' }),
      },
      expected: 3,
    },
    {
      fields: {
        retryAfterSeconds: 2,
        headers: new Headers({ 'Retry-After': '3' }),
      },
      expected: 2,
    },
    {
      fields: { headers: { 'retry-after': 'Thu, 01 Jan 2026 00:00:03 GMT' } },
      expected: 3,
    },
    { fields: { headers: undefined }, expected: undefined },
    { fields: { headers: {} }, expected: undefined },
    { fields: { headers: new Headers() }, expected: undefined },
    { fields: { headers: { 'retry-after': '' } }, expected: undefined },
    { fields: { retryAfterSeconds: -1 }, expected: undefined },
    { fields: { retryAfterSeconds: Infinity }, expected: undefined },
    { fields: { retryAfterSeconds: NaN }, expected: undefined },
    { fields: { retryAfterSeconds: '60' }, expected: undefined },
  ];
  for (const row of rows) {
    const error = Object.assign(new RagError('embed failed', 'EMBED_ERROR'), {
      status: 429,
      ...row.fields,
    });
    assert.equal(baselineRetryAfterSeconds(error), undefined);
    assert.equal(retryAfterSecondsOf(error), row.expected);
    assert.equal(
      retryAfterSecondsOf(new Error('SDK', { cause: error })),
      row.expected,
    );
    assert.equal(httpStatusOf(error), baselineHttpStatusOf(error));
    assert.equal(httpStatusOf(error), 429);
    const transport = Object.assign(new RagError('wrapped transport'), {
      ...row.fields,
      cause: transportError,
    });
    assert.equal(
      retryAfterSecondsOf(transport),
      baselineRetryAfterSeconds(transport),
    );
    assert.equal(retryAfterSecondsOf(transport), 60);
  }
});
