/**
 * FileSystemSkillManager — discovers skills from configurable directories.
 *
 * The simplest skill manager variant — no vendor-specific logic.
 * Takes an array of directories to scan for skill subdirectories.
 */
import type { CallOptions, ISkill, ISkillManager, Result } from '@mcp-abap-adt/llm-agent';
import { SkillError } from '@mcp-abap-adt/llm-agent';
export declare class FileSystemSkillManager implements ISkillManager {
    private readonly dirs;
    private cache;
    constructor(dirs: string[]);
    listSkills(_options?: CallOptions): Promise<Result<ISkill[], SkillError>>;
    getSkill(name: string, options?: CallOptions): Promise<Result<ISkill | undefined, SkillError>>;
    matchSkills(text: string, options?: CallOptions): Promise<Result<ISkill[], SkillError>>;
}
//# sourceMappingURL=filesystem-skill-manager.d.ts.map