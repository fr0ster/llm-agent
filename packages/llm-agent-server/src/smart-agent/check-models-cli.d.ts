#!/usr/bin/env node
/**
 * llm-agent-check — Verify which SAP AI Core models actually respond.
 *
 * Usage:
 *   llm-agent-check                                    # check ALL models from SDK catalog
 *   llm-agent-check anthropic--claude-4.6-sonnet       # check one model
 *   llm-agent-check gpt-4o anthropic--claude-4.5-haiku # check specific models
 *   llm-agent-check --delay 5000                       # custom rate limit delay (ms)
 *
 * Sends a minimal chat request to each model and reports OK/FAIL.
 */
export {};
//# sourceMappingURL=check-models-cli.d.ts.map