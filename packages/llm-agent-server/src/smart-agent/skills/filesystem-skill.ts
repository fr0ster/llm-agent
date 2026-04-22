/**
 * FileSystemSkill — concrete ISkill backed by a directory on disk.
 *
 * The directory must contain a `SKILL.md` file with optional YAML frontmatter.
 * Supporting files (anything other than SKILL.md) are exposed as resources.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type {
  CallOptions,
  ISkill,
  ISkillMeta,
  ISkillResource,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { SkillError } from '@mcp-abap-adt/llm-agent';
import { parseFrontmatter } from '../utils/parse-frontmatter.js';

export class FileSystemSkill implements ISkill {
  readonly name: string;
  readonly description: string;
  readonly meta: ISkillMeta;

  constructor(
    private readonly dir: string,
    private readonly body: string,
    meta: ISkillMeta,
  ) {
    this.name = meta.name;
    this.description = meta.description;
    this.meta = meta;
  }

  async getContent(
    args?: string,
    _options?: CallOptions,
  ): Promise<Result<string, SkillError>> {
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

  async listResources(
    _options?: CallOptions,
  ): Promise<Result<ISkillResource[], SkillError>> {
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

  async readResource(
    path: string,
    _options?: CallOptions,
  ): Promise<Result<string, SkillError>> {
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
export async function loadSkillFromDir(
  dir: string,
): Promise<FileSystemSkill | undefined> {
  const skillPath = join(dir, 'SKILL.md');
  try {
    const raw = await readFile(skillPath, 'utf-8');
    const { meta, body } = parseFrontmatter<Record<string, unknown>>(raw);

    const name =
      typeof meta.name === 'string'
        ? meta.name
        : (dir.split('/').filter(Boolean).pop() ?? 'unknown');

    const description =
      typeof meta.description === 'string'
        ? meta.description
        : (body.split('\n')[0]?.slice(0, 120) ?? '');

    const skillMeta: ISkillMeta = {
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
async function collectFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

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
