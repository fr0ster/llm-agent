/**
 * Verifies that the tool-loop stream consumption handles mid-stream
 * reset chunks from RetryLlm.
 *
 * The test extracts the exact accumulation pattern used in ToolLoopHandler
 * to prove that reset chunks clear accumulated state.
 *
 * Related: issue #46 — SSE streaming fails after 2 tool-loop iterations
 * because reset chunks were not handled in the pipeline handler.
 */
export {};
//# sourceMappingURL=tool-loop-reset.test.d.ts.map
