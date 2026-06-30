import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  IMcpClient,
  ISkill,
  ISkillManager,
  McpTool,
  RagResult,
  Result,
  SkillError,
} from '@mcp-abap-adt/llm-agent';
import { RagOrchestrator } from '../agent/rag-orchestrator.js';
import { NoopRequestLogger } from '../logger/noop-request-logger.js';
import type {
  IMcpToolRegistry,
  ToolRegistryResult,
} from '../mcp/tool-registry.js';
import { ToolAvailabilityRegistry } from '../policy/tool-availability-registry.js';
import {
  makeAssembler,
  makeCapturingMetrics,
  makeClassifier,
  makeLlm,
  makeQueryExpander,
  makeRag,
  makeReranker,
  makeSessionManager,
} from '../testing/index.js';
import { NoopTracer } from '../tracer/noop-tracer.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeToolRegistry(tools: McpTool[]): IMcpToolRegistry {
  const toolClientMap = new Map<string, IMcpClient>();
  return {
    async resolve(): Promise<ToolRegistryResult> {
      return { tools, toolClientMap };
    },
    async resolveActiveClients(): Promise<void> {},
    getActiveClients(): IMcpClient[] {
      // One dummy client so hasMcpClients is true.
      return [{} as IMcpClient];
    },
  };
}

function makeSkillManager(name: string, body: string): ISkillManager {
  const skill: ISkill = {
    name,
    description: `desc of ${name}`,
    meta: {},
    async getContent(): Promise<Result<string, SkillError>> {
      return { ok: true, value: body };
    },
    async listResources() {
      return { ok: true, value: [] };
    },
    async readResource() {
      return { ok: true, value: '' };
    },
  };
  return {
    async listSkills(): Promise<Result<ISkill[], SkillError>> {
      return { ok: true, value: [skill] };
    },
    async getSkill(): Promise<Result<ISkill | undefined, SkillError>> {
      return { ok: true, value: skill };
    },
    async matchSkills(): Promise<Result<ISkill[], SkillError>> {
      return { ok: true, value: [skill] };
    },
  };
}

const mcpTool = (name: string): McpTool => ({
  name,
  description: `Tool ${name}`,
  inputSchema: {},
});

function ragDocs(): RagResult[] {
  return [
    {
      text: 'Tool: GetProgram — read an ABAP program',
      metadata: { id: 'tool:GetProgram' },
      score: 0.9,
    },
    {
      text: 'Skill: my-skill — how to read programs',
      metadata: { id: 'skill:my-skill' },
      score: 0.8,
    },
  ];
}

function makeOrchestrator() {
  return new RagOrchestrator({
    mainLlm: makeLlm([]),
    helperLlm: undefined,
    classifier: makeClassifier([
      { type: 'action', text: 'read program', dependency: 'independent' },
    ]),
    config: { maxIterations: 5 },
    tracer: new NoopTracer(),
    metrics: makeCapturingMetrics(),
    reranker: makeReranker(),
    queryExpander: makeQueryExpander(),
    sessionManager: makeSessionManager(),
    toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
    mcpToolRegistry: makeToolRegistry([
      mcpTool('GetProgram'),
      mcpTool('GetInclude'),
    ]),
    requestLogger: new NoopRequestLogger(),
    ragStores: { kb: makeRag(ragDocs()) },
    embedder: undefined,
    assembler: makeAssembler([
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'read program' },
    ]),
    skillManager: makeSkillManager('my-skill', 'STEP 1: call GetProgram'),
    translateQueryStores: undefined,
  });
}

const opts: { opts: CallOptions | undefined } = { opts: undefined };

describe('RagOrchestrator.orchestrate()', () => {
  it('selects RAG-matched tools, injects the matched skill, and assembles context', async () => {
    const orch = makeOrchestrator();
    const rootSpan = new NoopTracer().startSpan('root', { traceId: 't' });

    const result = await orch.orchestrate('read program', {
      opts: opts.opts,
      rootSpan,
      sessionId: 'default',
      mode: 'hard',
      externalTools: [],
    });

    assert.ok(result.ok, 'orchestrate should succeed');
    const { retrieved, finalTools, skillContent, assembledMessages } =
      result.value;

    // RAG-matched MCP tool is selected (GetInclude is filtered out).
    assert.deepEqual(
      retrieved.tools.map((t) => t.name),
      ['GetProgram'],
    );
    assert.deepEqual(
      finalTools.map((t) => t.name),
      ['GetProgram'],
    );

    // The matched skill content is collected.
    assert.match(skillContent, /my-skill/);
    assert.match(skillContent, /STEP 1: call GetProgram/);

    // Skill content is injected into the assembled system message.
    const sys = assembledMessages.find((m) => m.role === 'system');
    assert.ok(sys, 'system message present');
    assert.match(sys.content as string, /## Active Skills/);
    assert.match(sys.content as string, /STEP 1: call GetProgram/);
  });
});
