/**
 * FileSystemSkill — concrete ISkill backed by a directory on disk.
 *
 * The directory must contain a `SKILL.md` file with optional YAML frontmatter.
 * Supporting files (anything other than SKILL.md) are exposed as resources.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { SkillError } from '@mcp-abap-adt/llm-agent';
import { parseFrontmatter } from '../utils/parse-frontmatter.js';
export class FileSystemSkill {
  dir;
  body;
  name;
  description;
  meta;
  constructor(dir, body, meta) {
    this.dir = dir;
    this.body = body;
    this.name = meta.name;
    this.description = meta.description;
    this.meta = meta;
  }
  async getContent(args, _options) {
    try {
      let content = this.body;
      content = content.replace(/\$ARGUMENTS/g, args ?? '');
      content = content.replace(/\$CLAUDE_SKILL_DIR/g, this.dir);
      return { ok: true, value: content };
    } catch (err) {
      return {
        ok: false,
        error: new SkillError(
          `Failed to get content for skill ${this.name}: ${err}`,
        ),
      };
    }
  }
  async listResources(_options) {
    try {
      const resources = await collectFiles(this.dir);
      return {
        ok: true,
        value: resources
          .filter((f) => f !== 'SKILL.md')
          .map((f) => ({ path: f })),
      };
    } catch (err) {
      return {
        ok: false,
        error: new SkillError(
          `Failed to list resources for skill ${this.name}: ${err}`,
        ),
      };
    }
  }
  async readResource(path, _options) {
    try {
      const fullPath = join(this.dir, path);
      const content = await readFile(fullPath, 'utf-8');
      return { ok: true, value: content };
    } catch (err) {
      return {
        ok: false,
        error: new SkillError(
          `Failed to read resource ${path} for skill ${this.name}: ${err}`,
        ),
      };
    }
  }
}
/**
 * Load a skill from a directory containing SKILL.md.
 * Returns undefined if SKILL.md doesn't exist.
 */
export async function loadSkillFromDir(dir) {
  const skillPath = join(dir, 'SKILL.md');
  try {
    const raw = await readFile(skillPath, 'utf-8');
    const { meta, body } = parseFrontmatter(raw);
    const name =
      typeof meta.name === 'string'
        ? meta.name
        : (dir.split('/').filter(Boolean).pop() ?? 'unknown');
    const description =
      typeof meta.description === 'string'
        ? meta.description
        : (body.split('\n')[0]?.slice(0, 120) ?? '');
    const skillMeta = {
      ...meta,
      name,
      description,
    };
    return new FileSystemSkill(dir, body, skillMeta);
  } catch {
    return undefined;
  }
}
/** Recursively collect relative file paths under a directory. */
async function collectFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, base)));
    } else {
      files.push(relative(base, fullPath));
    }
  }
  return files;
}
//# sourceMappingURL=filesystem-skill.js.map
