/**
 * The keyword tokenizer both in-memory stores use — for records AND queries,
 * so the two sides always agree.
 *
 * - Normalises input with NFKC, then splits on anything that is not a Unicode
 *   letter, number or underscore and lower-cases; one-character tokens are dropped.
 * - Removes apostrophes (U+0027, U+2019, U+02BC) between letters; other
 *   apostrophes are separators.
 * - An identifier is split into its parts — camelCase / PascalCase (an acronym
 *   run ends before the next capitalised word: `GetXMLParser` → get, xml,
 *   parser) and snake_case — and the whole identifier is kept as well, so
 *   `ReadFunctionInclude` matches both "function include" and itself.
 *   Case and digit boundaries use Unicode character classes.
 *
 * No suffix normalisation (plural / -ing / -ed stemming): measured on the
 * tool-retrieval eval (scripts/rag-eval), even a plural-only rule lowered MRR
 * on the keyword-only and the Ollama-embedder in-memory configs.
 */
export function tokenizeSearchText(text: string): string[] {
  const out: string[] = [];
  const normalized = text
    .normalize('NFKC')
    .replace(/(?<=\p{L})['’ʼ](?=\p{L})/gu, '')
    .replace(/['’ʼ]/gu, ' ');
  for (const word of normalized.split(/[^\p{L}\p{N}_]+/u)) {
    if (word.length === 0) continue;
    const parts = word
      .split('_')
      .flatMap((p) =>
        p.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u),
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
