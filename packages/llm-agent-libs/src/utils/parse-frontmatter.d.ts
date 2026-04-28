/**
 * Shared YAML frontmatter parser for SKILL.md files.
 *
 * Handles `---` delimiters, Windows line endings, and missing frontmatter.
 */
export interface FrontmatterResult<T = Record<string, unknown>> {
  meta: T;
  body: string;
}
/**
 * Parse YAML frontmatter from a markdown string.
 * Returns the parsed metadata and the remaining body text.
 */
export declare function parseFrontmatter<T = Record<string, unknown>>(
  content: string,
): FrontmatterResult<T>;
//# sourceMappingURL=parse-frontmatter.d.ts.map
