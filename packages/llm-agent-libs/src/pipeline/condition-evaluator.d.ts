/**
 * Safe condition evaluator for pipeline `when` expressions.
 *
 * Evaluates simple dot-path property lookups against the pipeline context.
 * Does NOT use `eval()` — only supports a restricted expression language.
 *
 * ## Supported expressions
 *
 * | Expression                      | Meaning                                       |
 * |---------------------------------|-----------------------------------------------|
 * | `"shouldRetrieve"`              | Truthy check on `ctx.shouldRetrieve`           |
 * | `"config.classificationEnabled"`| Truthy check on `ctx.config.classificationEnabled` |
 * | `"!isAscii"`                    | Negated truthy check on `ctx.isAscii`          |
 * | `"ragResults.facts.length > 0"` | Comparison (>, <, >=, <=, ==, !=)              |
 * | `"a && b"`                      | Logical AND of two expressions                 |
 * | `"a || b"`                      | Logical OR of two expressions                  |
 *
 * ## Security
 *
 * - No arbitrary code execution.
 * - No function calls.
 * - Only reads properties from the provided context object.
 * - Unknown paths resolve to `undefined` (falsy).
 */
import type { PipelineContext } from './context.js';
/**
 * Evaluate a condition expression against the pipeline context.
 *
 * @param expr - Condition string from the YAML `when` field.
 * @param ctx  - Pipeline context providing the evaluation namespace.
 * @returns `true` if the condition is met, `false` otherwise.
 *          Returns `true` for `undefined` or empty expressions (no condition = always run).
 */
export declare function evaluateCondition(
  expr: string | undefined,
  ctx: PipelineContext,
): boolean;
//# sourceMappingURL=condition-evaluator.d.ts.map
