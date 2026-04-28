import type { IToolPolicy, PolicyVerdict, ToolPolicyConfig } from './types.js';
export declare class ToolPolicyGuard implements IToolPolicy {
    private readonly allowSet;
    private readonly denySet;
    constructor(config?: ToolPolicyConfig);
    check(toolName: string): PolicyVerdict;
}
//# sourceMappingURL=tool-policy-guard.d.ts.map