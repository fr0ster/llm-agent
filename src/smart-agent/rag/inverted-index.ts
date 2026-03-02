/**
 * InvertedIndex — pre-built term index for O(1) BM25 document frequency lookups.
 *
 * Maintains term→document-frequency mapping and per-document lengths,
 * updated incrementally on upsert. Replaces the O(n) per-query DF scan
 * in VectorRag.bm25Score().
 */
export class InvertedIndex {
  /** term → number of documents containing the term */
  private termDf = new Map<string, number>();
  /** docId → number of tokens in that document */
  private docLengths = new Map<number, number>();
  /** Total token count across all documents */
  private totalTokens = 0;

  /** Register a new document's tokens. */
  add(docId: number, tokens: string[]): void {
    this.docLengths.set(docId, tokens.length);
    this.totalTokens += tokens.length;

    const uniqueTerms = new Set(tokens);
    for (const term of uniqueTerms) {
      this.termDf.set(term, (this.termDf.get(term) ?? 0) + 1);
    }
  }

  /** Update a document (e.g. dedup replacement). */
  update(docId: number, oldTokens: string[], newTokens: string[]): void {
    // Remove old contributions
    const oldLength = this.docLengths.get(docId) ?? 0;
    this.totalTokens -= oldLength;

    const oldUnique = new Set(oldTokens);
    for (const term of oldUnique) {
      const current = this.termDf.get(term) ?? 0;
      if (current <= 1) {
        this.termDf.delete(term);
      } else {
        this.termDf.set(term, current - 1);
      }
    }

    // Add new contributions
    this.docLengths.set(docId, newTokens.length);
    this.totalTokens += newTokens.length;

    const newUnique = new Set(newTokens);
    for (const term of newUnique) {
      this.termDf.set(term, (this.termDf.get(term) ?? 0) + 1);
    }
  }

  /** O(1) document frequency lookup for a term. */
  getDocFrequency(term: string): number {
    return this.termDf.get(term) ?? 0;
  }

  /** Pre-computed average document length. */
  get avgDocLength(): number {
    const count = this.docLengths.size;
    return count === 0 ? 0 : this.totalTokens / count;
  }

  /** Number of indexed documents. */
  get docCount(): number {
    return this.docLengths.size;
  }
}
