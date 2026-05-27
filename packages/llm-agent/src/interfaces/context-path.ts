/** The hierarchical context unit: the current node/request + its ancestor intent
 *  path. NOT the whole chat, NOT just the last prompt. Travels into role inputs. */
export interface ContextPath {
  /** Root/parent intent. */
  objective?: string;
  /** Intent-shaping dialogue along the path. */
  clarifications: Array<{ question: string; answer: string }>;
  /** Reality facts gathered for THIS path via the oracle (needInfo round-trips). */
  oracleObservations: Array<{ query: string; answer: string }>;
}
