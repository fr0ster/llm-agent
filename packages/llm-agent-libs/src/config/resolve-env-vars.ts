/** Expand environment placeholders before validating startup or reloaded YAML. */
export function resolveEnvVars<T>(
  value: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([^}:]+)(?::-(.*?))?\}/g,
      (_match: string, name: string, fallback?: string) =>
        env[name] || fallback || '',
    ) as T;
  }
  if (Array.isArray(value)) {
    return (value as T[]).map((entry) => resolveEnvVars(entry, env)) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, T[keyof T]>).map(
        ([key, entry]) => [key, resolveEnvVars(entry, env)],
      ),
    ) as T;
  }
  return value;
}
