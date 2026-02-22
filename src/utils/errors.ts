export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getErrorMessage(
  error: unknown,
  fallback = 'Unknown error',
): string {
  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
}

export function getNestedApiErrorMessage(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const response = error.response;
  if (!isRecord(response)) {
    return undefined;
  }

  const data = response.data;
  if (!isRecord(data)) {
    return undefined;
  }

  const nestedError = data.error;
  if (isRecord(nestedError) && typeof nestedError.message === 'string') {
    return nestedError.message;
  }

  if (typeof data.message === 'string') {
    return data.message;
  }

  return undefined;
}
