/**
 * Shared YAML frontmatter parser for SKILL.md files.
 *
 * Handles `---` delimiters, Windows line endings, and missing frontmatter.
 */
import { parse as parseYaml } from 'yaml';
/**
 * Parse YAML frontmatter from a markdown string.
 * Returns the parsed metadata and the remaining body text.
 */
export function parseFrontmatter(content) {
    const normalized = content.replace(/\r\n/g, '\n');
    const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) {
        return { meta: {}, body: normalized.trim() };
    }
    const yamlStr = match[1];
    const body = match[2].trim();
    const meta = (parseYaml(yamlStr) ?? {});
    return { meta, body };
}
//# sourceMappingURL=parse-frontmatter.js.map