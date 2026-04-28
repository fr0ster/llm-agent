/**
 * IPipeline interface and supporting types.
 *
 * A pipeline encapsulates the full request-processing lifecycle for a single
 * SmartAgent invocation. Callers construct a pipeline once (via initialize) and
 * then invoke execute() per request.
 *
 * The two-level architecture separates:
 *   - Builder  — global DI of long-lived dependencies
 *   - IPipeline — per-request orchestration
 */
export {};
//# sourceMappingURL=pipeline.js.map