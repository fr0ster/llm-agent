import type { IToolPolicy, PolicyVerdict, ToolPolicyConfig } from './types.js';

export class ToolPolicyGuard implements IToolPolicy {
  private readonly allowSet: ReadonlySet<string> | null;
  private readonly denySet: ReadonlySet<string> | null;

  constructor(config?: ToolPolicyConfig) {
    if (config?.allowlist && config.allowlist.length > 0) {
      this.allowSet = new Set(config.allowlist);
      this.denySet = null;
    } else if (config?.denylist && config.denylist.length > 0) {
      this.allowSet = null;
      this.denySet = new Set(config.denylist);
    } else {
      this.allowSet = null;
      this.denySet = null;
    }
  }

  check(toolName: string): PolicyVerdict {
    if (this.allowSet !== null) {
      if (!this.allowSet.has(toolName)) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" is not in the allowlist`,
        };
      }
      return { allowed: true };
    }
    if (this.denySet !== null) {
      if (this.denySet.has(toolName)) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" is in the denylist`,
        };
      }
      return { allowed: true };
    }
    return { allowed: true };
  }
}
