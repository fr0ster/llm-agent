import type { UsageInput, UsageRecord } from '../usage.js';

const common = { context: {}, outcome: 'ok' as const };
const physical = {
  operationId: 'op',
  physicalSeq: 0,
  outerAttempt: 0,
  providerAttempt: 0,
  granularity: 'request' as const,
  retriesVisible: true,
  provider: 'test',
  model: 'model',
  tokensSource: 'unknown' as const,
  durationMs: 1,
};
const inputs: UsageInput[] = [
  { ...common, ...physical, kind: 'llm.call', stream: false },
  {
    ...common,
    ...physical,
    kind: 'embedding.call',
    chunkPath: '',
    inputs: 3,
    inputChars: 9,
  },
  {
    ...common,
    kind: 'tool.call',
    tool: 'test',
    dispatched: true,
    embedded: false,
    transportOutcome: 'ok',
    durationMs: 1,
  },
  {
    ...common,
    kind: 'task',
    taskId: 't1',
    worker: 'executor',
    state: 'done',
    endKnown: true,
  },
  {
    ...common,
    kind: 'x.custom',
    values: { count: 1, label: 'test', flag: true },
    id: 'stable',
    at: 0,
  },
];
// @ts-expect-error Missing required kind fields.
const missing: UsageInput = { ...common, kind: 'llm.call' };
const wrong: UsageInput = {
  ...common,
  ...physical,
  kind: 'embedding.call',
  chunkPath: '',
  // @ts-expect-error Wrong kind field type.
  inputs: 'three',
  inputChars: 9,
};
const object: UsageInput = {
  ...common,
  kind: 'x.custom',
  // @ts-expect-error Extension values must be scalar.
  values: { nested: {} },
};
const schema: UsageInput = {
  ...common,
  kind: 'x.custom',
  values: {},
  // @ts-expect-error Producers cannot supply schema.
  schema: 1,
};
// @ts-expect-error Stored records require schema, id and at.
const stored: UsageRecord = inputs[0];
void [inputs, missing, wrong, object, schema, stored];
