export interface ResolveDeploymentOptions {
  apiBaseUrl: string;
  token: string;
  resourceGroup: string;
  model: string;
  /** Scenario id. Default: 'foundation-models'. */
  scenarioId?: string;
}

interface DeploymentResource {
  id?: string;
  details?: {
    resources?: {
      backend_details?: { model?: { name?: string } };
    };
  };
  // Some tenants put the model on the top-level resource
  model?: { name?: string };
}

interface DeploymentListResponse {
  resources?: DeploymentResource[];
}

function extractModelName(resource: DeploymentResource): string | undefined {
  return (
    resource.details?.resources?.backend_details?.model?.name ??
    resource.model?.name
  );
}

export async function resolveDeploymentId(
  options: ResolveDeploymentOptions,
): Promise<string> {
  const scenarioId = options.scenarioId ?? 'foundation-models';
  const url = `${options.apiBaseUrl}/v2/lm/deployments?scenarioId=${encodeURIComponent(scenarioId)}&status=RUNNING`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'AI-Resource-Group': options.resourceGroup,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `SAP AI Core deployment list failed: ${res.status} ${res.statusText} ${text}`,
    );
  }
  const body = (await res.json()) as DeploymentListResponse;
  const match = (body.resources ?? []).find(
    (r) => extractModelName(r) === options.model && typeof r.id === 'string',
  );
  if (!match?.id) {
    throw new Error(
      `No RUNNING deployment found for model "${options.model}" in scenario "${scenarioId}"`,
    );
  }
  return match.id;
}
