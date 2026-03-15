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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a condition expression against the pipeline context.
 *
 * @param expr - Condition string from the YAML `when` field.
 * @param ctx  - Pipeline context providing the evaluation namespace.
 * @returns `true` if the condition is met, `false` otherwise.
 *          Returns `true` for `undefined` or empty expressions (no condition = always run).
 */
export function evaluateCondition(
  expr: string | undefined,
  ctx: PipelineContext,
): boolean {
  if (!expr || expr.trim() === '') return true;
  return evaluateExpression(expr.trim(), ctx);
}

// ---------------------------------------------------------------------------
// Expression evaluator
// ---------------------------------------------------------------------------

function evaluateExpression(expr: string, ctx: PipelineContext): boolean {
  // Handle logical OR (lowest precedence)
  if (expr.includes('||')) {
    return expr
      .split('||')
      .some((part) => evaluateExpression(part.trim(), ctx));
  }

  // Handle logical AND
  if (expr.includes('&&')) {
    return expr
      .split('&&')
      .every((part) => evaluateExpression(part.trim(), ctx));
  }

  // Handle negation
  if (expr.startsWith('!')) {
    return !evaluateExpression(expr.slice(1).trim(), ctx);
  }

  // Handle comparison operators
  const compMatch = expr.match(/^(.+?)\s*(>=|<=|!=|==|>|<)\s*(.+)$/);
  if (compMatch) {
    const left = resolveValue(compMatch[1].trim(), ctx);
    const op = compMatch[2];
    const right = resolveValue(compMatch[3].trim(), ctx);
    return compare(left, op, right);
  }

  // Simple truthy check on a dot-path
  return Boolean(resolveValue(expr, ctx));
}

// ---------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a value from the pipeline context or parse as a literal.
 *
 * Supported values:
 * - Dot-path: `"shouldRetrieve"`, `"config.ragQueryK"`, `"ragResults.facts.length"`
 * - Numeric literal: `"10"`, `"0.5"`
 * - String literal: `"'hard'"`, `"'smart'"`
 * - Boolean literal: `"true"`, `"false"`
 */
function resolveValue(token: string, ctx: PipelineContext): unknown {
  // Boolean literals
  if (token === 'true') return true;
  if (token === 'false') return false;

  // Numeric literals
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);

  // String literals (single or double quoted)
  const strMatch = token.match(/^['"](.*)['"]$/);
  if (strMatch) return strMatch[1];

  // Dot-path lookup on context
  return resolvePath(token, ctx);
}

/**
 * Resolve a dot-separated path against the pipeline context.
 *
 * The lookup namespace is flat — the path starts from the PipelineContext root.
 * Examples: `"shouldRetrieve"` → `ctx.shouldRetrieve`,
 *           `"config.mode"` → `ctx.config.mode`,
 *           `"ragResults.facts.length"` → `ctx.ragResults.facts.length`
 */
function resolvePath(path: string, ctx: PipelineContext): unknown {
  const parts = path.split('.');
  let current: unknown = ctx;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compare(left: unknown, op: string, right: unknown): boolean {
  const l = typeof left === 'string' ? left : Number(left);
  const r = typeof right === 'string' ? right : Number(right);

  switch (op) {
    case '==':
      return l === r;
    case '!=':
      return l !== r;
    case '>':
      return l > r;
    case '<':
      return l < r;
    case '>=':
      return l >= r;
    case '<=':
      return l <= r;
    default:
      return false;
  }
}
