/**
 * The keyword tokenizer both in-memory stores use — for records AND queries,
 * so the two sides always agree.
 *
 * - Splits on anything that is not an ASCII letter, digit or underscore, and
 *   lower-cases; one-character tokens are dropped.
 * - An identifier is split into its parts — camelCase / PascalCase (an acronym
 *   run ends before the next capitalised word: `GetXMLParser` → get, xml,
 *   parser) and snake_case — and the whole identifier is kept as well, so
 *   `ReadFunctionInclude` matches both "function include" and itself.
 *
 * No suffix normalisation (plural / -ing / -ed stemming): measured on the
 * tool-retrieval eval (scripts/rag-eval), even a plural-only rule lowered MRR
 * on the keyword-only and the Ollama-embedder in-memory configs.
 */
export function tokenizeSearchText(text: string): string[] {
  const out: string[] = [];
  for (const word of text.split(/[^A-Za-z0-9_]+/)) {
    if (word.length === 0) continue;
    const parts = word
      .split('_')
      .flatMap((p) =>
        p.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/),
      )
      .filter((p) => p.length > 0);
    if (parts.length > 1) {
      const whole = word.toLowerCase();
      if (whole.length > 1) out.push(whole);
    }
    for (const p of parts) {
      const t = p.toLowerCase();
      if (t.length > 1) out.push(t);
    }
  }
  return out;
}
