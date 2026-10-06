import type { SmartAgentConfig } from '../agent.js';
import { SmartAgentBuilder } from '../builder.js';
import { HeuristicToolAvailabilityPolicy } from '../policy/tool-availability-policy.js';

// @ts-expect-error — removed (U8, migration line 74)
const c: SmartAgentConfig = { maxIterations: 1, toolUnavailableTtlMs: 1 };

new SmartAgentBuilder().withToolAvailabilityPolicy(
  new HeuristicToolAvailabilityPolicy({ ttlMs: 1 }),
);

// @ts-expect-error — the TTL is the policy's, required at construction
new HeuristicToolAvailabilityPolicy({});

export { c };
