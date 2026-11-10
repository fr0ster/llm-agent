import { SimpleRagRegistry } from '@mcp-abap-adt/llm-agent';
import { fixedCallerResolver } from '@mcp-abap-adt/llm-agent/testing/rag-access-testing';
import { SessionGraphFactory } from '@mcp-abap-adt/llm-agent-libs';
import { testRequestAccess } from '../../../../llm-agent-libs/src/testing/index.js';
import {
  type BuildAgentDeps,
  buildAgent,
  SmartServer,
  type SmartServerConfig,
} from '../smart-server.js';

/** Explicit identity for tests that do not exercise authentication. */
export class TestSmartServer extends SmartServer {
  constructor(config: Partial<SmartServerConfig>, deps: BuildAgentDeps) {
    super(
      {
        callerResolver: fixedCallerResolver({
          userId: 'test-user',
          isAdmin: false,
        }),
        ragAccess: testRequestAccess,
        ...config,
      },
      deps,
    );
  }
}

export function testBuildAgent(
  config: Partial<SmartServerConfig>,
  deps: BuildAgentDeps,
) {
  return buildAgent(
    {
      callerResolver: fixedCallerResolver({
        userId: 'test-user',
        isAdmin: false,
      }),
      ragAccess: testRequestAccess,
      ...config,
    },
    deps,
  );
}

/** Explicit session for route handlers exercised without the HTTP middleware. */
export async function testHttpSession(sessionId = 'test-session') {
  const caller = { sessionId, userId: 'test-user', isAdmin: false };
  const factory = new SessionGraphFactory({
    mcpClientFactory: () => [],
    toolsRag: undefined,
    ragRegistry: new SimpleRagRegistry(),
    buildAgent: async () => undefined,
  });
  return {
    sessionId,
    traceId: 'test-request',
    caller,
    graph: await factory.build(caller),
  };
}
