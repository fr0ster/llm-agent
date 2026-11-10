import type { TestContext } from 'node:test';
import { testRagAccess } from '@mcp-abap-adt/llm-agent/testing/rag-access-testing';
import { SmartAgent, SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import { testCallOptions } from '../../../../llm-agent-libs/src/testing/index.js';

/** TODO(#304 Task 8): Replace this test boundary with the trusted server resolver. */
export function installTestRagIdentity(ctx: Pick<TestContext, 'mock'>): void {
  const build = SmartAgentBuilder.prototype.build;
  ctx.mock.method(
    SmartAgentBuilder.prototype,
    'build',
    function (this: SmartAgentBuilder) {
      this.withRagAccess(testRagAccess());
      return build.call(this);
    },
  );
  const stream = SmartAgent.prototype.streamProcess;
  ctx.mock.method(
    SmartAgent.prototype,
    'streamProcess',
    function (
      this: SmartAgent,
      input: Parameters<SmartAgent['streamProcess']>[0],
      options: Parameters<SmartAgent['streamProcess']>[1],
    ) {
      return stream.call(this, input, testCallOptions(options));
    },
  );
}
