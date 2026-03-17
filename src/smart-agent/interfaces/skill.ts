/**
 * Skill interfaces — first-class skill support for the SmartAgent pipeline.
 *
 * Skills (as defined by the Agent Skills open standard) are reusable
 * instruction packages (SKILL.md + supporting files) that extend agent
 * capabilities by injecting context into the system prompt.
 *
 * Skills complement MCP tools: tools provide actions, skills provide
 * instructions and context.
 */

import type { CallOptions, Result, SkillError } from './types.js';

// ---------------------------------------------------------------------------
// Skill metadata
// ---------------------------------------------------------------------------

export interface ISkillMeta {
  name: string;
  description: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
  model?: string;
  context?: 'inline' | 'fork';
  argumentHint?: string;
  /** Vendor-specific extensions (hooks, agent, etc.). */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Skill resource
// ---------------------------------------------------------------------------

export interface ISkillResource {
  path: string;
}

// ---------------------------------------------------------------------------
// ISkill
// ---------------------------------------------------------------------------

/**
 * A single skill backed by a SKILL.md file and optional supporting resources.
 */
export interface ISkill {
  readonly name: string;
  readonly description: string;
  readonly meta: ISkillMeta;

  /**
   * Return the skill body with `$ARGUMENTS` and `$CLAUDE_SKILL_DIR`
   * placeholders substituted.
   */
  getContent(
    args?: string,
    options?: CallOptions,
  ): Promise<Result<string, SkillError>>;

  /** List supporting resource files (excludes SKILL.md). */
  listResources(
    options?: CallOptions,
  ): Promise<Result<ISkillResource[], SkillError>>;

  /** Read a supporting resource by relative path. */
  readResource(
    path: string,
    options?: CallOptions,
  ): Promise<Result<string, SkillError>>;
}

// ---------------------------------------------------------------------------
// ISkillManager
// ---------------------------------------------------------------------------

/**
 * Manages discovery and lookup of skills from one or more sources.
 */
export interface ISkillManager {
  /** List all discovered skills. */
  listSkills(options?: CallOptions): Promise<Result<ISkill[], SkillError>>;

  /** Get a skill by exact name. */
  getSkill(
    name: string,
    options?: CallOptions,
  ): Promise<Result<ISkill | undefined, SkillError>>;

  /** Find skills whose name or description matches the query text (case-insensitive substring). */
  matchSkills(
    text: string,
    options?: CallOptions,
  ): Promise<Result<ISkill[], SkillError>>;
}
