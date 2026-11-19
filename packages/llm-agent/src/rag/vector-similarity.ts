export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export function bestFragmentScore(
  query: number[],
  fragments: number[][],
  score: number,
): number {
  for (const fragment of fragments)
    score = Math.max(score, cosineSimilarity(query, fragment));
  return score;
}
