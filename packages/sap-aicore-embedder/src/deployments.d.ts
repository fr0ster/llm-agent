export interface ResolveDeploymentOptions {
    apiBaseUrl: string;
    token: string;
    resourceGroup: string;
    model: string;
    /** Scenario id. Default: 'foundation-models'. */
    scenarioId?: string;
}
export declare function resolveDeploymentId(options: ResolveDeploymentOptions): Promise<string>;
//# sourceMappingURL=deployments.d.ts.map