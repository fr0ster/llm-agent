export type QdrantCondition =
  | { key: string; match: { value: string | number | boolean } }
  | { key: string; range: { gt: number } }
  | { is_empty: { key: string } }
  | QdrantFilter;

export interface QdrantFilter {
  must?: QdrantCondition[];
  should?: QdrantCondition[];
  must_not?: QdrantCondition[];
}
