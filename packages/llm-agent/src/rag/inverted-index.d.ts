/**
 * InvertedIndex — pre-built term index for O(1) BM25 document frequency lookups.
 *
 * Maintains term→document-frequency mapping and per-document lengths,
 * updated incrementally on upsert. Replaces the O(n) per-query DF scan
 * in VectorRag.bm25Score().
 */
export declare class InvertedIndex {
    /** term → number of documents containing the term */
    private termDf;
    /** docId → number of tokens in that document */
    private docLengths;
    /** Total token count across all documents */
    private totalTokens;
    /** Register a new document's tokens. */
    add(docId: number, tokens: string[]): void;
    /** Update a document (e.g. dedup replacement). */
    update(docId: number, oldTokens: string[], newTokens: string[]): void;
    /** Remove a document's contribution from the index. */
    remove(docId: number, tokens: string[]): void;
    /** O(1) document frequency lookup for a term. */
    getDocFrequency(term: string): number;
    /** Pre-computed average document length. */
    get avgDocLength(): number;
    /** Number of indexed documents. */
    get docCount(): number;
    /** Remove all indexed terms and document lengths. */
    clear(): void;
}
//# sourceMappingURL=inverted-index.d.ts.map