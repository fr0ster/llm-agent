import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import {
  HybridDispatch,
  SelfDispatch,
  SubAgentDispatch,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  resolveCoordinatorDispatch,
  resolveCoordinatorDispatchKind,
} from '../config.js';

const fakeLlm = {} as unknown as ILlm;

describe('resolveCoordinatorDispatchKind (default selection)', () => {
  it('defaults to hybrid when coordinator.dispatch is omitted', () => {
    assert.equal(resolveCoordinatorDispatchKind(undefined), 'hybrid');
  });

  it('honors an explicit dispatch kind', () => {
    assert.equal(resolveCoordinatorDispatchKind('subagent'), 'subagent');
  });
});

describe('resolveCoordinatorDispatch (factory)', () => {
  it('builds a HybridDispatch (subagent + self fallback) for "hybrid"', () => {
    assert.ok(
      resolveCoordinatorDispatch('hybrid', fakeLlm) instanceof HybridDispatch,
    );
  });

  it('builds a SubAgentDispatch for "subagent"', () => {
    assert.ok(
      resolveCoordinatorDispatch('subagent') instanceof SubAgentDispatch,
    );
  });

  it('builds a SelfDispatch for "self"', () => {
    assert.ok(
      resolveCoordinatorDispatch('self', fakeLlm) instanceof SelfDispatch,
    );
  });

  it('throws for "hybrid" without an LLM', () => {
    assert.throws(
      () => resolveCoordinatorDispatch('hybrid'),
      /requires a planner or main LLM/,
    );
  });
});
