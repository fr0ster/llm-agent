import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as lib from '@mcp-abap-adt/llm-agent-server-libs';

test('all six pipeline factories are exported from the package root', () => {
  for (const name of [
    'LinearFactory',
    'DagFactory',
    'CyclicFactory',
    'PlannedFactory',
    'DeepStepperFactory',
    'ControllerFactory',
  ]) {
    assert.equal(
      typeof (lib as Record<string, unknown>)[name],
      'function',
      `${name} exported from package root`,
    );
  }
});
