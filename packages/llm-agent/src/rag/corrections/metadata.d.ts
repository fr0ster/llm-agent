export type CorrectionTag =
  | 'verified'
  | 'deprecated'
  | 'superseded'
  | 'correction';
export interface CorrectionMetadata {
  canonicalKey: string;
  tags?: CorrectionTag[];
  sessionId?: string;
  supersededBy?: string;
  deprecatedAt?: number;
  deprecatedReason?: string;
}
export declare function validateCorrectionMetadata(
  meta: CorrectionMetadata,
): void;
export declare function deprecateMetadata(
  current: CorrectionMetadata,
  reason: string,
  nowSeconds?: number,
): CorrectionMetadata;
export declare function buildCorrectionMetadata(input: {
  predecessor: CorrectionMetadata;
  predecessorId: string;
  newEntryId: string;
  reason: string;
}): {
  predecessor: CorrectionMetadata;
  next: CorrectionMetadata;
};
export declare function filterActive<T>(
  items: readonly T[],
  getMeta: (item: T) => CorrectionMetadata | undefined,
  options?: {
    includeInactive?: boolean;
  },
): T[];
//# sourceMappingURL=metadata.d.ts.map
