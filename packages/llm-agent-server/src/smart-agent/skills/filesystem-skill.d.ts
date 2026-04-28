/**
 * FileSystemSkill — concrete ISkill backed by a directory on disk.
 *
 * The directory must contain a `SKILL.md` file with optional YAML frontmatter.
 * Supporting files (anything other than SKILL.md) are exposed as resources.
 */
import type { CallOptions, ISkill, ISkillMeta, ISkillResource, Result } from '@mcp-abap-adt/llm-agent';
import { SkillError } from '@mcp-abap-adt/llm-agent';
export declare class FileSystemSkill implements ISkill {
    private readonly dir;
    private readonly body;
    readonly name: string;
    readonly description: string;
    readonly meta: ISkillMeta;
    constructor(dir: string, body: string, meta: ISkillMeta);
    getContent(args?: string, _options?: CallOptions): Promise<Result<string, SkillError>>;
    listResources(_options?: CallOptions): Promise<Result<ISkillResource[], SkillError>>;
    readResource(path: string, _options?: CallOptions): Promise<Result<string, SkillError>>;
}
/**
 * Load a skill from a directory containing SKILL.md.
 * Returns undefined if SKILL.md doesn't exist.
 */
export declare function loadSkillFromDir(dir: string): Promise<FileSystemSkill | undefined>;
//# sourceMappingURL=filesystem-skill.d.ts.map